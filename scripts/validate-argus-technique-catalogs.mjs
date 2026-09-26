#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TECHNIQUE_CATALOG_SCHEMA,
  techniqueCatalogId,
  validateTechniqueCatalog,
  validateTechniqueCatalogContracts,
  validateTechniqueCatalogSet,
} from '../argus/runtime/technique-catalogs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGS = join(ROOT, 'argus', 'technique-catalogs');
const SCHEMA_PATH = join(ROOT, 'argus', 'schemas', 'technique-catalog.schema.json');
const MATRIX_PATH = join(ROOT, 'argus', 'capabilities', 'capability-matrix.json');
const MATRIX_SCHEMA_PATH = join(ROOT, 'argus', 'schemas', 'capability-matrix.schema.json');
const FIXTURES_PATH = join(ROOT, 'scripts', 'fixtures', 'argus-technique-catalogs', 'mutations.json');

// The capability matrix is the only catalog registry. Its techniqueCatalogs declarations
// are passed verbatim to the runtime validator as the per-role contracts.
const matrix = readJson(MATRIX_PATH);
const contracts = matrix.techniqueCatalogs;
const contractErrors = validateTechniqueCatalogContracts(contracts);
assert(contractErrors.length === 0, `capability matrix technique catalog registry is invalid: ${contractErrors.join('; ')}`);
const roles = Object.keys(contracts);
assert(roles.length >= 2, 'the catalog set regression needs at least two registered catalogs');
const catalogFiles = readdirSync(CATALOGS).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
assert(equalSets(catalogFiles, roles),
  `catalog files (${catalogFiles.sort().join(', ')}) differ from registered roles (${[...roles].sort().join(', ')})`);
const documents = new Map(roles.map((role) => [role, readJson(join(CATALOGS, `${role}.json`))]));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(readJson(SCHEMA_PATH));
const matrixAjv = new Ajv2020({ allErrors: true, strict: false });
const validateMatrixSchema = matrixAjv.compile(readJson(MATRIX_SCHEMA_PATH));
assert(validateMatrixSchema(matrix), `capability matrix JSON Schema rejected the registry: ${matrixAjv.errorsText(validateMatrixSchema.errors)}`);

for (const [role, document] of documents) {
  assert(document.$schema === TECHNIQUE_CATALOG_SCHEMA, `${role}: schema identifier drifted`);
  assert(validateSchema(document), `${role}: JSON Schema rejected canonical catalog: ${ajv.errorsText(validateSchema.errors)}`);
  const runtimeErrors = validateTechniqueCatalog(document, contracts);
  assert(runtimeErrors.length === 0, `${role}: runtime validator rejected canonical catalog: ${runtimeErrors.join('; ')}`);
}

const setErrors = validateTechniqueCatalogSet([...documents.values()], contracts);
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
  const runtimeErrors = validateTechniqueCatalog(mutated, contracts);
  assert(fixture.rejects.includes('schema') === !schemaAccepted,
    `${fixture.name}: JSON Schema rejection mismatch (${ajv.errorsText(validateSchema.errors)})`);
  assert(fixture.rejects.includes('runtime') === (runtimeErrors.length > 0),
    `${fixture.name}: runtime rejection mismatch (${runtimeErrors.join('; ')})`);
  if (fixture.runtimeIncludes) {
    assert(runtimeErrors.some((error) => error.includes(fixture.runtimeIncludes)),
      `${fixture.name}: runtime error lacks ${JSON.stringify(fixture.runtimeIncludes)} (${runtimeErrors.join('; ')})`);
  }
}

// Set completeness follows whatever roles the matrix registers.
const [firstRole, secondRole] = roles;
const missingSetErrors = validateTechniqueCatalogSet(roles.slice(0, -2).map((role) => documents.get(role)), contracts);
assert(missingSetErrors.some((error) => error.includes(`exactly ${roles.length} catalogs`)), 'catalog set accepted a missing role');
for (const role of roles.slice(-2)) {
  assert(missingSetErrors.some((error) => error.includes(`missing ${role} catalog`)), `catalog set did not name the missing ${role} role`);
}
const duplicateSetErrors = validateTechniqueCatalogSet([
  documents.get(firstRole), documents.get(firstRole), ...roles.slice(2).map((role) => documents.get(role)),
], contracts);
assert(duplicateSetErrors.some((error) => error.includes(`duplicates ${firstRole}`)), 'catalog set accepted a duplicate role');
assert(duplicateSetErrors.some((error) => error.includes(`missing ${secondRole} catalog`)), 'catalog set did not name the displaced role');

// A missing or malformed registry fails closed instead of letting any catalog pass.
const hunterRole = roles.find((role) => contracts[role].catalogType === 'hunter');
const strategyRole = roles.find((role) => contracts[role].catalogType === 'strategy');
assert(hunterRole && strategyRole, 'the registry regression needs one hunter and one strategy catalog');
const hunterContract = contracts[hunterRole];
assert(validateTechniqueCatalog(documents.get(hunterRole)).some((error) => error.includes('contracts must be')),
  'a catalog validated without a registry');
