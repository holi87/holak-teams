import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { expect } from '@playwright/test';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { declaresOpenObject, Direction, findOperation, loadOpenApi, normalize, OpenApiDocument, refSegments, resolveRef, toPointer } from './openapi';
import { describeResult, HttpResult, readResult, redactedExcerpt } from './http';

// Contract testing mechanised: validate live responses against the OpenAPI schema instead
// of hand-rolled per-field assertions. The spec IS the oracle; every mismatch is a
// contract-drift bug candidate. Strict mode is the default: an undocumented field is RED.
// Opting out needs a written reason, which stays visible in the test source.
//
// ADAPT-ME: OPENAPI_PATH (default ./openapi.json) names the JSON spec; see openapi.ts.

export type SchemaOptions = {
  /** Default true. false requires a non-empty `reason`. */
  strict?: boolean;
  reason?: string;
  /** assertSchemaRef only; default 'response'. */
  direction?: Direction;
};

type Variant = { doc: OpenApiDocument; ajv: Ajv2020; validators: Map<string, ValidateFunction> };

const DOC_ID = 'argus-openapi';
const MAX_LISTED_ERRORS = 20;
let loaded: { path: string; stamp: string; variants: Map<string, Variant> } | undefined;

/**
 * Validate a response against responses[key].content['application/json'].schema of the
 * operation, where the key is the exact status, else its NXX range, else `default` (OpenAPI
 * 3.x); failure messages name a range or default key. A status none of them covers is RED;
 * a status documented without content requires an empty body. Accepts a Playwright
 * response or a plain {status, body} record.
 */
export async function assertSchema(res: HttpResult, operationId: string, options: SchemaOptions = {}): Promise<void> {
  const strict = strictness(options);
  const variant = variantFor('response', strict);
  const { path, method, operation } = findOperation(variant.doc, operationId);
  const snapshot = await readResult(res);
  const responses = isObject(operation.responses) ? operation.responses : {};
  const documented = Object.keys(responses);
  const key = responseKey(responses, snapshot.status);
  expect(
    key !== undefined,
    `${operationId}: HTTP ${snapshot.status} is not documented (documented: ${documented.join(', ') || 'none'}): ${describeResult(snapshot)}`,
  ).toBe(true);
  if (key === undefined) return;
  const where = key === String(snapshot.status) ? `HTTP ${key}` : `HTTP ${snapshot.status} via ${key}`;
  let pointer = path.startsWith('webhooks:')
    ? ['webhooks', path.slice('webhooks:'.length), method, 'responses', key]
    : ['paths', path, method, 'responses', key];
  let response = responses[key];
  // A documented response may be a reference to components.responses (possibly chained).
  for (let hops = 0; isObject(response) && typeof response.$ref === 'string'; hops += 1) {
    const segments = refSegments(response.$ref);
    if (!segments || hops > 10) throw new Error(`${operationId}: ${where} response reference ${response.$ref} cannot be resolved`);
    pointer = segments;
    response = resolveRef(variant.doc, response.$ref);
  }
  if (!isObject(response)) throw new Error(`${operationId}: ${where} response is not a response object`);
  const content = isObject(response.content) ? response.content : {};
  const mediaTypes = Object.keys(content);
  const mediaType = mediaTypes.find((name) => name === 'application/json')
    ?? mediaTypes.find((name) => /^application\/([\w.+-]+\+)?json\s*(;.*)?$/i.test(name));
  if (mediaTypes.length === 0) {
    expect(snapshot.empty, `${operationId}: ${where} documents no content, but the body is not empty: ${describeResult(snapshot)}`).toBe(true);
    return;
  }
  if (!mediaType) throw new Error(`${operationId}: ${where} documents no JSON media type (${mediaTypes.join(', ')}); assertSchema validates JSON bodies only`);
  const media = content[mediaType];
  if (!isObject(media) || !('schema' in media)) return;
  const ref = toPointer([...pointer, 'content', mediaType, 'schema']);
  const validate = compile(variant, `op:${ref}`, { $ref: `${DOC_ID}${ref}` });
  check(validate, snapshot.body, `${operationId} ${where} (${mediaType})`);
}

