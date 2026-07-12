import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCoverageObservations, validateSurfaceInventory } from './coverage.mjs';
import { compileJsonSchema } from './json-schema.mjs';

export const CONTRACT_VERSION = 1;
export const CONTRACT_KINDS = Object.freeze([
  'bug-ledger',
  'lane-plan',
  'evidence-reference',
  'automation-status',
  'final-summary',
  'surface-inventory',
  'coverage-observations',
  'coverage-result',
  'model-escalation-request',
  'runner-result',
]);

const COLLECTION_CONTRACTS = Object.freeze({
  'lane-plan': { field: 'lanes', key: 'lane', label: 'lane', migration: 'argus/migrate-lane-plan-v1-to-v2', fields: ['lane', 'owner', 'phase', 'status', 'dependsOn', 'outputContracts', 'transitions'] },
  'evidence-reference': { field: 'references', key: 'id', label: 'evidence reference', migration: 'argus/migrate-evidence-reference-v1-to-v2', fields: ['id', 'kind', 'source', 'collectedBy', 'capturedAt', 'redaction', 'sha256', 'relatedBugIds'] },
  'automation-status': { field: 'tests', key: 'testId', label: 'automation test', migration: 'argus/migrate-automation-status-v1-to-v2', fields: ['testId', 'owner', 'status', 'runner', 'updatedAt', 'coversBugIds', 'evidenceIds'] },
});

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const POLICIES = join(dirname(fileURLToPath(import.meta.url)), '..', 'policies');
const validators = new Map();

const compatibility = loadJson(join(POLICIES, 'schema-compatibility.json'), 'schema compatibility policy');
const compatibilitySchema = loadJson(join(SCHEMAS, 'schema-compatibility.schema.json'), 'schema compatibility schema');
const compatibilityErrors = compileJsonSchema(compatibilitySchema)(compatibility);
if (compatibilityErrors.length > 0) {
  throw new Error(`invalid schema compatibility policy: ${compatibilityErrors.map(formatValidationError).join('; ')}`);
}
if (compatibility.current !== CONTRACT_VERSION || !compatibility.readCompatible.includes(CONTRACT_VERSION)) {
  throw new Error(`default schema compatibility policy does not permit contract version ${CONTRACT_VERSION}`);
}
for (const [kind, contract] of Object.entries(COLLECTION_CONTRACTS)) {
  const policy = compatibility.contracts?.[kind];
  if (policy?.current !== 2 || !sameNumbers(policy.readCompatible, [1, 2]) || policy.migration !== contract.migration) {
    throw new Error(`${kind} compatibility policy must preserve v1 and migrate deterministically to v2`);
  }
}
const preflightCompatibility = compatibility.contracts?.['preflight-report'];
if (preflightCompatibility?.current !== 2 || !sameNumbers(preflightCompatibility.readCompatible, [1, 2]) || preflightCompatibility.migration !== 'argus/preserve-preflight-report-v1-reader') {
  throw new Error('preflight-report compatibility policy must preserve the v1 reader and write v2');
}

export function schemaId(kind, version = contractPolicy(kind).current) {
  if (!CONTRACT_KINDS.includes(kind)) throw new Error(`unknown canonical contract: ${kind}`);
  return `argus/${kind}@${version}`;
}

export function validateCanonicalDocument(kind, document) {
  if (!CONTRACT_KINDS.includes(kind)) return [`unknown canonical contract: ${kind}`];
  const version = declaredContractVersion(kind, document);
  const policy = contractPolicy(kind);
  if (!policy.readCompatible.includes(version)) return [`unsupported ${kind} contract version: ${String(version)}`];
  const validate = canonicalValidator(kind, version);
  const schemaErrors = validate(document).map(formatValidationError);
  if (schemaErrors.length > 0) return schemaErrors;
  return semanticErrors(kind, document, version);
}

export function validateCanonicalFragment(kind, content) {
  let document;
  try { document = JSON.parse(String(content)); }
  catch { return { errors: ['fragment is not valid JSON'], document: null }; }
  return { errors: validateCanonicalDocument(kind, document), document };
}

