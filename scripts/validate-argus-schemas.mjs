#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_KINDS, mergeCanonicalDocuments, migrateCanonicalDocument, schemaId, validateCanonicalDocument } from '../argus/runtime/contracts.mjs';
import { compileJsonSchema } from '../argus/runtime/json-schema.mjs';

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
const compatibility = readJson(join(ROOT, 'argus', 'policies', 'schema-compatibility.json'));
let differentialFixtures = 0;
let semanticFixtures = 0;
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

  const semanticNames = readdirSync(join(fixtures, 'semantic-invalid'))
    .filter((name) => name.startsWith(`${kind}-`))
    .sort();
  for (const name of semanticNames) {
    const path = join(fixtures, 'semantic-invalid', name);
    const document = readJson(path);
    assert(validate(document), `${path}: fixture must isolate a semantic rule: ${ajv.errorsText(validate.errors)}`);
    const errors = validateCanonicalDocument(kind, document);
    assert(errors.length > 0, `${path}: packaged runtime unexpectedly accepted semantic-invalid fixture`);
    semanticFixtures += 1;
  }
}

assert(validatedDocuments >= 10, `only ${validatedDocuments} schema-declaring canonical documents were validated`);
assert(semanticFixtures >= 4, `only ${semanticFixtures} semantic-only fixtures were validated`);
for (const [kind, field, key] of [
  ['lane-plan', 'lanes', 'lane'],
  ['evidence-reference', 'references', 'id'],
  ['automation-status', 'tests', 'testId'],
  ['coverage-observations', 'observations', 'observationId'],
]) {
  const document = readJson(join(fixtures, 'valid', `${kind}.json`));
  const fragments = [...document[field]].reverse().map((record) => ({ ...document, [field]: [record] }));
  const merged = mergeCanonicalDocuments(kind, fragments);
  assert(merged[field].every((record, index) => index === 0 || merged[field][index - 1][key] < record[key]), `${kind}: merge output is not deterministic by ${key}`);
  let duplicateRejected = false;
  try { mergeCanonicalDocuments(kind, [fragments[0], fragments[0]]); }
  catch { duplicateRejected = true; }
  assert(duplicateRejected, `${kind}: merge accepted duplicate ${key} values across fragments`);

  // Each collection reads only its current version; the immediately retired one fails closed.
  const policy = compatibility.contracts?.[kind];
  const current = policy?.current;
  assert(Number.isInteger(current) && current >= 2 && document.schemaVersion === current && document.$schema === schemaId(kind, current), `${kind}: valid fixture is not the current policy version`);
  assert(JSON.stringify(policy.readCompatible) === `[${current}]` && !Object.hasOwn(policy, 'migration'), `${kind}: compatibility policy still accepts a retired version`);
  const retired = { ...document, $schema: `argus/${kind}@${current - 1}`, schemaVersion: current - 1 };
  assert(validateCanonicalDocument(kind, retired).length > 0, `${kind}: runtime reader still accepts retired v${current - 1} input`);
}
// Owned collection records are superseded by write sequence, never by fragment order; a record
// belongs to its lane (or is written by the canonical owner), and a key never changes owner.
{
  const document = readJson(join(fixtures, 'valid', 'coverage-observations.json'));
  const record = document.observations[0];
  const first = { ...document, observations: [record] };
  const later = { ...document, observations: [{ ...record, evidenceIds: ['EVD-0002', 'EVD-0003'] }] };
  const owners = { 'coverage-observations': 'kleio', 'automation-status': 'atlas', 'evidence-reference': 'kleio' };
  const merge = (docs, writers, kind = 'coverage-observations') => mergeCanonicalDocuments(kind, docs, { writers, canonicalOwner: owners[kind] });
  const superseded = merge([later, first], [{ lane: record.lane, sequence: 7 }, { lane: record.lane, sequence: 3 }]);
  assert(superseded.observations.length === 1 && superseded.observations[0].evidenceIds.length === 2, 'owned collection merge did not keep the record with the highest write sequence');
  assert(merge([first], [{ lane: 'kleio', sequence: 1 }]).observations.length === 1, 'the canonical owner could not write an owned collection record');
  const refusal = (fn) => { try { fn(); return ''; } catch (error) { return error.message; } };
  assert(refusal(() => merge([first], [{ lane: 'talos', sequence: 1 }])).includes('talos may write only its own records'), 'a foreign lane wrote an owned collection record');
  assert(refusal(() => merge([first, later], [{ lane: record.lane, sequence: 2 }, { lane: record.lane, sequence: 2 }])).includes('appears twice at write sequence 2'), 'an owned collection merge accepted two records at one write sequence');
  const tests = readJson(join(fixtures, 'valid', 'automation-status.json'));
  const row = tests.tests[0];
  const reassigned = { ...tests, tests: [{ ...row, owner: 'daidalos' }] };
  assert(refusal(() => merge([{ ...tests, tests: [row] }, reassigned], [{ lane: row.owner, sequence: 1 }, { lane: 'atlas', sequence: 2 }], 'automation-status')).includes(`belongs to ${row.owner}, not daidalos`), 'an owned collection key changed owner');
  const evidence = readJson(join(fixtures, 'valid', 'evidence-reference.json'));
  const single = { ...evidence, references: [evidence.references[0]] };
  assert(refusal(() => merge([single, single], [{ lane: 'atalanta', sequence: 1 }, { lane: 'atalanta', sequence: 2 }], 'evidence-reference')).includes('duplicate'), 'an immutable collection record was superseded');
}
const preflightV3Schema = schemas.get('preflight-report.schema.json');
assert(preflightV3Schema?.properties?.schemaVersion?.const === 3, 'current preflight-report validator does not require schemaVersion 3');
assert(['$schema', 'modelRuntime', 'orchestration', 'residualRisks'].every((field) => preflightV3Schema.required.includes(field))
  && preflightV3Schema.properties.summary.required.includes('downgraded')
  && preflightV3Schema.properties.agents.items.required.includes('stopsEngagement'), 'preflight-report v3 validator does not require its identity, residual risks, and essential-lane fields');
