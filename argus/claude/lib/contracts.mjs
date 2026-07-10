import { createHash } from 'node:crypto';
import { validateCoverageObservations, validateSurfaceInventory } from './coverage.mjs';

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
]);

const ID = {
  bug: /^BUG-[0-9]{4}$/,
  test: /^(?:TST|REG)-[0-9]{4}$/,
  evidence: /^EVD-[0-9]{4}$/,
  lane: /^[a-z][a-z0-9-]*$/,
  sha256: /^[a-f0-9]{64}$/,
};
const ISO = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const string = (value) => typeof value === 'string' && value.trim().length > 0;
const list = (value, predicate = string) => Array.isArray(value) && value.every(predicate) && new Set(value).size === value.length;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function schemaId(kind) {
  if (!CONTRACT_KINDS.includes(kind)) throw new Error(`unknown canonical contract: ${kind}`);
  return `argus/${kind}@${CONTRACT_VERSION}`;
}

export function validateCanonicalDocument(kind, document) {
  const errors = [];
  if (!CONTRACT_KINDS.includes(kind)) return [`unknown canonical contract: ${kind}`];
  if (!object(document)) return ['document must be an object'];
  if (document.schemaVersion !== CONTRACT_VERSION) errors.push(`schemaVersion must be ${CONTRACT_VERSION}`);
  if (document.$schema !== schemaId(kind)) errors.push(`$schema must be ${schemaId(kind)}`);
  if (!string(document.engagementId)) errors.push('engagementId is required');

  if (kind === 'bug-ledger') validateBugLedger(document, errors);
  if (kind === 'lane-plan') validateLanePlan(document, errors);
  if (kind === 'evidence-reference') validateEvidenceReference(document, errors);
  if (kind === 'automation-status') validateAutomationStatus(document, errors);
  if (kind === 'final-summary') validateFinalSummary(document, errors);
  if (kind === 'surface-inventory') errors.push(...validateSurfaceInventory(document));
  if (kind === 'coverage-observations') errors.push(...validateCoverageObservations(document));
  if (kind === 'coverage-result') validateCoverageResult(document, errors);
  return [...new Set(errors)];
}

export function validateCanonicalFragment(kind, content) {
  let document;
  try { document = JSON.parse(String(content)); }
  catch { return { errors: ['fragment is not valid JSON'], document: null }; }
  return { errors: validateCanonicalDocument(kind, document), document };
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
  if (!string(value)) throw new Error('identity must be a non-empty stable string');
  return createHash('sha256').update(value.trim()).digest('hex');
}

function validateBugLedger(document, errors) {
  if (!Array.isArray(document.bugs)) return errors.push('bugs must be an array');
  const ids = new Set();
  for (const bug of document.bugs) {
    if (!object(bug)) { errors.push('bug entries must be objects'); continue; }
    if (!ID.bug.test(bug.id ?? '')) errors.push(`invalid bug id: ${bug.id ?? '(missing)'}`);
    if (ids.has(bug.id)) errors.push(`duplicate bug id: ${bug.id}`);
    ids.add(bug.id);
    if (!list(bug.origin, (value) => /^[A-Z]{3}-[0-9]{3,4}$/.test(value))) errors.push(`bug ${bug.id}: origin must contain stable finding IDs`);
    if (!string(bug.title) || !['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'].includes(bug.severity) || !['P1', 'P2', 'P3', 'P4'].includes(bug.priority)) errors.push(`bug ${bug.id}: title, severity, or priority is invalid`);
    if (!ID.lane.test(bug.lane ?? '') || !string(bug.oracleId) || !['confirmed', 'suspected', 'needs-oracle'].includes(bug.status)) errors.push(`bug ${bug.id}: lane, oracleId, or status is invalid`);
    if (typeof bug.wired !== 'boolean' || (bug.wired && !ID.test.test(bug.testId ?? ''))) errors.push(`bug ${bug.id}: wired bugs require a stable testId`);
    if (!list(bug.evidenceIds, (value) => ID.evidence.test(value))) errors.push(`bug ${bug.id}: evidenceIds are invalid`);
  }
}