export function migrateCanonicalDocument(kind, document) {
  const errors = validateCanonicalDocument(kind, document);
  if (errors.length) throw new Error(`${kind} document is invalid: ${errors.join('; ')}`);
  const contract = COLLECTION_CONTRACTS[kind];
  if (!contract) return document;
  const version = declaredContractVersion(kind, document);
  const records = version === 1
    ? [migrateLegacyRecord(kind, pickFields(document, contract.fields))]
    : document[contract.field];
  const migrated = {
    $schema: schemaId(kind),
    schemaVersion: contractPolicy(kind).current,
    engagementId: document.engagementId,
    [contract.field]: records.map((record) => pickFields(record, contract.fields)),
  };
  migrated[contract.field].sort((left, right) => compareAscii(left[contract.key], right[contract.key]));
  const migratedErrors = validateCanonicalDocument(kind, migrated);
  if (migratedErrors.length) throw new Error(`${kind} migration failed: ${migratedErrors.join('; ')}`);
  return migrated;
}

export function mergeCanonicalDocuments(kind, documents) {
  if (!Array.isArray(documents) || documents.length === 0) throw new Error(`${kind} merge requires at least one document`);
  const contract = COLLECTION_CONTRACTS[kind];
  if (!contract) {
    if (documents.length !== 1) throw new Error(`${kind} requires exactly one complete JSON document fragment`);
    const errors = validateCanonicalDocument(kind, documents[0]);
    if (errors.length) throw new Error(`${kind} merged document is invalid: ${errors.join('; ')}`);
    return documents[0];
  }
  const engagementId = documents[0]?.engagementId;
  const records = [];
  for (const document of documents) {
    const migrated = migrateCanonicalDocument(kind, document);
    if (migrated.engagementId !== engagementId) throw new Error(`${kind} collection fragments have different engagementId values`);
    records.push(...migrated[contract.field]);
  }
  records.sort((left, right) => compareAscii(left[contract.key], right[contract.key]));
  const merged = {
    $schema: schemaId(kind),
    schemaVersion: contractPolicy(kind).current,
    engagementId,
    [contract.field]: records,
  };
  const errors = validateCanonicalDocument(kind, merged);
  if (errors.length) throw new Error(`${kind} merged collection is invalid: ${errors.join('; ')}`);
  return merged;
}

export function renderFinalSummary(document) {
  const errors = validateCanonicalDocument('final-summary', document);
  if (errors.length) throw new Error(`invalid final summary: ${errors.join('; ')}`);
  const lines = [
    '# Argus Final Summary',
    '',
    `Source schema: ${document.$schema}`,
    `Engagement: ${document.engagementId}`,
    `Status: ${document.status}`,
    '',
    '## Counts',
    '',
    `- Bugs: ${document.counts.bugs}`,
    `- Automated: ${document.counts.automated}`,
    `- Evidence references: ${document.counts.evidence}`,
    '',
    '## Runner outcome',
    '',
    `- Mode: ${document.runner.mode}`,
    `- Status: ${document.runner.status}`,
    `- Exit code: ${document.runner.exitCode}`,
    `- Result: ${document.runner.resultPath}`,
    `- Product: ${document.runner.categories.product}`,
    `- Automation: ${document.runner.categories.automation}`,
    `- Infrastructure: ${document.runner.categories.infrastructure}`,
    `- Skip: ${document.runner.categories.skip}`,
    `- Policy: ${document.runner.categories.policy}`,
    '',
    ...(document.coverage ? [
      '## Surface-derived coverage',
      '',
      `- Result: ${document.coverage.resultPath}`,
      `- Discovery completeness: ${formatRatio(document.coverage.discoveryCompleteness)}`,
      `- Execution coverage: ${formatRatio(document.coverage.executionCoverage)}`,
      `- Assertion quality: ${formatRatio(document.coverage.assertionQuality)}`,
      `- Evidence quality: ${formatRatio(document.coverage.evidenceQuality)}`,
      `- Scoped outcomes: ${document.coverage.scopedOutcomes}`,
      '',
    ] : []),
    '## Source contracts',
    '',
    ...document.sourceSchemas.map((source) => `- ${source}`),
    '',
    '## Summary',
    '',
    document.summary,
    '',
  ];
  return lines.join('\n');
}

function formatRatio(value) {
  return value === null ? 'n/a' : `${Math.round(value * 10000) / 100}%`;
}