const preflightPolicy = compatibility.contracts?.['preflight-report'];
assert(preflightPolicy?.current === 3 && JSON.stringify(preflightPolicy.readCompatible) === '[3]' && !Object.hasOwn(preflightPolicy, 'migration'), 'preflight-report still declares a retired reader');
const validateDateTime = compileJsonSchema({ type: 'string', format: 'date-time' });
for (const value of ['2026-01-01T23:59:59Z', '1990-12-31T15:59:60-08:00']) assert(validateDateTime(value).length === 0, `valid RFC3339 date-time rejected: ${value}`);
for (const value of ['2026-01-01T24:59:59+01:00', '2026-01-01T23:60:59+00:01', '2026-01-01T12:00:60Z']) assert(validateDateTime(value).length > 0, `invalid RFC3339 date-time accepted: ${value}`);
const leapSecondLane = readJson(join(fixtures, 'valid', 'lane-plan.json'));
leapSecondLane.lanes = [{
  ...leapSecondLane.lanes[0],
  transitions: [
    { to: 'planned', at: '1990-12-31T15:59:59-08:00', by: 'odysseus' },
    { to: 'running', at: '1990-12-31T15:59:60-08:00', by: 'kalchas' },
    { to: 'completed', at: '1991-01-01T00:00:00Z', by: 'kalchas' },
  ],
}];
assert(validateCanonicalDocument('lane-plan', leapSecondLane).length === 0, 'lane-plan rejected a strictly increasing sequence across an RFC3339 leap second');
console.log(`PASS  Canonical JSON Schemas: ${schemaFiles.length} compiled, ${differentialFixtures} differential + ${semanticFixtures} current semantic-only fixtures, retired collection readers rejected, ${validatedDocuments} source documents validated across ${coveredSchemas.size} schemas`);

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