function validateLanePlan(document, errors) {
  if (!ID.lane.test(document.lane ?? '') || !ID.lane.test(document.owner ?? '')) errors.push('lane and owner must be slugs');
  if (!['discovery', 'hunting', 'automation', 'verification', 'reporting'].includes(document.phase)) errors.push('phase is invalid');
  if (!['planned', 'running', 'blocked', 'completed'].includes(document.status)) errors.push('status is invalid');
  if (!list(document.dependsOn, (value) => ID.lane.test(value))) errors.push('dependsOn must be unique lane slugs');
  if (!list(document.outputContracts, string)) errors.push('outputContracts must be unique non-empty contract paths');
  if (!Array.isArray(document.transitions) || document.transitions.length === 0 || !document.transitions.every((transition) => object(transition) && ['planned', 'running', 'blocked', 'completed'].includes(transition.to) && ISO(transition.at) && string(transition.by))) errors.push('transitions must be auditable state transitions');
}

function validateEvidenceReference(document, errors) {
  if (!ID.evidence.test(document.id ?? '')) errors.push('id must be EVD-NNNN');
  if (!['text', 'http', 'trace', 'metric', 'log'].includes(document.kind)) errors.push('kind is invalid');
  if (!string(document.source) || !ID.lane.test(document.collectedBy ?? '') || !ISO(document.capturedAt)) errors.push('source, collectedBy, or capturedAt is invalid');
  if (!['redacted', 'synthetic', 'public'].includes(document.redaction)) errors.push('redaction is invalid');
  if (!ID.sha256.test(document.sha256 ?? '')) errors.push('sha256 is invalid');
  if (!list(document.relatedBugIds ?? [], (value) => ID.bug.test(value))) errors.push('relatedBugIds are invalid');
}

function validateAutomationStatus(document, errors) {
  if (!ID.test.test(document.testId ?? '')) errors.push('testId must be TST-NNNN or REG-NNNN');
  if (!ID.lane.test(document.owner ?? '') || !['planned', 'implemented', 'passed', 'failed', 'skipped'].includes(document.status)) errors.push('owner or status is invalid');
  if (!string(document.runner) || !ISO(document.updatedAt)) errors.push('runner or updatedAt is invalid');
  if (!list(document.coversBugIds, (value) => ID.bug.test(value))) errors.push('coversBugIds are invalid');
  if (!list(document.evidenceIds, (value) => ID.evidence.test(value))) errors.push('evidenceIds are invalid');
}

function validateFinalSummary(document, errors) {
  if (!['completed', 'blocked', 'degraded'].includes(document.status)) errors.push('status is invalid');
  if (!object(document.counts) || !['bugs', 'automated', 'evidence'].every((key) => Number.isInteger(document.counts[key]) && document.counts[key] >= 0)) errors.push('counts are invalid');
  if (!list(document.sourceSchemas, (value) => /^argus\/[a-z-]+@1$/.test(value))) errors.push('sourceSchemas are invalid');
  if (!string(document.summary) || !ISO(document.generatedAt) || !ID.lane.test(document.owner ?? '')) errors.push('summary, generatedAt, or owner is invalid');
  if (document.coverage !== undefined) {
    const coverage = document.coverage;
    const ratios = ['discoveryCompleteness', 'executionCoverage', 'assertionQuality', 'evidenceQuality'];
    if (!object(coverage) || !string(coverage.resultPath) || !ratios.every((key) => coverage[key] === null || (typeof coverage[key] === 'number' && coverage[key] >= 0 && coverage[key] <= 1)) || !Number.isInteger(coverage.scopedOutcomes) || coverage.scopedOutcomes < 0) errors.push('coverage summary is invalid');
  }
  const runner = document.runner;
  if (!object(runner) || !['baseline', 'defect-evidence', 'candidate-regression', 'full-suite'].includes(runner.mode) || !['pass', 'fail'].includes(runner.status) || ![0, 10, 11, 12, 13, 14, 15].includes(runner.exitCode) || !string(runner.resultPath)) {
    errors.push('runner mode, status, exitCode, or resultPath is invalid');
  } else if (!object(runner.categories) || !['product', 'automation', 'infrastructure', 'skip', 'policy'].every((key) => Number.isInteger(runner.categories[key]) && runner.categories[key] >= 0)) {
    errors.push('runner categories are invalid');
  }
}

function validateCoverageResult(document, errors) {
  if (!object(document.discovery) || !object(document.overall) || !object(document.lanes)) errors.push('discovery, overall, and lanes are required');
  if (!Array.isArray(document.scopedOutcomes) || !object(document.defectOutcomes) || document.defectOutcomes.scoreContribution !== 0) errors.push('scopedOutcomes and defect-neutral outcomes are required');
  if (!list(document.sourceSchemas, (value) => ['argus/surface-inventory@1', 'argus/coverage-observations@1'].includes(value))) errors.push('coverage sourceSchemas are invalid');
  if (!ISO(document.generatedAt)) errors.push('generatedAt is invalid');
}