export function stableIdentity(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('identity must be a non-empty stable string');
  return createHash('sha256').update(value.trim()).digest('hex');
}

function canonicalValidator(kind, version) {
  const key = `${kind}@${version}`;
  if (!validators.has(key)) {
    const current = contractPolicy(kind).current;
    const path = join(SCHEMAS, version === current ? `${kind}.schema.json` : `${kind}-v${version}.schema.json`);
    let schema;
    try { schema = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`cannot load canonical schema ${path}: ${error.message}`); }
    validators.set(key, compileJsonSchema(schema));
  }
  return validators.get(key);
}

function semanticErrors(kind, document, version) {
  if (kind === 'bug-ledger') return duplicateIds(document.bugs, 'bug');
  if (kind === 'lane-plan') return validateLanePlan(document, version);
  if (COLLECTION_CONTRACTS[kind] && version === contractPolicy(kind).current) return validateOrderedCollection(document, COLLECTION_CONTRACTS[kind]);
  if (kind === 'surface-inventory') return validateSurfaceInventory(document);
  if (kind === 'coverage-observations') return validateCoverageObservations(document);
  if (kind === 'runner-result') return validateRunnerResult(document);
  return [];
}

function validateLanePlan(document, version) {
  const current = version === contractPolicy('lane-plan').current;
  if (!current) return [];
  const errors = validateOrderedCollection(document, COLLECTION_CONTRACTS['lane-plan']);
  for (const lane of document.lanes) errors.push(...validateLaneTransitions(lane));
  return errors;
}

function validateLaneTransitions(lane) {
  const errors = [];
  const transitions = lane.transitions;
  const label = `lane ${lane.lane}`;
  if (transitions[0].to !== 'planned') errors.push(`${label} first transition must be planned`);

  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1];
    const current = transitions[index];
    const allowed = previous.to === 'planned'
      ? new Set(['running', 'blocked'])
      : previous.to === 'running'
        ? new Set(['completed', 'blocked'])
        : new Set();
    if (!allowed.has(current.to)) errors.push(`${label} transition ${previous.to} -> ${current.to} is not allowed`);
    if (compareRfc3339(previous.at, current.at) >= 0) errors.push(`${label} transition timestamps must be strictly increasing`);
  }

  if (transitions.at(-1).to !== lane.status) errors.push(`${label} status must equal its final transition`);
  return errors;
}

function compareRfc3339(left, right) {
  const leftInstant = parseRfc3339Instant(left);
  const rightInstant = parseRfc3339Instant(right);
  if (leftInstant.second !== rightInstant.second) return leftInstant.second < rightInstant.second ? -1 : 1;
  const width = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
  return compareAscii(leftInstant.fraction.padEnd(width, '0'), rightInstant.fraction.padEnd(width, '0'));
}

function parseRfc3339Instant(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:)(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!match) throw new Error(`invalid RFC3339 timestamp reached lane-plan semantics: ${value}`);
  const leapSecond = match[3] === '60';
  const zone = normalizeRfc3339Zone(match[5]);
  const baseSecond = Date.parse(`${match[1]}T${match[2]}${leapSecond ? '59' : match[3]}${zone}`) / 1000;
  const second = baseSecond * 2 + (leapSecond ? 1 : 0);
  return { second, fraction: match[4] ?? '' };
}

function normalizeRfc3339Zone(value) {
  if (/^z$/i.test(value)) return 'Z';
  if (/^[+-]\d{2}$/.test(value)) return `${value}:00`;
  if (/^[+-]\d{4}$/.test(value)) return `${value.slice(0, 3)}:${value.slice(3)}`;
  return value;
}

function migrateLegacyRecord(kind, record) {
  if (kind !== 'lane-plan') return record;
  return { ...record, transitions: migrateLegacyLaneTransitions(record) };
}

