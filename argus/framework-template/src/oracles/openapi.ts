import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArgusPrerequisiteError } from '../argus/errors';

// OpenAPI loading and normalization for the strict schema oracle.
//
// ADAPT-ME: point OPENAPI_PATH at the JSON spec Kalchas found (convert YAML first:
// npx js-yaml openapi.yaml > openapi.json), or save the live Swagger document at setup.
//
// normalize() turns an OpenAPI 3.x document into one JSON Schema 2020-12 view per
// direction. OpenAPI 3.0 keywords are converted (nullable, boolean exclusiveMinimum/
// exclusiveMaximum; example, xml, externalDocs, and deprecated are dropped). A response
// never documents writeOnly properties and a request never documents readOnly ones. Strict
// mode closes every use site with unevaluatedProperties:false, which, unlike
// additionalProperties:false, still accepts properties that allOf siblings declare.

export type OpenApiDocument = Record<string, unknown>;
export type Direction = 'response' | 'request';
export type NormalizeOptions = { direction: Direction; strict?: boolean };
export type OperationRef = { path: string; method: string; operation: Record<string, unknown> };

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as const;

type Json = Record<string, unknown>;
type RootKind = 'component' | 'use-site' | 'other';

const SINGLE_SUBSCHEMAS = ['not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'additionalItems', 'additionalProperties', 'items'];
const LIST_SUBSCHEMAS = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];
const MAP_SUBSCHEMAS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const LEGACY_DROPPED = ['example', 'xml', 'externalDocs', 'deprecated'];
const OPEN_OBJECT_KEYWORDS = ['additionalProperties', 'unevaluatedProperties', 'patternProperties'];

/** Read and parse the OpenAPI document (JSON). A missing file is a missing prerequisite. */
export function loadOpenApi(path: string = process.env.OPENAPI_PATH || './openapi.json'): OpenApiDocument {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new ArgusPrerequisiteError(`OpenAPI document not found; set OPENAPI_PATH (resolved to ${absolute})`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    throw new Error(`OpenAPI document ${absolute} is not JSON; convert YAML first (npx js-yaml openapi.yaml > openapi.json)`);
  }
  if (!isObject(doc) || typeof doc.openapi !== 'string' || !/^3\.\d+/.test(doc.openapi)) {
    throw new Error(`OpenAPI document ${absolute} is not an OpenAPI 3.x document`);
  }
  return doc;
}

/** A normalized deep copy; the input document is never mutated. Strict mode defaults on. */
export function normalize(doc: OpenApiDocument, options: NormalizeOptions): OpenApiDocument {
  if (options.direction !== 'response' && options.direction !== 'request') {
    throw new TypeError(`normalize: direction must be 'response' or 'request'`);
  }
  const legacy = typeof doc.openapi === 'string' && doc.openapi.startsWith('3.0');
  const hidden = options.direction === 'response' ? 'writeOnly' : 'readOnly';
  const converted = structuredClone(doc);
  mapSchemaRoots(converted, (schema) => convert(schema, { doc, legacy, hidden }));
  if (options.strict === false) return converted;
  const strict = structuredClone(converted);
  mapSchemaRoots(strict, (schema, kind) => {
    if (kind === 'component') return closeUseSites(schema, converted);
    if (kind === 'use-site') return strictUseSite(schema, converted);
    return schema;
  });
  return strict;
}

/**
 * Strict use site: {allOf:[S], unevaluatedProperties:false}, with S's own use sites closed
 * recursively. S stays open when, after shallow $ref/allOf resolution, it explicitly
 * declares additionalProperties, unevaluatedProperties, or patternProperties.
 */
export function strictUseSite(schema: unknown, doc: OpenApiDocument): unknown {
  if (!isObject(schema)) return schema;
  const inner = closeUseSites(schema, doc);
  return declaresOpenObject(schema, doc) ? inner : { allOf: [inner], unevaluatedProperties: false };
}

/** True when S, after shallow $ref/allOf resolution, declares how extra properties behave. */
export function declaresOpenObject(schema: unknown, doc: OpenApiDocument, seen = new Set<string>()): boolean {
  if (!isObject(schema)) return false;
  if (OPEN_OBJECT_KEYWORDS.some((keyword) => keyword in schema)) return true;
  if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
    seen.add(schema.$ref);
    if (declaresOpenObject(resolveRef(doc, schema.$ref), doc, seen)) return true;
  }
  return Array.isArray(schema.allOf) && schema.allOf.some((member) => declaresOpenObject(member, doc, seen));
}

