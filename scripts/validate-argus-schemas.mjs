#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = join(ROOT, 'argus', 'schemas');
const schemaFiles = readdirSync(SCHEMAS).filter((name) => name.endsWith('.schema.json')).sort();
const schemas = new Map(schemaFiles.map((name) => [name, readJson(join(SCHEMAS, name))]));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);

for (const schema of schemas.values()) ajv.addSchema(schema);
for (const [name, schema] of schemas) {
  const validate = ajv.compile(schema);
  assert(!validate({}), `${name}: representative empty invalid fixture unexpectedly passed`);
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
  const validate = ajv.compile(schema);
  assert(validate(document), `${path}: ${schemaName} rejected document: ${ajv.errorsText(validate.errors)}`);
  validatedDocuments += 1;
  coveredSchemas.add(schemaName);
}

assert(validatedDocuments >= 10, `only ${validatedDocuments} schema-declaring canonical documents were validated`);
console.log(`PASS  Canonical JSON Schemas: ${schemaFiles.length} compiled, ${schemaFiles.length} invalid fixtures rejected, ${validatedDocuments} source documents validated across ${coveredSchemas.size} schemas`);

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
