// Build-time semantic validation for technique catalogs. This module never reads catalog
// files: generators pass parsed documents in and embed the selected entries in prompts.
// Installed agents therefore do not need a runtime catalog read.

export const TECHNIQUE_CATALOG_SCHEMA = 'argus/technique-catalog@1';

const ROLE_CONTRACTS = Object.freeze({
  atalanta: Object.freeze({ type: 'hunter', prefix: 'ATA', count: 20 }),
  proteus: Object.freeze({ type: 'hunter', prefix: 'PRO', count: 15 }),
  metis: Object.freeze({ type: 'strategy' }),
});

const ISO_25010 = Object.freeze([
  'functional-suitability',
  'performance-efficiency',
  'compatibility',
  'usability',
  'reliability',
  'security',
  'maintainability',
  'portability',
]);

const ISTQB_PROCESS = Object.freeze(['analysis', 'design', 'implementation', 'execution', 'completion']);
const ISTQB_TECHNIQUES = Object.freeze([
  'boundary-value-analysis',
  'equivalence-partitioning',
  'decision-table',
  'state-transition',
  'pairwise-combinatorial',
  'use-case',
  'error-guessing-exploratory-charter',
]);
const JOURNEY_CLASSES = Object.freeze([
  'primary-user-cycle',
  'value-transaction',
  'cross-role-workflow',
  'content-lifecycle',
  'moderation-approval',
]);
const BOUNDARY_KINDS = Object.freeze([
  'threshold', 'range', 'limit', 'enum', 'page-size', 'rate', 'cutoff', 'charset-field',
]);
const BOUNDARY_COLUMNS = Object.freeze([
  'id', 'source', 'kind', 'documentedRule', 'exactBoundaryState', 'technique', 'laneOwner', 'tag',
]);
const BOUNDARY_MANDATES = Object.freeze([
  'record-inclusive-exclusive-or-question',
  'construct-b-minus-b-b-plus-at-domain-step',
  'register-every-charset-field',
  'reconcile-covered-versus-total-per-lane',
]);
const ARCHETYPES = Object.freeze([
  'boundary-equality',
  'charset-equivalence',
  'api-past-widget',
  'concurrency-race',
  'soft-delete-resurrection',
  'money-cross-view-recalculation',
  'effect-message-content',
  'perf-seeded-structural',
]);
const ROUTES = Object.freeze([
  'api', 'ui', 'security', 'performance', 'resilience', 'data',
  'accessibility', 'journey', 'contract', 'reporting',
]);

const SEMANTIC_MARKERS = Object.freeze({
  'ATA-T01': ['additionalProperties=false', 'strict subset'],
  'ATA-T03': ['GET, HEAD, PUT, DELETE, and OPTIONS', 'exactly one effect'],
  'ATA-T06': ['B-minus-step', 'B-plus-step', "domain's smallest unit"],
  'ATA-T07': ['past UI controls', 'no state change'],
  'ATA-T09': ['post-condition', 'field and rule'],
  'ATA-T10': ['prior-session', 'cannot authenticate'],
  'ATA-T11': ['exactly one unit remaining', 'oversell'],
  'ATA-T13': ['write and authentication paths', 'whitespace-only'],
  'ATA-T17': ['valid address is accepted', 'every email field'],
  'ATA-T19': ['Exactly one account exists', 'same account'],
  'ATA-T20': ['every discovered string field', 'silent truncation'],
  'PRO-T01': ['depth, complexity, alias, batch', 'uncontrolled work'],
  'PRO-T02': ['introspection', 'framework versions'],
  'PRO-T03': ['sensitive child fields', 'global node ID'],
  'PRO-T04': ['privileged extra mutation inputs', 'CSRF'],
  'PRO-T05': ['protobuf field numbers', 'UNKNOWN or INTERNAL'],
  'PRO-T06': ['every service method', 'honors deadlines and cancellation'],
  'PRO-T07': ['half-close', 'RESOURCE_EXHAUSTED'],
  'PRO-T08': ['every message independently', 'expired'],
  'PRO-T09': ['slow consumer', 'another identity'],
  'PRO-T10': ['two tenants', 'foreign channels'],
  'PRO-T11': ['additional fields', 'exactly one business effect'],
  'PRO-T12': ['dead-letter', 'side-effect storm'],
  'PRO-T13': ['exactly-once or at-least-once claim', 'acknowledgement boundary'],
  'PRO-T14': ['tampered-body', 'duplicate-event-ID'],
  'PRO-T15': ['link-local metadata', 'redirects are revalidated'],
});

const TOP_LEVEL = Object.freeze([
  '$schema', 'schemaVersion', 'catalogId', 'role', 'catalogType', 'valuePolicy', 'executionRule',
  'absentSurfaceDisposition', 'entries', 'iso25010', 'istqb', 'journeyClasses',
  'boundaryRegister', 'archetypes',
]);
const HUNTER_ENTRY_KEYS = Object.freeze([
  'id', 'title', 'scope', 'techniques', 'appliesWhen', 'construct', 'oracles', 'routes',
]);