/** Resolve a local reference such as #/components/schemas/Order; undefined when absent. */
export function resolveRef(doc: OpenApiDocument, ref: string): unknown {
  const segments = refSegments(ref);
  if (!segments) return undefined;
  let current: unknown = doc;
  for (const segment of segments) {
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)) current = current[Number(segment)];
    else if (isObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** A URI fragment JSON pointer for path segments, for example ['paths', '/a/{id}'] -> #/paths/~1a~1%7Bid%7D. */
export function toPointer(segments: string[]): string {
  return `#/${segments.map((segment) => encodeURIComponent(segment.replace(/~/g, '~0').replace(/\//g, '~1'))).join('/')}`;
}

/** Every operation in paths (and webhooks), in document order. */
export function listOperations(doc: OpenApiDocument): OperationRef[] {
  const found: OperationRef[] = [];
  for (const container of ['paths', 'webhooks']) {
    const items = doc[container];
    if (!isObject(items)) continue;
    for (const [path, item] of Object.entries(items)) {
      if (!isObject(item)) continue;
      for (const method of HTTP_METHODS) {
        const operation = item[method];
        if (isObject(operation)) found.push({ path: container === 'paths' ? path : `webhooks:${path}`, method, operation });
      }
    }
  }
  return found;
}

/** The single operation with this operationId; unknown or duplicate ids throw. */
export function findOperation(doc: OpenApiDocument, operationId: string): OperationRef {
  const matches = listOperations(doc).filter((entry) => entry.operation.operationId === operationId);
  if (matches.length === 0) throw new Error(`operationId ${JSON.stringify(operationId)} is not defined in the OpenAPI document`);
  if (matches.length > 1) throw new Error(`operationId ${JSON.stringify(operationId)} is defined more than once in the OpenAPI document`);
  return matches[0];
}

// --- Conversion ---------------------------------------------------------------------------

type ConvertContext = { doc: OpenApiDocument; legacy: boolean; hidden: 'readOnly' | 'writeOnly' };

function convert(node: unknown, ctx: ConvertContext): unknown {
  if (!isObject(node)) return node;
  let schema: Json = { ...node };
  forEachSubschema(schema, (child) => convert(child, ctx));
  if (isObject(node.properties) && isObject(schema.properties)) {
    const removed = Object.keys(node.properties).filter((name) => isHidden((node.properties as Json)[name], ctx));
    if (removed.length) {
      const properties: Json = { ...schema.properties };
      for (const name of removed) delete properties[name];
      schema.properties = properties;
      if (Array.isArray(schema.required)) {
        const required = schema.required.filter((name) => !removed.includes(name as string));
        if (required.length) schema.required = required;
        else delete schema.required;
      }
    }
  }
  if (!ctx.legacy) return schema;
  for (const keyword of LEGACY_DROPPED) delete schema[keyword];
  convertExclusive(schema, 'exclusiveMinimum', 'minimum');
  convertExclusive(schema, 'exclusiveMaximum', 'maximum');
  if ('nullable' in schema) {
    const nullable = schema.nullable === true;
    delete schema.nullable;
    if (nullable) schema = addNull(schema);
  }
  return schema;
}

function isHidden(property: unknown, ctx: ConvertContext): boolean {
  const seen = new Set<string>();
  let current = property;
  while (isObject(current)) {
    if (current[ctx.hidden] === true) return true;
    if (typeof current.$ref !== 'string' || seen.has(current.$ref)) return false;
    seen.add(current.$ref);
    current = resolveRef(ctx.doc, current.$ref);
  }
  return false;
}

function convertExclusive(schema: Json, exclusive: string, inclusive: string): void {
  if (typeof schema[exclusive] !== 'boolean') return;
  if (schema[exclusive] === true && typeof schema[inclusive] === 'number') {
    schema[exclusive] = schema[inclusive];
    delete schema[inclusive];
  } else {
    delete schema[exclusive];
  }
}

function addNull(schema: Json): Json {
  const typed = typeof schema.type === 'string' || Array.isArray(schema.type);
  if (typed || Array.isArray(schema.enum)) {
    const result: Json = { ...schema };
    if (typeof schema.type === 'string') result.type = schema.type === 'null' ? 'null' : [schema.type, 'null'];
    else if (Array.isArray(schema.type) && !schema.type.includes('null')) result.type = [...schema.type, 'null'];
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) result.enum = [...schema.enum, null];
    return result;
  }
  if (typeof schema.$ref === 'string' && !('anyOf' in schema)) {
    const { $ref, ...siblings } = schema;
    return { ...siblings, anyOf: [{ $ref }, { type: 'null' }] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

// --- Strict rewriting ---------------------------------------------------------------------

/** Close the use sites inside S without wrapping S itself (component roots, allOf members). */
function closeUseSites(node: unknown, doc: OpenApiDocument): unknown {
  if (!isObject(node)) return node;
  const schema: Json = { ...node };
  const useSite = (child: unknown) => strictUseSite(child, doc);
  const inner = (child: unknown) => closeUseSites(child, doc);
  if (isObject(schema.properties)) schema.properties = mapValues(schema.properties, useSite);
  if (isObject(schema.items)) schema.items = useSite(schema.items);
  else if (Array.isArray(schema.items)) schema.items = schema.items.map(useSite);
  if (Array.isArray(schema.prefixItems)) schema.prefixItems = schema.prefixItems.map(useSite);
  if (isObject(schema.additionalProperties)) schema.additionalProperties = useSite(schema.additionalProperties);
  for (const keyword of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[keyword])) schema[keyword] = (schema[keyword] as unknown[]).map(useSite);
  }
  if (Array.isArray(schema.allOf)) schema.allOf = schema.allOf.map(inner);
  for (const keyword of ['not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'additionalItems']) {
    if (isObject(schema[keyword])) schema[keyword] = inner(schema[keyword]);
  }
  for (const keyword of ['patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (isObject(schema[keyword])) schema[keyword] = mapValues(schema[keyword] as Json, inner);
  }
  return schema;
}

// --- Document traversal -------------------------------------------------------------------

function forEachSubschema(schema: Json, map: (child: unknown) => unknown): void {
  for (const keyword of SINGLE_SUBSCHEMAS) {
    if (isObject(schema[keyword])) schema[keyword] = map(schema[keyword]);
  }
  for (const keyword of LIST_SUBSCHEMAS) {
    if (Array.isArray(schema[keyword])) schema[keyword] = (schema[keyword] as unknown[]).map(map);
  }
  for (const keyword of MAP_SUBSCHEMAS) {
    if (isObject(schema[keyword])) schema[keyword] = mapValues(schema[keyword] as Json, map);
  }
}

/**
 * Apply `map` to every schema root: component schemas; request and response body schemas
 * (use sites); parameter and header schemas. Reference objects are skipped, because their
 * targets are visited where they are defined.
 */
function mapSchemaRoots(doc: Json, map: (schema: unknown, kind: RootKind) => unknown): void {
  const components = doc.components;
  if (isObject(components)) {
    if (isObject(components.schemas)) components.schemas = mapValues(components.schemas, (schema) => map(schema, 'component'));
    for (const response of objectValues(components.responses)) mapResponse(response, map);
    for (const body of objectValues(components.requestBodies)) mapContent(body.content, map, 'use-site');
    for (const parameter of objectValues(components.parameters)) mapParameter(parameter, map);
    for (const header of objectValues(components.headers)) mapParameter(header, map);
    for (const item of objectValues(components.pathItems)) mapPathItem(item, map);
    for (const callback of objectValues(components.callbacks)) for (const item of objectValues(callback)) mapPathItem(item, map);
  }
  for (const item of objectValues(doc.paths)) mapPathItem(item, map);
  for (const item of objectValues(doc.webhooks)) mapPathItem(item, map);
}

function mapPathItem(item: Json, map: (schema: unknown, kind: RootKind) => unknown): void {
  for (const parameter of arrayObjects(item.parameters)) mapParameter(parameter, map);
  for (const method of HTTP_METHODS) {
    const operation = item[method];
    if (!isObject(operation)) continue;
    for (const parameter of arrayObjects(operation.parameters)) mapParameter(parameter, map);
    if (isObject(operation.requestBody)) mapContent(operation.requestBody.content, map, 'use-site');
    for (const response of objectValues(operation.responses)) mapResponse(response, map);
    for (const callback of objectValues(operation.callbacks)) for (const nested of objectValues(callback)) mapPathItem(nested, map);
  }
}

function mapResponse(response: Json, map: (schema: unknown, kind: RootKind) => unknown): void {
  mapContent(response.content, map, 'use-site');
  for (const header of objectValues(response.headers)) mapParameter(header, map);
}

function mapParameter(parameter: Json, map: (schema: unknown, kind: RootKind) => unknown): void {
  if ('schema' in parameter) parameter.schema = map(parameter.schema, 'other');
  mapContent(parameter.content, map, 'other');
}

function mapContent(content: unknown, map: (schema: unknown, kind: RootKind) => unknown, kind: RootKind): void {
  for (const media of objectValues(content)) {
    if ('schema' in media) media.schema = map(media.schema, kind);
  }
}

// --- Helpers ------------------------------------------------------------------------------

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValues(value: unknown): Json[] {
  return isObject(value) ? Object.values(value).filter(isObject) : [];
}

function arrayObjects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function mapValues(map: Json, fn: (value: unknown) => unknown): Json {
  const result: Json = {};
  for (const [key, value] of Object.entries(map)) result[key] = fn(value);
  return result;
}

/** Segments of a local reference ('#' or '#/a/b'); percent-decoded, then ~1 and ~0. */
export function refSegments(ref: string): string[] | undefined {
  if (ref === '#') return [];
  if (!ref.startsWith('#/')) return undefined;
  try {
    return ref.slice(2).split('/').map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'));
  } catch {
    return undefined;
  }
}
