// Schema access for the discovery evaluator. Evaluator contracts live in ../schemas/ and the
// canonical Argus contracts the evaluator reads (bug ledger, runner result) in argus/schemas/.
// Both are validated with the Argus runtime validator, so the supported keyword subset is the
// same one the packaged runtime enforces.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileJsonSchema } from '../../../../argus/runtime/json-schema.mjs';

export const evalSchemaDir = fileURLToPath(new URL('../schemas/', import.meta.url));
export const argusSchemaDir = fileURLToPath(new URL('../../../../argus/schemas/', import.meta.url));
const NAME = /^[a-z][a-z0-9-]*$/;
const cache = new Map();

function load(dir, name) {
  if (!NAME.test(name ?? '')) throw new Error(`invalid schema name: ${name}`);
  const path = join(dir, `${name}.schema.json`);
  if (!cache.has(path)) {
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    cache.set(path, { schema, validate: compileJsonSchema(schema) });
  }
  return cache.get(path);
}

// The parsed evaluator schema (for example 'comparison-config' or 'hunt-request').
export const evalSchema = name => load(evalSchemaDir, name).schema;

// Returns the validator errors ([] when valid) of a document against an evaluator schema.
export const validateEval = (name, value) => load(evalSchemaDir, name).validate(value);

// Returns the validator errors of a document against a canonical Argus schema (for example 'bug-ledger').
export const validateArgus = (name, value) => load(argusSchemaDir, name).validate(value);

export function formatSchemaErrors(errors, limit = 8) {
  const shown = errors.slice(0, limit).map(error => `${error.instancePath || '/'} ${error.message}`);
  if (errors.length > limit) shown.push(`... ${errors.length - limit} more`);
  return shown.join('; ');
}

// Throws a labelled error unless the document is valid against the evaluator schema.
export function assertEval(name, value, label = name) {
  const errors = validateEval(name, value);
  if (errors.length) throw new Error(`${label} violates ${name}: ${formatSchemaErrors(errors)}`);
  return value;
}
