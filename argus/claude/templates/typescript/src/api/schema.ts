import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { expect } from '@playwright/test';
import * as fs from 'fs';

// Contract testing mechanised: validate live responses against the OpenAPI schema
// instead of hand-rolled per-field assertions. The spec IS the oracle — every
// mismatch this surfaces is a contract-drift bug candidate for Atalanta.
//
// ADAPT-ME: point OPENAPI_PATH at the spec file Kalchas found (JSON; convert YAML
// first: npx js-yaml openapi.yaml > openapi.json), or fetch it from the live
// Swagger endpoint at setup and save it locally.

const OPENAPI_PATH = process.env.OPENAPI_PATH ?? './openapi.json';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let doc: Record<string, unknown> | null = null;
const validators = new Map<string, ValidateFunction>();

function loadDoc(): Record<string, unknown> {
  if (!doc) {
    doc = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf-8'));
    // Register the whole document so $ref pointers (#/components/schemas/X) resolve.
    ajv.addSchema(doc as object, 'openapi');
  }
  return doc!;
}

/** Assert `body` conforms to a schema in the OpenAPI doc.
 *  Usage: expectMatchesSchema(await res.json(), '#/components/schemas/Order') */
export function expectMatchesSchema(body: unknown, ref: string): void {
  loadDoc();
  let validate = validators.get(ref);
  if (!validate) {
    validate = ajv.compile({ $ref: `openapi${ref}` });
    validators.set(ref, validate);
  }
  const valid = validate(body);
  expect(
    valid,
    `response does not match ${ref}:\n${ajv.errorsText(validate.errors, { separator: '\n' })}\nbody: ${JSON.stringify(body).slice(0, 500)}`,
  ).toBe(true);
}