const registryMutations = [
  ['empty registry', () => ({}), 'at least one technique catalog'],
  ['hunter without idPrefix', () => ({ ...contracts, [hunterRole]: omit(hunterContract, 'idPrefix') }), 'idPrefix must be three uppercase letters'],
  ['hunter without entryCount', () => ({ ...contracts, [hunterRole]: omit(hunterContract, 'entryCount') }), 'entryCount must be an integer'],
  ['strategy with entryCount', () => ({ ...contracts, [strategyRole]: { ...contracts[strategyRole], entryCount: 1 } }), 'entryCount is not allowed for strategy'],
  ['foreign catalogId', () => ({ ...contracts, [hunterRole]: { ...hunterContract, catalogId: techniqueCatalogId(strategyRole) } }), `contracts/${hunterRole}/catalogId must equal`],
  ['unknown catalogType', () => ({ ...contracts, [hunterRole]: { ...hunterContract, catalogType: 'scanner' } }), 'catalogType must be hunter or strategy'],
  ['shared idPrefix', () => ({ ...contracts, 'prefix-clash': { ...hunterContract, catalogId: techniqueCatalogId('prefix-clash') } }), `duplicates the ${hunterRole} prefix`],
];
for (const [label, registry, expected] of registryMutations) {
  const errors = validateTechniqueCatalogSet([...documents.values()], registry());
  assert(errors.some((error) => error.includes(expected)), `registry mutation was accepted: ${label} (${errors.join('; ')})`);
}
const driftedCount = hunterContract.entryCount + 1;
const countDriftErrors = validateTechniqueCatalog(documents.get(hunterRole), {
  ...contracts, [hunterRole]: { ...hunterContract, entryCount: driftedCount },
});
assert(countDriftErrors.some((error) => error.includes(`exactly ${driftedCount} entries`)), 'registry entryCount is not enforced');

// Registration proof: a hypothetical role needs only a matrix declaration plus its catalog
// JSON. No role list in code changes, and the data-direct route is accepted.
const probeRole = 'registration-probe';
const probeCatalog = {
  $schema: TECHNIQUE_CATALOG_SCHEMA,
  schemaVersion: 1,
  catalogId: techniqueCatalogId(probeRole),
  role: probeRole,
  catalogType: 'hunter',
  valuePolicy: 'discover-never-assume',
  executionRule: 'each-applicable-entry-covered-or-gap',
  absentSurfaceDisposition: 'not-applicable-with-evidence',
  entries: ['api', 'data-direct'].map((route, index) => ({
    id: `ZZZ-T${String(index + 1).padStart(2, '0')}`,
    title: `Registration probe via ${route}`,
    scope: [`probe-${route}`],
    techniques: ['equivalence-partitioning'],
    appliesWhen: 'surface-present',
    construct: [`Construct one probe request through the ${route} route.`],
    oracles: ['The documented probe invariant holds after the request.'],
    routes: [route],
  })),
};
const probeContracts = {
  ...contracts,
  [probeRole]: {
    catalogId: techniqueCatalogId(probeRole),
    catalogType: 'hunter',
    idPrefix: 'ZZZ',
    entryCount: probeCatalog.entries.length,
    sha256: createHash('sha256').update(`${JSON.stringify(probeCatalog, null, 2)}\n`).digest('hex'),
    delivery: 'lazy',
    requiredAsset: 'technique-catalogs-bundle',
    selectionInput: 'argus/surface-inventory@1',
    fallback: 'full-catalog',
  },
};
assert(validateMatrixSchema({ ...matrix, techniqueCatalogs: probeContracts }),
  `capability matrix JSON Schema rejected a new catalog declaration: ${matrixAjv.errorsText(validateMatrixSchema.errors)}`);
assert(validateSchema(probeCatalog), `JSON Schema rejected the registration probe: ${ajv.errorsText(validateSchema.errors)}`);
const probeErrors = validateTechniqueCatalog(probeCatalog, probeContracts);
assert(probeErrors.length === 0, `runtime validator rejected the registration probe: ${probeErrors.join('; ')}`);
const probeSetErrors = validateTechniqueCatalogSet([...documents.values(), probeCatalog], probeContracts);
assert(probeSetErrors.length === 0, `catalog set rejected the registration probe: ${probeSetErrors.join('; ')}`);
assert(validateTechniqueCatalog(probeCatalog, contracts).some((error) => error.includes('registered capability-matrix catalog role')),
  'an unregistered catalog role was accepted');
assert(validateTechniqueCatalogSet([...documents.values()], probeContracts).some((error) => error.includes(`missing ${probeRole} catalog`)),
  'a registered role without a catalog was accepted');

const runtimeSource = readFileSync(join(ROOT, 'argus', 'runtime', 'technique-catalogs.mjs'), 'utf8');
for (const forbidden of ['readFileSync', 'readFile(', 'technique-catalogs/atalanta.json']) {
  assert(!runtimeSource.includes(forbidden), `runtime validator performs or embeds a catalog read: ${forbidden}`);
}
for (const role of roles) {
  assert(!new RegExp(`(['"\`])${role}\\1|^\\s*${role}\\s*:`, 'm').test(runtimeSource),
    `runtime validator hardcodes the registered role ${role}; catalog roles belong in the capability matrix`);
}

const summary = roles.map((role) => {
  const document = documents.get(role);
  if (contracts[role].catalogType === 'hunter') return `${document.entries.length} ${role[0].toUpperCase()}${role.slice(1)}`;
  return `${document.iso25010.length} ISO 25010, ${document.journeyClasses.length} journeys, ${document.archetypes.length} archetypes`;
});
console.log(
  `PASS  Argus technique catalogs: ${summary.join(', ')}, ${fixtures.cases.length} negative fixtures, ` +
  `${registryMutations.length + 2} registry rejections, registration probe accepted`,
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

function omit(value, key) {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function equalSets(left, right) {
  const expected = new Set(right);
  return left.length === expected.size && left.every((item) => expected.has(item));
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