export function validateTechniqueCatalog(document) {
  const errors = [];
  if (!isObject(document)) return ['/ must be an object'];

  rejectUnknown(errors, '/', document, TOP_LEVEL);
  expectEqual(errors, '/$schema', document.$schema, TECHNIQUE_CATALOG_SCHEMA);
  expectEqual(errors, '/schemaVersion', document.schemaVersion, 1);
  expectEqual(errors, '/valuePolicy', document.valuePolicy, 'discover-never-assume');
  expectEqual(errors, '/executionRule', document.executionRule, 'each-applicable-entry-covered-or-gap');

  const contract = ROLE_CONTRACTS[document.role];
  if (!contract) {
    errors.push('/role must be one of atalanta, proteus, or metis');
    return errors;
  }
  expectEqual(errors, '/catalogId', document.catalogId, `argus/technique-catalog/${document.role}@1`);
  expectEqual(errors, '/catalogType', document.catalogType, contract.type);

  if (contract.type === 'hunter') validateHunter(errors, document, contract);
  else validateStrategy(errors, document);
  return errors;
}

export function assertTechniqueCatalog(document) {
  const errors = validateTechniqueCatalog(document);
  if (errors.length) throw new Error(`invalid technique catalog: ${errors.join('; ')}`);
  return document;
}

export function validateTechniqueCatalogSet(documents) {
  const errors = [];
  if (!Array.isArray(documents)) return ['/ must be an array of technique catalogs'];
  if (documents.length !== 3) errors.push(`/ must contain exactly 3 catalogs; found ${documents.length}`);
  const roles = new Set();
  documents.forEach((document, index) => {
    const role = isObject(document) ? document.role : undefined;
    if (roles.has(role)) errors.push(`/${index}/role duplicates ${String(role)}`);
    roles.add(role);
    for (const error of validateTechniqueCatalog(document)) errors.push(`/${index}${error}`);
  });
  for (const role of Object.keys(ROLE_CONTRACTS)) {
    if (!roles.has(role)) errors.push(`/ is missing ${role} catalog`);
  }
  return errors;
}

