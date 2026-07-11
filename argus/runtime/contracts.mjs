import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
]);

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
  throw new Error(`schema compatibility policy does not permit contract version ${CONTRACT_VERSION}`);
}

export function schemaId(kind) {
  if (!CONTRACT_KINDS.includes(kind)) throw new Error(`unknown canonical contract: ${kind}`);
  return `argus/${kind}@${CONTRACT_VERSION}`;
}

export function validateCanonicalDocument(kind, document) {
  if (!CONTRACT_KINDS.includes(kind)) return [`unknown canonical contract: ${kind}`];
  const validate = canonicalValidator(kind);
  return validate(document).map(formatValidationError);
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
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('identity must be a non-empty stable string');
  return createHash('sha256').update(value.trim()).digest('hex');
}

function canonicalValidator(kind) {
  if (!validators.has(kind)) {
    const path = join(SCHEMAS, `${kind}.schema.json`);
    let schema;
    try { schema = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`cannot load canonical schema ${path}: ${error.message}`); }
    validators.set(kind, compileJsonSchema(schema));
  }
  return validators.get(kind);
}

function loadJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`cannot load ${label} ${path}: ${error.message}`); }
}

function formatValidationError(error) {
  const location = error.instancePath || '/';
  return `${location} ${error.message} [${error.keyword} at ${error.schemaPath}]`;
}
