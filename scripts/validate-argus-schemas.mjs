#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_KINDS, validateCanonicalDocument } from '../argus/runtime/contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = join(ROOT, 'argus', 'schemas');
const schemaFiles = readdirSync(SCHEMAS).filter((name) => name.endsWith('.schema.json')).sort();
const schemas = new Map(schemaFiles.map((name) => [name, readJson(join(SCHEMAS, name))]));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const validators = new Map();

for (const schema of schemas.values()) ajv.addSchema(schema);
for (const [name, schema] of schemas) {
  const validate = ajv.compile(schema);
  assert(!validate({}), `${name}: representative empty invalid fixture unexpectedly passed`);
  validators.set(name, validate);
}

const documents = walk(join(ROOT, 'argus'))
  .filter((path) => path.endsWith('.json'))
  .filter((path) => !path.includes('/node_modules/'))
  .filter((path) => !path.includes('/argus/claude/'))
  .filter((path) => !path.includes('/argus/schemas/'));
let validatedDocuments = 0;
const coveredSchemas = new Set();
for (const path of documents) {
  const document = readJson(path);
  if (typeof document.$schema !== 'string') continue;
  const schemaName = declaredSchemaName(document.$schema);
  if (!schemaName) continue;
  const schema = schemas.get(schemaName);
  assert(schema, `${path}: declared schema is not canonical: ${document.$schema}`);
  const validate = validators.get(schemaName);
  assert(validate(document), `${path}: ${schemaName} rejected document: ${ajv.errorsText(validate.errors)}`);
  validatedDocuments += 1;
  coveredSchemas.add(schemaName);
}

const fixtures = join(ROOT, 'scripts', 'fixtures', 'argus-schemas');
let differentialFixtures = 0;
for (const kind of CONTRACT_KINDS) {
  const schemaName = `${kind}.schema.json`;
  const validate = validators.get(schemaName);
  assert(validate, `${kind}: canonical JSON Schema is missing`);

  const validPath = join(fixtures, 'valid', `${kind}.json`);
  const validDocument = readJson(validPath);
  const ajvAccepted = validate(validDocument);
  const runtimeErrors = validateCanonicalDocument(kind, validDocument);
  assert(ajvAccepted, `${validPath}: canonical JSON Schema rejected valid fixture: ${ajv.errorsText(validate.errors)}`);
  assert(runtimeErrors.length === 0, `${validPath}: packaged runtime rejected valid fixture: ${runtimeErrors.join('; ')}`);
  differentialFixtures += 1;

  const invalidNames = readdirSync(join(fixtures, 'invalid'))
    .filter((name) => name === `${kind}.json` || name.startsWith(`${kind}-`))
    .sort();
  assert(invalidNames.length > 0, `${kind}: no invalid differential fixture exists`);
  for (const name of invalidNames) {
    const path = join(fixtures, 'invalid', name);
    const document = readJson(path);
    const schemaAccepted = validate(document);
    const errors = validateCanonicalDocument(kind, document);
    assert(!schemaAccepted, `${path}: canonical JSON Schema unexpectedly accepted invalid fixture`);
    assert(errors.length > 0, `${path}: packaged runtime unexpectedly accepted invalid fixture`);
    differentialFixtures += 1;
  }
}

assert(validatedDocuments >= 10, `only ${validatedDocuments} schema-declaring canonical documents were validated`);
console.log(`PASS  Canonical JSON Schemas: ${schemaFiles.length} compiled, ${differentialFixtures} runtime/Ajv differential fixtures aligned, ${validatedDocuments} source documents validated across ${coveredSchemas.size} schemas`);

function declaredSchemaName(value) {
  if (value === 'https://json-schema.org/draft/2020-12/schema') return null;
  const contract = value.match(/^argus\/([a-z0-9-]+)@[0-9]+$/);
  if (contract) return `${contract[1]}.schema.json`;
  const name = basename(value);
  return name.endsWith('.schema.json') ? name : null;
}

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) output.push(...walk(path));
    else if (stats.isFile()) output.push(path);
  }
  return output;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`invalid JSON ${path}: ${error.message}`);
  }
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
