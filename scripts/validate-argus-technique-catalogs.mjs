#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TECHNIQUE_CATALOG_SCHEMA,
  validateTechniqueCatalog,
  validateTechniqueCatalogSet,
} from '../argus/runtime/technique-catalogs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGS = join(ROOT, 'argus', 'technique-catalogs');
const SCHEMA_PATH = join(ROOT, 'argus', 'schemas', 'technique-catalog.schema.json');
const FIXTURES_PATH = join(ROOT, 'scripts', 'fixtures', 'argus-technique-catalogs', 'mutations.json');
const roles = ['atalanta', 'proteus', 'metis'];
const documents = new Map(roles.map((role) => [role, readJson(join(CATALOGS, `${role}.json`))]));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(readJson(SCHEMA_PATH));

for (const [role, document] of documents) {
  assert(document.$schema === TECHNIQUE_CATALOG_SCHEMA, `${role}: schema identifier drifted`);
  assert(validateSchema(document), `${role}: JSON Schema rejected canonical catalog: ${ajv.errorsText(validateSchema.errors)}`);
  const runtimeErrors = validateTechniqueCatalog(document);
  assert(runtimeErrors.length === 0, `${role}: runtime validator rejected canonical catalog: ${runtimeErrors.join('; ')}`);
}

const setErrors = validateTechniqueCatalogSet([...documents.values()]);
assert(setErrors.length === 0, `canonical catalog set is invalid: ${setErrors.join('; ')}`);

const fixtures = readJson(FIXTURES_PATH);
assert(fixtures.schemaVersion === 1 && Array.isArray(fixtures.cases), 'mutation fixture envelope is invalid');
const fixtureNames = new Set();
for (const fixture of fixtures.cases) {
  assert(!fixtureNames.has(fixture.name), `duplicate fixture name: ${fixture.name}`);
  fixtureNames.add(fixture.name);
  const source = documents.get(fixture.catalog);
  assert(source, `${fixture.name}: unknown fixture catalog ${fixture.catalog}`);
  const mutated = structuredClone(source);
  applyMutation(mutated, fixture);

  const schemaAccepted = validateSchema(mutated);
  const runtimeErrors = validateTechniqueCatalog(mutated);
  assert(fixture.rejects.includes('schema') === !schemaAccepted,
    `${fixture.name}: JSON Schema rejection mismatch (${ajv.errorsText(validateSchema.errors)})`);
  assert(fixture.rejects.includes('runtime') === (runtimeErrors.length > 0),
    `${fixture.name}: runtime rejection mismatch (${runtimeErrors.join('; ')})`);
  if (fixture.runtimeIncludes) {
    assert(runtimeErrors.some((error) => error.includes(fixture.runtimeIncludes)),
      `${fixture.name}: runtime error lacks ${JSON.stringify(fixture.runtimeIncludes)} (${runtimeErrors.join('; ')})`);
  }
}

const missingSetErrors = validateTechniqueCatalogSet([...documents.values()].slice(0, 2));
assert(missingSetErrors.some((error) => error.includes('exactly 3 catalogs')), 'catalog set accepted a missing role');
assert(missingSetErrors.some((error) => error.includes('missing metis')), 'catalog set did not name the missing role');
const duplicateSetErrors = validateTechniqueCatalogSet([
  documents.get('atalanta'), documents.get('atalanta'), documents.get('metis'),
]);
assert(duplicateSetErrors.some((error) => error.includes('duplicates atalanta')), 'catalog set accepted a duplicate role');
assert(duplicateSetErrors.some((error) => error.includes('missing proteus')), 'catalog set did not name the displaced role');

const runtimeSource = readFileSync(join(ROOT, 'argus', 'runtime', 'technique-catalogs.mjs'), 'utf8');
for (const forbidden of ['readFileSync', 'readFile(', 'technique-catalogs/atalanta.json']) {
  assert(!runtimeSource.includes(forbidden), `runtime validator performs or embeds a catalog read: ${forbidden}`);
}

console.log(
  `PASS  Argus technique catalogs: ${documents.get('atalanta').entries.length} Atalanta, ` +
  `${documents.get('proteus').entries.length} Proteus, ` +
  `${documents.get('metis').iso25010.length} ISO 25010, ` +
  `${documents.get('metis').journeyClasses.length} journeys, ` +
  `${documents.get('metis').archetypes.length} archetypes, ${fixtures.cases.length} negative fixtures`,
);

function applyMutation(document, fixture) {
  assert(['add', 'remove', 'replace'].includes(fixture.operation), `${fixture.name}: unsupported mutation`);
  const parts = fixture.pointer.split('/').slice(1).map(unescapePointer);
  assert(parts.length > 0, `${fixture.name}: mutation pointer must not target the root`);
  let parent = document;
  for (const part of parts.slice(0, -1)) {
    assert(parent !== null && typeof parent === 'object' && Object.hasOwn(parent, part),
      `${fixture.name}: pointer segment does not exist: ${part}`);
    parent = parent[part];
  }
  const key = parts.at(-1);
  if (fixture.operation === 'remove') {
    assert(Object.hasOwn(parent, key), `${fixture.name}: remove target does not exist`);
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
    return;
  }
  if (fixture.operation === 'replace') assert(Object.hasOwn(parent, key), `${fixture.name}: replace target does not exist`);
  parent[key] = structuredClone(fixture.value);
}

function unescapePointer(value) {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`cannot parse ${path}: ${error.message}`); }
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