function migrateLegacyLaneTransitions(record) {
  const source = record.transitions;
  const targetStates = canonicalLaneStates(record);

  // Preserve the historical v1 shape without rewriting either recorded endpoint.
  if (record.status === 'completed' && source.length === 2 && source[0].to === 'planned' && source[1].to === 'completed') {
    const midpoint = midpointTimestamp(source[0].at, source[1].at);
    if (midpoint !== null) {
      return [
        source[0],
        { to: 'running', at: midpoint, by: source[1].by },
        source[1],
      ];
    }
  }

  // A valid ordered subsequence keeps the original actors and exact RFC3339 values,
  // while obsolete or repeated v1 transitions are discarded deterministically.
  const selected = selectOrderedTransitions(source, targetStates);
  if (selected && strictlyIncreasingTransitions(selected)) return selected;

  // Every remaining schema-valid v1 state/status combination receives one stable,
  // strict v2 path. The fixed epoch makes repeated migrations byte-identical.
  return targetStates.map((to, index) => ({
    to,
    at: new Date(Date.UTC(2000, 0, 1) + index).toISOString(),
    by: legacyTransitionActor(source, record, to),
  }));
}

function canonicalLaneStates(record) {
  if (record.status === 'planned') return ['planned'];
  if (record.status === 'running') return ['planned', 'running'];
  if (record.status === 'completed') return ['planned', 'running', 'completed'];
  return record.transitions.some(({ to }) => to === 'running')
    ? ['planned', 'running', 'blocked']
    : ['planned', 'blocked'];
}

function selectOrderedTransitions(source, states) {
  const selected = [];
  let sourceIndex = 0;
  for (const state of states) {
    while (sourceIndex < source.length && source[sourceIndex].to !== state) sourceIndex += 1;
    if (sourceIndex === source.length) return null;
    selected.push(source[sourceIndex]);
    sourceIndex += 1;
  }
  return selected;
}

function strictlyIncreasingTransitions(transitions) {
  return transitions.every((transition, index) => index === 0 || compareRfc3339(transitions[index - 1].at, transition.at) < 0);
}

function legacyTransitionActor(source, record, state) {
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index].to === state) return source[index].by;
  }
  if (state === 'running') {
    for (let index = source.length - 1; index >= 0; index -= 1) {
      if (source[index].to === record.status) return source[index].by;
    }
  }
  return record.owner;
}

function midpointTimestamp(left, right) {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  const midpoint = leftMillis + Math.floor((rightMillis - leftMillis) / 2);
  if (!Number.isFinite(midpoint) || midpoint <= leftMillis || midpoint >= rightMillis) {
    return null;
  }
  return new Date(midpoint).toISOString();
}

function validateOrderedCollection(document, { field, key, label }) {
  const seen = new Set();
  const errors = [];
  let previous = null;
  for (const record of document[field]) {
    const value = record[key];
    if (seen.has(value)) errors.push(`duplicate ${label} ${key}: ${value}`);
    if (previous !== null && compareAscii(previous, value) > 0) errors.push(`${label} records must be sorted by ${key}`);
    seen.add(value);
    previous = value;
  }
  return errors;
}

function validateRunnerResult(document) {
  const errors = [];
  if ((document.exitCode === 0) !== (document.status === 'pass')) errors.push('runner status must be pass exactly when exitCode is 0');
  for (const category of ['product', 'automation', 'infrastructure', 'skip', 'policy']) {
    const count = document.events.filter((event) => event.category === category).length;
    if (document.categories[category] !== count) errors.push(`runner category ${category} count differs from events`);
  }
  return errors;
}

function duplicateIds(items, label) {
  const seen = new Set();
  const errors = [];
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
  return errors;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contractPolicy(kind) {
  return compatibility.contracts?.[kind] ?? { current: compatibility.current, readCompatible: compatibility.readCompatible };
}

function declaredContractVersion(kind, document) {
  const declaredId = document?.$schema ?? document?.schema;
  const match = new RegExp(`^argus/${kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(\\d+)$`).exec(declaredId ?? '');
  return match ? Number(match[1]) : Number.isInteger(document?.schemaVersion) ? document.schemaVersion : contractPolicy(kind).current;
}

function pickFields(document, fields) {
  return Object.fromEntries(fields.map((field) => [field, document[field]]));
}

function sameNumbers(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function loadJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`cannot load ${label} ${path}: ${error.message}`); }
}

function formatValidationError(error) {
  const location = error.instancePath || '/';
  return `${location} ${error.message} [${error.keyword} at ${error.schemaPath}]`;
}
