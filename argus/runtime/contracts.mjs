import { validateFindingQuality } from './finding-quality.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateCoverageObservations, validateCoverageResult, validateSurfaceInventory } from './coverage.mjs';
import { validateEvidenceReferences, validateRunnerResultSemantics } from './evidence.mjs';
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
  'capability-evidence',
  'automation-review',
]);

// A collection whose records name an `owner` field holds updatable records: each record belongs
// to that lane, only that lane (or the canonical's merging owner) may write it, and a later
// fragment of the same key supersedes the earlier one at merge. Every other collection record is
// immutable once written; evidence references alone permit byte-identical record replays.
const COLLECTION_CONTRACTS = Object.freeze({
  'lane-plan': { field: 'lanes', key: 'lane', label: 'lane' },
  'evidence-reference': { field: 'references', key: 'id', label: 'evidence reference' },
  'automation-status': { field: 'tests', key: 'testId', label: 'automation test', owner: 'owner' },
  'coverage-observations': { field: 'observations', key: 'observationId', label: 'coverage observation', owner: 'lane' },
});

// Recon capability gates and the only proof kind that can prove each one. The keys must
// equal the capability-matrix capabilities of kind "target" (asserted by the schema smoke).
const CAPABILITY_PROOF_KINDS = Object.freeze({
  'db-access': 'db-select',
  'existing-suite': 'suite-root',
  'multi-service': 'service-map',
  'non-rest-surface': 'protocol-surface',
  'source-access': 'source-root',
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
// The only contract overrides the runtime reads, each at exactly its current version. A
// subtask that bumps a contract edits its own row here and in the compatibility policy.
const EXPECTED_CONTRACT_VERSIONS = Object.freeze({
  'lane-plan': 2,
  'evidence-reference': 3,
  'automation-status': 2,
  'preflight-report': 3,
  'bug-ledger': 2,
  'coverage-observations': 2,
  'coverage-result': 2,
  'final-summary': 2,
});
for (const [kind, version] of Object.entries(EXPECTED_CONTRACT_VERSIONS)) {
  const policy = compatibility.contracts?.[kind];
  if (policy?.current !== version || !sameNumbers(policy.readCompatible, [version])) {
    throw new Error(`${kind} compatibility policy must accept only v${version}`);
  }
}
for (const kind of Object.keys(compatibility.contracts ?? {})) {
  if (!Object.hasOwn(EXPECTED_CONTRACT_VERSIONS, kind)) throw new Error(`schema compatibility policy overrides unexpected contract ${kind}`);
}

// Every other contract is a single complete document: its owner may supersede it with a
// newer fragment, but a merge publishes exactly one document.
export function isCollectionContract(kind) {
  return Object.hasOwn(COLLECTION_CONTRACTS, kind);
}

// Stability invariants a newer single-document fragment must keep relative to the fragment
// it supersedes. A kind without an entry may be replaced freely by its owner.
const SUPERSESSION_INVARIANTS = Object.freeze({
  'bug-ledger': bugLedgerSupersessionErrors,
  'surface-inventory': surfaceInventorySupersessionErrors,
  'automation-review': automationReviewSupersessionErrors,
});

export function assertSupersession(kind, previous, next) {
  if (!CONTRACT_KINDS.includes(kind)) throw new Error(`unknown canonical contract: ${kind}`);
  if (isCollectionContract(kind)) throw new Error(`${kind} is a collection contract; its fragments merge and never supersede`);
  const errors = SUPERSESSION_INVARIANTS[kind]?.(previous, next) ?? [];
  if (errors.length) throw new Error(errors.join('; '));
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
  const records = document[contract.field];
  const migrated = {
    $schema: schemaId(kind),
    schemaVersion: contractPolicy(kind).current,
    engagementId: document.engagementId,
    [contract.field]: structuredClone(records),
  };
  migrated[contract.field].sort((left, right) => compareAscii(left[contract.key], right[contract.key]));
  const migratedErrors = validateCanonicalDocument(kind, migrated);
  if (migratedErrors.length) throw new Error(`${kind} migration failed: ${migratedErrors.join('; ')}`);
  return migrated;
}

// The records of an owned collection fragment that its writer may not submit: each record's
// owner must be the writing lane, unless the writer is the canonical's merging owner.
export function collectionOwnershipErrors(kind, document, writer, canonicalOwner) {
  const contract = COLLECTION_CONTRACTS[kind];
  if (!contract?.owner || writer === canonicalOwner) return [];
  return (document?.[contract.field] ?? [])
    .filter((record) => record?.[contract.owner] !== writer)
    .map((record) => `${contract.label} ${record?.[contract.key]} belongs to ${record?.[contract.owner]}; ${writer} may write only its own records`);
}

// Collection fragments merge by key. With `writers` ({lane, sequence} per document, from the
// engagement's fragment records), an owned collection supersedes a key record by record: every
// fragment must respect record ownership, a key keeps one owner, and the record from the highest
// write sequence is merged. Without writers, or for an immutable collection, a key that appears
// in two fragments fails closed, except byte-identical evidence-reference record replays.
export function mergeCanonicalDocuments(kind, documents, { writers = null, canonicalOwner = null } = {}) {
  if (!Array.isArray(documents) || documents.length === 0) throw new Error(`${kind} merge requires at least one document`);
  const contract = COLLECTION_CONTRACTS[kind];
  if (!contract) {
    if (documents.length !== 1) throw new Error(`${kind} requires exactly one complete JSON document fragment`);
    const errors = validateCanonicalDocument(kind, documents[0]);
    if (errors.length) throw new Error(`${kind} merged document is invalid: ${errors.join('; ')}`);
    return documents[0];
  }
  const supersedes = Boolean(contract.owner) && writers !== null;
  if (supersedes && (!Array.isArray(writers) || writers.length !== documents.length)) throw new Error(`${kind} merge requires one writer per fragment`);
  const engagementId = documents[0]?.engagementId;
  const latest = new Map();
  const records = [];
  documents.forEach((document, index) => {
    const migrated = migrateCanonicalDocument(kind, document);
    if (migrated.engagementId !== engagementId) throw new Error(`${kind} collection fragments have different engagementId values`);
    if (!supersedes) {
      for (const record of migrated[contract.field]) {
        if (kind === 'evidence-reference') {
          const key = record[contract.key];
          const serialized = JSON.stringify(record);
          if (latest.has(key)) {
            if (latest.get(key) === serialized) continue;
            throw new Error(`duplicate evidence reference id: ${key}; immutable records differ`);
          }
          latest.set(key, serialized);
        }
        records.push(record);
      }
      return;
    }
    const { lane, sequence } = writers[index];
    const ownership = collectionOwnershipErrors(kind, migrated, lane, canonicalOwner);
    if (ownership.length) throw new Error(`${kind} fragment ownership is invalid: ${ownership.join('; ')}`);
    for (const record of migrated[contract.field]) {
      const key = record[contract.key];
      const held = latest.get(key);
      if (held && held.record[contract.owner] !== record[contract.owner]) {
        throw new Error(`${kind} ${contract.label} ${key} belongs to ${held.record[contract.owner]}, not ${record[contract.owner]}`);
      }
      if (held && held.sequence === sequence) throw new Error(`${kind} ${contract.label} ${key} appears twice at write sequence ${sequence}`);
      if (!held || sequence > held.sequence) latest.set(key, { record, sequence });
    }
  });
  if (supersedes) records.push(...[...latest.values()].map((entry) => entry.record));
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

export function renderFinalSummary(document, { launchAssurance } = {}) {
  const errors = validateCanonicalDocument('final-summary', document);
  if (errors.length) throw new Error(`invalid final summary: ${errors.join('; ')}`);
  // Attestation status comes from the engagement manifest, not from the merged
  // final-summary document, so an unattested run cannot omit this disclosure by
  // writing a fragment that leaves it out. Attested runs render exactly as before.
  const unattested = launchAssurance === 'unattested';
  const { bugs, regression } = document.counts;
  const review = document.automationReview;
  const coverage = document.coverage;
  // A null runner is unfunded automation, except in a mode that funded automation that could
  // not run or not be verified: its operator installed no template selection, or the
  // runner-script owner was abandoned before any runner result or before registering it.
  const notRun = document.statusReasons.includes('template-selection-missing')
    ? { line: 'Automation: not run; no operator template selection was installed (template-selection-missing).', coverage: 'n/a (no template selection)' }
    : document.statusReasons.includes('runner-result-missing')
      ? { line: 'Automation: not run; the lane that owns run-tests.sh was abandoned before any runner result (runner-result-missing).', coverage: 'n/a (no runner result)' }
      : document.statusReasons.includes('runner-result-unregistered')
        ? { line: 'Automation: not verified; the lane that owns run-tests.sh was abandoned before it registered reports/argus-runner-result.json (runner-result-unregistered).', coverage: 'n/a (unregistered runner result)' }
        : { line: 'Automation: unfunded; no framework runner was executed.', coverage: 'n/a (automation unfunded)' };
  const lines = [
    '# Argus Final Summary',
    '',
    `Source schema: ${document.$schema}`,
    `Engagement: ${document.engagementId}`,
    `Status: ${document.status}`,
    ...document.statusReasons.map((reason) => `Status reason: ${reason}`),
    ...(unattested ? [`Attestation: UNATTESTED (launchAssurance=unattested)`] : []),
    '',
    ...(unattested ? [
      '## Attestation: UNATTESTED',
      '',
      'This engagement ran with `launchAssurance: "unattested"`: the operator explicitly opted',
      'out of native-launch attestation because no Ed25519 trust store was available. No',
      'cryptographic proof of sandbox, turn-cap, or model-dispatch integrity exists for this',
      'run, and pinned-key rotation/revocation could not be detected mid-engagement. Model',
      'decisions remain integrity-bound (self-consistent SHA-256, deterministic re-derivation',
      'from the packaged policy and adapter snapshot) and the OS sandbox stayed active, but',
      'every finding below carries this as a named residual risk.',
      '',
    ] : []),
    '## Counts',
    '',
    `- Defect headline (confirmed + suspected): ${bugs.headline}`,
    `- Confirmed: ${bugs.confirmed}`,
    `- Suspected: ${bugs.suspected}`,
    `- Needs oracle: ${bugs.needsOracle}`,
    `- Bounced: ${bugs.bounced}`,
    `- Quarantined: ${bugs.quarantined}`,
    `- Duplicate: ${bugs.duplicate}`,
    `- Rejected: ${bugs.rejected}`,
    `- Confirmed with verified regression: ${regression.wired} (uncovered: ${regression.uncovered.length ? regression.uncovered.join(', ') : 'none'})`,
    `- Automated tests: ${document.counts.automated}`,
    `- Evidence references: ${document.counts.evidence}`,
    '',
    '## Likely, unproven',
    '',
    ...(document.unproven.length ? document.unproven.map((entry) =>
      `- ${entry.id} (${entry.severity}, ${entry.status}): ${entry.title} — would be confirmed by: ${entry.missing.join(', ')} — ${entry.detail}`) : ['None.']),
    '',
    '## Unresolved proof residuals',
    '',
    ...(document.residuals.length ? document.residuals.map((entry) => [
      `- ${entry.id} (${entry.severity}, ${entry.status}): ${entry.title}`,
      ...(entry.repairRound === null ? [] : [`repair round ${entry.repairRound}`]),
      ...(entry.missing.length ? [`missing: ${entry.missing.join(', ')}`] : []),
      ...(entry.reasons.length ? [`reasons: ${entry.reasons.join('; ')}`] : []),
    ].join(' — ')) : ['None.']),
    '',
    '## Automation review',
    '',
    `- Verdict: ${REVIEW_VERDICT_TOKENS[review.status]} (${review.reviewId ? `${review.reviewId}, round ${review.round}` : 'no review round'}, blockers ${review.blockers}, warnings ${review.warnings})`,
    '',
    '## Runner outcome',
    '',
    ...(document.runner ? [
    `- Mode: ${document.runner.mode}`,
    `- Status: ${document.runner.status}`,
    `- Exit code: ${document.runner.exitCode}`,
    `- Delivery gate: ${document.runner.deliveryGate ? 'yes' : 'no'}`,
    `- Result: ${document.runner.resultPath} (registered evidence ${document.runner.evidenceId})`,
    `- Product: ${document.runner.categories.product}`,
    `- Automation: ${document.runner.categories.automation}`,
    `- Infrastructure: ${document.runner.categories.infrastructure}`,
    `- Skip: ${document.runner.categories.skip}`,
    `- Policy: ${document.runner.categories.policy}`,
    ] : [notRun.line]),
    '',
    '## Surface-derived coverage',
    '',
    `- Result: ${coverage.resultPath}`,
    `- Discovery completeness: ${formatRatio(coverage.discoveryCompleteness)}`,
    `- Execution coverage: ${formatRatio(coverage.executionCoverage)} (surface breadth)`,
    `- Assertion quality: ${formatRatio(coverage.assertionQuality)}`,
    `- Evidence quality: ${formatRatio(coverage.evidenceQuality)}`,
    `- Automated re-execution: ${document.runner ? formatRatio(coverage.automatedExecution) : notRun.coverage}`,
    `- Scoped outcomes: ${coverage.scopedOutcomes}`,
    ...coverage.criticalUnexecuted.map((id) => `- Critical surface not executed: ${id}`),
    `- Required-case depth: ${(coverage.caseDepth?.coverage == null ? 'unknown (not fully planned)' : formatRatio(coverage.caseDepth.coverage))}`,
    ...(coverage.caseDepth?.unplannedSurfaces ?? []).map(id => `- Unplanned depth: ${id}`),
    ...(coverage.caseDepth?.gaps ?? []).map(gap => `- Case gap: ${gap.obligationId}: ${gap.reason}`),
    '',
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

// The rendered verdict names Aristarchus's persisted outcome; a STALE approval or an ABSENT
// review is never printed as APPROVE.
const REVIEW_VERDICT_TOKENS = Object.freeze({
  approved: 'APPROVE',
  blocked: 'BLOCK',
  stale: 'STALE',
  absent: 'ABSENT',
  'not-applicable': 'NOT-APPLICABLE',
});

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
    if (version !== current) throw new Error(`unsupported ${kind} contract version: ${version}`);
    const path = join(SCHEMAS, `${kind}.schema.json`);
    let schema;
    try { schema = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`cannot load canonical schema ${path}: ${error.message}`); }
    validators.set(key, compileJsonSchema(schema));
  }
  return validators.get(key);
}

function semanticErrors(kind, document) {
  if (kind === 'bug-ledger') return [...duplicateIds(document.bugs, 'bug'), ...validateFindingQuality(document.bugs)];
  if (kind === 'lane-plan') return validateLanePlan(document);
  if (kind === 'evidence-reference') return [...validateOrderedCollection(document, COLLECTION_CONTRACTS[kind]), ...validateEvidenceReferences(document)];
  if (kind === 'coverage-observations') return [...validateOrderedCollection(document, COLLECTION_CONTRACTS[kind]), ...validateCoverageObservations(document)];
  if (COLLECTION_CONTRACTS[kind]) return validateOrderedCollection(document, COLLECTION_CONTRACTS[kind]);
  if (kind === 'surface-inventory') return validateSurfaceInventory(document);
  if (kind === 'coverage-result') return validateCoverageResult(document);
  if (kind === 'runner-result') return validateRunnerResultSemantics(document);
  if (kind === 'capability-evidence') return validateCapabilityEvidence(document);
  if (kind === 'automation-review') return validateAutomationReview(document);
  if (kind === 'final-summary') return validateFinalSummary(document);
  return [];
}

function validateLanePlan(document) {
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
  if (!match) throw new Error(`invalid RFC3339 timestamp reached contract semantics: ${value}`);
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

function validateCapabilityEvidence(document) {
  const errors = [];
  const seen = new Set();
  for (const gate of document.gates) {
    const { capability, proof } = gate;
    if (seen.has(capability)) errors.push(`duplicate capability gate: ${capability}`);
    seen.add(capability);
    if (!proof) continue;
    const expectedKind = CAPABILITY_PROOF_KINDS[capability];
    if (proof.kind !== expectedKind) {
      errors.push(`${capability} proof kind must be ${expectedKind}, not ${proof.kind}`);
      continue;
    }
    if (proof.kind === 'source-root' && !isStrictlyInside(proof.path, proof.fileRead)) {
      errors.push('source-access proof fileRead must be inside its source root path');
    }
    if (proof.kind === 'suite-root' && !isStrictlyInside(proof.path, proof.testFile)) {
      errors.push('existing-suite proof testFile must be inside its suite root path');
    }
    if (proof.kind === 'service-map') {
      const origins = new Set();
      const names = new Set();
      for (const service of proof.services) {
        const origin = service.origin.toLowerCase();
        if (origins.has(origin)) errors.push(`multi-service proof repeats service origin: ${service.origin}`);
        if (names.has(service.name)) errors.push(`multi-service proof repeats service name: ${service.name}`);
        origins.add(origin);
        names.add(service.name);
      }
    }
  }
  for (const capability of Object.keys(CAPABILITY_PROOF_KINDS)) {
    if (!seen.has(capability)) errors.push(`missing capability gate: ${capability}`);
  }
  return errors;
}

// Bug IDs are stable once assigned: a newer ledger keeps every earlier ID and never drops an
// origin from it, so an ID can change status but never disappear or point at another filing.
function bugLedgerSupersessionErrors(previous, next) {
  const current = new Map(next.bugs.map((bug) => [bug.id, new Set(bug.origin)]));
  const errors = [];
  for (const bug of previous.bugs) {
    const origins = current.get(bug.id);
    if (!origins || !bug.origin.every((origin) => origins.has(origin))) errors.push(`bug-ledger supersession removed or re-pointed ${bug.id}`);
  }
  return errors;
}

// Discovery expands monotonically: every earlier surface ID survives, and the discovered
// candidate count never shrinks.
function surfaceInventorySupersessionErrors(previous, next) {
  const current = new Set(next.items.map((item) => item.id));
  const errors = previous.items
    .filter((item) => !current.has(item.id))
    .map((item) => `surface-inventory supersession removed ${item.id}`);
  if (next.discovery.candidates < previous.discovery.candidates) {
    errors.push(`surface-inventory supersession decreased discovery.candidates from ${previous.discovery.candidates} to ${next.discovery.candidates}`);
  }
  return errors;
}

// Review rounds are append-only: a newer document repeats every earlier round unchanged, so a
// verdict, its findings, and the corpus it judged can never be rewritten after publication.
function automationReviewSupersessionErrors(previous, next) {
  if (next.reviews.length < previous.reviews.length) {
    return [`automation-review supersession dropped rounds: ${previous.reviews.length} -> ${next.reviews.length}`];
  }
  return previous.reviews
    .filter((review, index) => !isDeepStrictEqual(review, next.reviews[index]))
    .map((review) => `automation-review supersession altered ${review.reviewId}`);
}

// Rounds are numbered REV-01, REV-02, ... without gaps, each supersedes its predecessor, and
// every blocker of one round is accounted for in the next round's resolved list. A verdict is
// BLOCK exactly when blockers remain, so APPROVE can never carry an open blocker.
function validateAutomationReview(document) {
  const errors = [];
  const findingIds = new Set();
  let previous = null;
  document.reviews.forEach((review, index) => {
    const label = `automation review ${review.reviewId}`;
    if (previous && compareAscii(previous.reviewId, review.reviewId) >= 0) errors.push('automation reviews must be sorted by unique reviewId');
    if (review.round !== index + 1) errors.push(`${label} round ${review.round} breaks contiguous rounds from 1`);
    if (review.round !== Number(review.reviewId.slice(4))) errors.push(`${label} round must equal its reviewId suffix`);
    const expectedSupersedes = previous ? previous.reviewId : null;
    if (review.supersedes !== expectedSupersedes) errors.push(`${label} must supersede ${expectedSupersedes ?? 'null'}`);
    if ((review.verdict === 'BLOCK') !== (review.blockers.length > 0)) errors.push(`${label} verdict must be BLOCK if and only if blockers remain`);
    for (const finding of [...review.blockers, ...review.warnings]) {
      if (findingIds.has(finding.id)) errors.push(`duplicate automation review finding id: ${finding.id}`);
      findingIds.add(finding.id);
    }
    const expectedResolved = previous ? previous.blockers.map((blocker) => blocker.id).sort() : [];
    const resolved = review.resolved.map((item) => item.blockerId).sort();
    if (!isDeepStrictEqual(resolved, expectedResolved)) {
      errors.push(`${label} resolved must list exactly the blockers of ${previous?.reviewId ?? 'no earlier round'}: ${expectedResolved.join(', ') || 'none'}`);
    }
    if (review.resolved.some((item) => item.previousReviewId !== previous?.reviewId)) errors.push(`${label} resolved entries must cite ${previous?.reviewId ?? 'no earlier round'}`);
    if (review.uncoveredConfirmedBugs.length > 0 && !review.blockers.some((blocker) => blocker.category === 'uncovered-confirmed-bug')) {
      errors.push(`${label} lists uncovered confirmed bugs without an uncovered-confirmed-bug blocker`);
    }
    if (previous && compareRfc3339(previous.reviewedAt, review.reviewedAt) >= 0) errors.push(`${label} reviewedAt must be later than ${previous.reviewId}`);
    previous = review;
  });
  return errors;
}

// The final-summary facts are derived from the canonical ledger, automation status, coverage
// result, and review record at merge; these rules keep a submitted document self-consistent, so
// no summary can headline fewer defects than it counts or drop a likely, unproven finding or an
// unresolved bounced or quarantined proof residual.
function validateFinalSummary(document) {
  const errors = [];
  const { bugs, regression } = document.counts;
  if (bugs.headline !== bugs.confirmed + bugs.suspected) errors.push('counts.bugs.headline must equal confirmed + suspected');
  const unprovenIds = document.unproven.map((entry) => entry.id);
  if (!isSortedUnique(unprovenIds)) errors.push('unproven entries must be sorted by unique id');
  if (document.unproven.length !== bugs.suspected + bugs.needsOracle) errors.push('unproven must list exactly the suspected and needs-oracle bugs');
  const unprovenWith = (status) => document.unproven.filter((entry) => entry.status === status).length;
  if (unprovenWith('suspected') !== bugs.suspected || unprovenWith('needs-oracle') !== bugs.needsOracle) {
    errors.push('unproven statuses must match counts.bugs.suspected and counts.bugs.needsOracle');
  }
  const residualIds = document.residuals.map((entry) => entry.id);
  if (!isSortedUnique(residualIds)) errors.push('residuals must be sorted by unique id');
  const residualsWith = (status) => document.residuals.filter((entry) => entry.status === status).length;
  if (residualsWith('bounced') !== bugs.bounced || residualsWith('quarantined') !== bugs.quarantined) {
    errors.push('residuals must list exactly the bounced and quarantined bugs');
  }
  if (residualIds.some((id) => unprovenIds.includes(id))) errors.push('a bug cannot be both unproven and a proof residual');
  if (!isSortedUnique(regression.uncovered)) errors.push('counts.regression.uncovered must be sorted and unique');
  if (regression.wired + regression.uncovered.length !== bugs.confirmed) errors.push('counts.regression wired and uncovered must partition the confirmed bugs');
  if (!isSortedUnique(document.statusReasons)) errors.push('statusReasons must be sorted and unique');
  if (document.status === 'completed' && document.statusReasons.length > 0) errors.push('a completed final summary cannot carry status reasons');
  if (!isSortedUnique(document.coverage.criticalUnexecuted)) errors.push('coverage.criticalUnexecuted must be sorted and unique');
  const review = document.automationReview;
  const reviewed = ['approved', 'blocked', 'stale'].includes(review.status);
  if ((review.reviewId !== null) !== reviewed || (review.round !== null) !== reviewed) {
    errors.push(`automationReview ${review.status} must ${reviewed ? 'name' : 'not name'} a review round`);
  } else if (reviewed && review.round !== Number(review.reviewId.slice(4))) {
    errors.push('automationReview round must equal its reviewId suffix');
  }
  if ((review.status === 'blocked') !== (review.blockers > 0)) errors.push('automationReview blockers are non-zero exactly when the latest round BLOCKs');
  if (!reviewed && review.warnings > 0) errors.push(`automationReview ${review.status} cannot carry warnings`);
  return errors;
}

function isSortedUnique(values) {
  return values.every((value, index) => index === 0 || compareAscii(values[index - 1], value) < 0);
}

// Lexical containment only; the gate resolver re-checks the physical paths itself.
function isStrictlyInside(root, candidate) {
  const path = posix.relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path);
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