/** Validate a body against a schema by reference, for example '#/components/schemas/Order'. */
export async function assertSchemaRef(body: unknown, ref: string, options: SchemaOptions = {}): Promise<void> {
  const strict = strictness(options);
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new TypeError(`schema reference must be a local JSON pointer such as '#/components/schemas/X', got ${JSON.stringify(ref)}`);
  const variant = variantFor(options.direction ?? 'response', strict);
  if (resolveRef(variant.doc, ref) === undefined) throw new Error(`schema ${ref} is not defined in the OpenAPI document`);
  const inner = { $ref: `${DOC_ID}${ref}` };
  // The validated body is a use site, so strict mode closes it like any other.
  const root = strict && !declaresOpenObject({ $ref: ref }, variant.doc) ? { allOf: [inner], unevaluatedProperties: false } : inner;
  const validate = compile(variant, `ref:${ref}`, root);
  check(validate, body, ref);
}

/** assertSchemaRef with strict mode forced. */
export async function assertSchemaStrict(body: unknown, ref: string): Promise<void> {
  await assertSchemaRef(body, ref, { strict: true });
}

/** Strict alias of assertSchemaRef, kept for existing specs: await expectMatchesSchema(body, ref). */
export async function expectMatchesSchema(body: unknown, ref: string): Promise<void> {
  await assertSchemaRef(body, ref);
}

/** The responses key documenting `status`: the exact code, else 1XX..5XX, else `default`. */
function responseKey(responses: Record<string, unknown>, status: number): string | undefined {
  const range = status >= 100 && status <= 599 ? `${Math.floor(status / 100)}XX` : undefined;
  return [String(status), range, 'default'].find((key) => key !== undefined && Object.prototype.hasOwnProperty.call(responses, key));
}

function strictness(options: SchemaOptions): boolean {
  if (options.strict !== false) return true;
  if (typeof options.reason !== 'string' || options.reason.trim() === '') {
    throw new TypeError('strict:false needs a non-empty reason naming why undocumented fields are acceptable here');
  }
  return false;
}

function variantFor(direction: Direction, strict: boolean): Variant {
  const path = resolve(process.env.OPENAPI_PATH || './openapi.json');
  let stamp = 'missing';
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // loadOpenApi reports the missing prerequisite below.
  }
  if (!loaded || loaded.path !== path || loaded.stamp !== stamp) loaded = { path, stamp, variants: new Map() };
  const key = `${direction}:${strict}`;
  let variant = loaded.variants.get(key);
  if (!variant) {
    const doc = normalize(loadOpenApi(path), { direction, strict });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(doc, DOC_ID);
    variant = { doc, ajv, validators: new Map() };
    loaded.variants.set(key, variant);
  }
  return variant;
}

function compile(variant: Variant, key: string, schema: object): ValidateFunction {
  let validate = variant.validators.get(key);
  if (!validate) {
    validate = variant.ajv.compile(schema);
    variant.validators.set(key, validate);
  }
  return validate;
}

function check(validate: ValidateFunction, body: unknown, label: string): void {
  const valid = validate(body) === true;
  const message = valid ? label : `${label}: body does not match the schema\n${formatErrors(validate.errors ?? [])}\nbody: ${redactedExcerpt(body)}`;
  expect(valid, message).toBe(true);
}

function formatErrors(errors: ErrorObject[]): string {
  const lines = errors.slice(0, MAX_LISTED_ERRORS).map((error) => {
    const where = error.instancePath || '(root)';
    const detail = Object.keys(error.params ?? {}).length ? ` ${JSON.stringify(error.params)}` : '';
    return `- ${where} ${error.message ?? error.keyword}${detail}`;
  });
  if (errors.length > MAX_LISTED_ERRORS) lines.push(`- … ${errors.length - MAX_LISTED_ERRORS} more`);
  return lines.join('\n');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