function validateHunter(errors, document, contract) {
  expectEqual(errors, '/absentSurfaceDisposition', document.absentSurfaceDisposition, 'not-applicable-with-evidence');
  forbidPresent(errors, document, ['iso25010', 'istqb', 'journeyClasses', 'boundaryRegister', 'archetypes']);
  if (!Array.isArray(document.entries)) {
    errors.push('/entries must be an array');
    return;
  }
  if (document.entries.length !== contract.count) {
    errors.push(`/entries must contain exactly ${contract.count} entries; found ${document.entries.length}`);
  }
  const ids = new Set();
  const titles = new Set();
  document.entries.forEach((entry, index) => {
    const path = `/entries/${index}`;
    if (!isObject(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    rejectUnknown(errors, path, entry, HUNTER_ENTRY_KEYS);
    const expectedId = `${contract.prefix}-T${String(index + 1).padStart(2, '0')}`;
    expectEqual(errors, `${path}/id`, entry.id, expectedId);
    if (ids.has(entry.id)) errors.push(`${path}/id duplicates ${String(entry.id)}`);
    ids.add(entry.id);
    expectNonEmptyString(errors, `${path}/title`, entry.title);
    if (titles.has(entry.title)) errors.push(`${path}/title duplicates another entry`);
    titles.add(entry.title);
    expectStringArray(errors, `${path}/scope`, entry.scope, { nonEmpty: true });
    expectStringArray(errors, `${path}/techniques`, entry.techniques, { nonEmpty: true });
    if (!['always', 'surface-present', 'documented-control'].includes(entry.appliesWhen)) {
      errors.push(`${path}/appliesWhen is not supported`);
    }
    expectStringArray(errors, `${path}/construct`, entry.construct, { nonEmpty: true });
    expectStringArray(errors, `${path}/oracles`, entry.oracles, { nonEmpty: true });
    expectStringArray(errors, `${path}/routes`, entry.routes, { nonEmpty: true });
    for (const route of Array.isArray(entry.routes) ? entry.routes : []) {
      if (!ROUTES.includes(route)) errors.push(`${path}/routes contains unknown route ${String(route)}`);
    }
    const semanticText = flattenStrings(entry).join(' ').toLowerCase();
    for (const marker of SEMANTIC_MARKERS[expectedId] ?? []) {
      if (!semanticText.includes(marker.toLowerCase())) errors.push(`${path} is missing semantic marker: ${marker}`);
    }
  });
}

function validateStrategy(errors, document) {
  forbidPresent(errors, document, ['absentSurfaceDisposition', 'entries']);
  validateExactObjectIds(errors, '/iso25010', document.iso25010, ISO_25010, ['id', 'focus', 'coverageRule'], (item, path) => {
    expectStringArray(errors, `${path}/focus`, item.focus, { nonEmpty: true });
    expectEqual(errors, `${path}/coverageRule`, item.coverageRule, 'covered-or-named-residual-risk');
  });

  if (!isObject(document.istqb)) errors.push('/istqb must be an object');
  else {
    rejectUnknown(errors, '/istqb', document.istqb, ['process', 'techniques', 'mappingRule']);
    expectExactArray(errors, '/istqb/process', document.istqb.process, ISTQB_PROCESS);
    expectExactArray(errors, '/istqb/techniques', document.istqb.techniques, ISTQB_TECHNIQUES);
    expectEqual(errors, '/istqb/mappingRule', document.istqb.mappingRule, 'each-funded-row-names-technique-characteristic-lane-owner');
  }

  validateExactObjectIds(errors, '/journeyClasses', document.journeyClasses, JOURNEY_CLASSES, ['id', 'requiredOutcomes', 'techniques', 'tag', 'coverageRule'], (item, path) => {
    expectStringArray(errors, `${path}/requiredOutcomes`, item.requiredOutcomes, { nonEmpty: true });
    expectExactArray(errors, `${path}/techniques`, item.techniques, ['use-case', 'state-transition']);
    expectEqual(errors, `${path}/tag`, item.tag, '@e2e');
    expectEqual(errors, `${path}/coverageRule`, item.coverageRule, 'funded-or-justified');
  });

  if (!isObject(document.boundaryRegister)) errors.push('/boundaryRegister must be an object');
  else {
    const register = document.boundaryRegister;
    rejectUnknown(errors, '/boundaryRegister', register, ['required', 'artifact', 'rowIdPattern', 'kinds', 'requiredColumns', 'mandates']);
    expectEqual(errors, '/boundaryRegister/required', register.required, true);
    expectEqual(errors, '/boundaryRegister/artifact', register.artifact, 'solution/TEST-STRATEGY.md');
    expectEqual(errors, '/boundaryRegister/rowIdPattern', register.rowIdPattern, '^BND-[0-9]{3}$');
    expectExactArray(errors, '/boundaryRegister/kinds', register.kinds, BOUNDARY_KINDS);
    expectExactArray(errors, '/boundaryRegister/requiredColumns', register.requiredColumns, BOUNDARY_COLUMNS);
    expectExactArray(errors, '/boundaryRegister/mandates', register.mandates, BOUNDARY_MANDATES);
  }

  validateExactObjectIds(errors, '/archetypes', document.archetypes, ARCHETYPES, ['id', 'techniques', 'lanes', 'oracle', 'coverageRule'], (item, path) => {
    expectStringArray(errors, `${path}/techniques`, item.techniques, { nonEmpty: true });
    expectStringArray(errors, `${path}/lanes`, item.lanes, { nonEmpty: true });
    expectNonEmptyString(errors, `${path}/oracle`, item.oracle);
    expectEqual(errors, `${path}/coverageRule`, item.coverageRule, 'filled-or-justified');
  });
}

function validateExactObjectIds(errors, path, items, expectedIds, allowedKeys, validateItem) {
  if (!Array.isArray(items)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (items.length !== expectedIds.length) {
    errors.push(`${path} must contain exactly ${expectedIds.length} entries; found ${items.length}`);
  }
  const ids = new Set();
  items.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    if (!isObject(item)) {
      errors.push(`${itemPath} must be an object`);
      return;
    }
    rejectUnknown(errors, itemPath, item, allowedKeys);
    const expectedId = expectedIds[index];
    expectEqual(errors, `${itemPath}/id`, item.id, expectedId);
    if (ids.has(item.id)) errors.push(`${itemPath}/id duplicates ${String(item.id)}`);
    ids.add(item.id);
    validateItem(item, itemPath);
  });
}

function rejectUnknown(errors, path, value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path === '/' ? '' : path}/${key} is not allowed`);
  }
}

function forbidPresent(errors, document, keys) {
  for (const key of keys) if (Object.hasOwn(document, key)) errors.push(`/${key} is not allowed for ${document.catalogType}`);
}

function expectEqual(errors, path, actual, expected) {
  if (actual !== expected) errors.push(`${path} must equal ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`);
}

function expectNonEmptyString(errors, path, value) {
  if (typeof value !== 'string' || value.trim().length < 3) errors.push(`${path} must be a non-empty string`);
}

function expectStringArray(errors, path, value, { nonEmpty }) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (nonEmpty && value.length === 0) errors.push(`${path} must not be empty`);
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) errors.push(`${path}/${index} must be a non-empty string`);
    if (seen.has(item)) errors.push(`${path}/${index} duplicates ${String(item)}`);
    seen.add(item);
  });
}

function expectExactArray(errors, path, actual, expected) {
  if (!Array.isArray(actual)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (actual.length !== expected.length) errors.push(`${path} must contain exactly ${expected.length} entries; found ${actual.length}`);
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== expected[index]) errors.push(`${path}/${index} must equal ${JSON.stringify(expected[index])}; found ${JSON.stringify(actual[index])}`);
  }
}

function flattenStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (isObject(value)) return Object.values(value).flatMap(flattenStrings);
  return [];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
