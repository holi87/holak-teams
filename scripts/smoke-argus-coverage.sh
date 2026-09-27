#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/scripts/fixtures/argus-coverage"
CLI="$ROOT/argus/claude/bin/argus-assets"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

for schema in surface-inventory coverage-observations coverage-result; do
  jq empty "$ROOT/argus/schemas/$schema.schema.json"
done

node --input-type=module - "$ROOT" "$FIXTURES" "$TMP" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, fixtures, tmp] = process.argv.slice(2);
const { calculateCoverage, resolveCoverage, validateCoverageObservations, validateCoverageResult, validateSurfaceInventory } = await import(pathToFileURL(`${root}/argus/runtime/coverage.mjs`));
const { reconcileCoverageEvidence } = await import(pathToFileURL(`${root}/argus/runtime/finding-quality.mjs`));
const { validateCanonicalDocument } = await import(pathToFileURL(`${root}/argus/runtime/contracts.mjs`));
const read = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const copy = (value) => structuredClone(value);
const inventory = read('surface-inventory.json');
const observations = read('coverage-observations.json');
const evidence = read('evidence-reference.json');
const ledger = read('bug-ledger.json');
const readArtifact = (source) => readFileSync(join(fixtures, source));
const context = { evidence, ledger, readArtifact };
const errorsOf = (inv, obs, ctx = context) => resolveCoverage(inv, obs, ctx).errors;
const expectError = (errors, pattern, label) => assert(errors.some((error) => pattern.test(error)), `${label}: expected ${pattern} in ${JSON.stringify(errors)}`);
const row = (obs, id) => obs.observations.find((item) => item.observationId === id);
const surfaceOf = (result, id) => result.surfaces.find((item) => item.surfaceId === id);

// The fixtures are canonical and fully reconciled against the retained evidence bytes.
for (const [kind, document] of [['surface-inventory', inventory], ['coverage-observations', observations], ['evidence-reference', evidence], ['bug-ledger', ledger]]) {
  assert.deepEqual(validateCanonicalDocument(kind, document), [], `${kind} fixture is not canonical`);
}
assert.deepEqual(validateSurfaceInventory(inventory), [], 'valid UI/API/event/data inventory rejected');
assert.deepEqual(validateCoverageObservations(observations, inventory), [], 'valid observations rejected');
assert.deepEqual(reconcileCoverageEvidence(inventory, observations, evidence, readArtifact), [], 'fixture evidence did not reconcile');
assert.deepEqual(errorsOf(inventory, observations), [], 'fixture observations did not resolve');

const result = calculateCoverage(inventory, observations, context);
assert.deepEqual(validateCanonicalDocument('coverage-result', result), [], 'calculated result is not a canonical coverage-result@2');
assert.equal(result.$schema, 'argus/coverage-result@2');
assert.deepEqual(result.sourceSchemas, ['argus/surface-inventory@1', 'argus/coverage-observations@2', 'argus/evidence-reference@3', 'argus/bug-ledger@2']);
assert.equal(result.overall.executionCoverage, 0.7143, 'unexpected risk-weighted execution coverage');
assert.equal(result.overall.assertionQuality, 1);
assert.equal(result.overall.evidenceQuality, 1);
assert.equal(result.overall.automatedExecution, 0.5, 'automated execution is not automated weight over executed weight');
assert.deepEqual(result.overall.riskWeight, { denominator: 14, executed: 10, asserted: 10, evidenced: 10, automated: 5 });
assert.equal(result.lanes.api.automatedExecution, 1);
assert.equal(result.lanes.ui.automatedExecution, 0);
assert.equal(result.lanes.events.executionCoverage, 0);
assert.equal(result.lanes.api.caseDepth.coverage, 1, 'the runner-backed API case did not count');
assert.deepEqual(result.criticalUnexecuted, ['SRF-EVENT-ORDER-CREATED'], 'the unexecuted critical surface was not listed');
assert.deepEqual(result.surfaces.map((item) => item.surfaceId), ['SRF-API-ORDERS-POST', 'SRF-DATA-AUDIT', 'SRF-EVENT-ORDER-CREATED', 'SRF-UI-CHECKOUT']);
assert.deepEqual(surfaceOf(result, 'SRF-API-ORDERS-POST'), { surfaceId: 'SRF-API-ORDERS-POST', lane: 'api', risk: 'critical', riskWeight: 5, accessibility: 'testable', executed: true, asserted: true, evidenced: true, automated: true, defectIds: ['BUG-0001'] });
assert.deepEqual(surfaceOf(result, 'SRF-UI-CHECKOUT'), { surfaceId: 'SRF-UI-CHECKOUT', lane: 'ui', risk: 'critical', riskWeight: 5, accessibility: 'testable', executed: true, asserted: true, evidenced: true, automated: false, defectIds: [] });
assert.equal(surfaceOf(result, 'SRF-EVENT-ORDER-CREATED').executed, false, 'an observation without executions counted as executed');
assert.deepEqual(result.scopedOutcomes.map((item) => item.surfaceId), ['SRF-DATA-AUDIT'], 'inaccessible data surface was hidden');
assert.deepEqual(result.defectOutcomes, { confirmed: 1, suspected: 1, needsOracle: 1, duplicate: 1, rejected: 1, headline: 2, linked: 1, unlinked: ['BUG-0002'], scoreContribution: 0 }, 'defect outcomes do not follow the ledger statuses');
writeFileSync(`${tmp}/result.json`, `${JSON.stringify(result, null, 2)}\n`);

// Execution and assertion quality cannot be self-declared.
const declared = copy(observations);
Object.assign(declared.observations[3], { executed: true, assertions: [{ id: 'AST-EVT', oracleId: 'ORC-EVT', meaningful: true }] });
assert(validateCanonicalDocument('coverage-observations', declared).length > 0, 'self-declared executed/meaningful flags were accepted');
const mismatch = copy(observations); row(mismatch, 'orion:SRF-UI-CHECKOUT').lane = 'perseus';
expectError(validateCoverageObservations(mismatch, inventory), /orion:SRF-UI-CHECKOUT: observationId must equal <lane>:<surfaceId>/, 'observationId mismatch');
const overlap = copy(observations); row(overlap, 'orion:SRF-UI-CHECKOUT').assertions[0].controlEvidenceIds = ['EVD-0101'];
expectError(validateCoverageObservations(overlap, inventory), /control evidence must be distinct/, 'shared assertion and control evidence');
const repeatedCase = copy(observations); row(repeatedCase, 'atalanta:SRF-API-ORDERS-POST').cases = [row(repeatedCase, 'atlas:SRF-API-ORDERS-POST').cases[0]];
expectError(validateCoverageObservations(repeatedCase, inventory), /duplicate case observation: CASE-API-ORDER-CREATE/, 'an obligation observed twice');

// Every execution must resolve to registered evidence that proves this surface ran.
const withExecution = (execution, id = 'orion:SRF-UI-CHECKOUT') => { const next = copy(observations); row(next, id).executions = [execution]; return next; };
expectError(errorsOf(inventory, withExecution({ evidenceId: 'EVD-0999' })), /orion:SRF-UI-CHECKOUT: execution EVD-0999 is not in the evidence registry/, 'unregistered evidence');
expectError(errorsOf(inventory, withExecution({ evidenceId: 'EVD-0001' })), /EVD-0001 is text evidence, which never proves execution/, 'text-kind execution');
expectError(errorsOf(inventory, withExecution({ evidenceId: 'EVD-0104', caseId: 'ui:checkout.spec.ts:webkit-checkout' })), /EVD-0104 has no executed product or automation case ui:checkout\.spec\.ts:webkit-checkout/, 'skipped runner case');
expectError(errorsOf(inventory, withExecution({ evidenceId: 'EVD-0104' })), /EVD-0104 is a runner result and requires a caseId/, 'runner result without caseId');
expectError(errorsOf(inventory, withExecution({ evidenceId: 'EVD-0101', caseId: 'ui:checkout' })), /EVD-0101 is dom-snapshot evidence and must not carry a caseId/, 'caseId on a capture');
const unnamed = copy(evidence); unnamed.references.find((ref) => ref.id === 'EVD-0101').relatedSurfaceIds = [];
expectError(errorsOf(inventory, observations, { ...context, evidence: unnamed }), /EVD-0101 does not name SRF-UI-CHECKOUT in relatedSurfaceIds/, 'missing relatedSurfaceIds');
const discovered = copy(inventory); discovered.items[0].discoveryEvidenceIds = ['EVD-0001', 'EVD-0101'];
expectError(errorsOf(discovered, observations), /EVD-0101 is discovery evidence for SRF-UI-CHECKOUT/, 'discovery evidence as execution');
expectError(errorsOf(inventory, observations, { ...context, evidence: null }), /^coverage evidence registry required$/, 'citations without a registry');
expectError(errorsOf(inventory, observations, { ...context, readArtifact: null }), /runner-result evidence requires an artifact reader/, 'runner result without a reader');
assert.throws(() => calculateCoverage(inventory, withExecution({ evidenceId: 'EVD-0001' }), context), /never proves execution/, 'calculateCoverage did not fail closed');
const foreign = copy(evidence); foreign.engagementId = 'other-engagement';
expectError(errorsOf(inventory, observations, { ...context, evidence: foreign }), /evidence engagementId does not match/, 'foreign evidence registry');

// Assertion quality needs distinct control evidence; automation needs the delivery gate.
const uncontrolled = copy(observations); row(uncontrolled, 'orion:SRF-UI-CHECKOUT').assertions[0].controlEvidenceIds = [];
const uncontrolledResult = calculateCoverage(inventory, uncontrolled, context);
assert.equal(uncontrolledResult.overall.assertionQuality, 0.5, 'an assertion without control evidence kept assertion quality');
assert.equal(surfaceOf(uncontrolledResult, 'SRF-UI-CHECKOUT').asserted, false);
assert.equal(uncontrolledResult.overall.executionCoverage, result.overall.executionCoverage, 'assertion quality changed execution coverage');
const nonGate = (source) => {
  const bytes = readArtifact(source);
  return source.endsWith('runner-full-suite.json') ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes), deliveryGate: false })) : bytes;
};
const runnerOnly = copy(observations);
runnerOnly.observations = runnerOnly.observations.filter((item) => item.observationId !== 'atalanta:SRF-API-ORDERS-POST');
assert.equal(surfaceOf(calculateCoverage(inventory, runnerOnly, context), 'SRF-API-ORDERS-POST').automated, true, 'a delivery-gate runner case did not count as automated');
const nonGateResult = calculateCoverage(inventory, runnerOnly, { ...context, readArtifact: nonGate });
assert.equal(nonGateResult.overall.automatedExecution, 0, 'a non-delivery-gate runner result counted as automated execution');
assert.equal(surfaceOf(nonGateResult, 'SRF-API-ORDERS-POST').executed, true, 'a non-delivery-gate runner case stopped proving execution');

// The critical list follows derived execution, not a declaration.
const eventRegistry = copy(evidence);
eventRegistry.references.push({ ...eventRegistry.references.find((ref) => ref.id === 'EVD-0103'), id: 'EVD-0105', relatedSurfaceIds: ['SRF-EVENT-ORDER-CREATED'] });
const eventRun = withExecution({ evidenceId: 'EVD-0105' }, 'proteus:SRF-EVENT-ORDER-CREATED');
const eventResult = calculateCoverage(inventory, eventRun, { ...context, evidence: eventRegistry });
assert.deepEqual(eventResult.criticalUnexecuted, [], 'an executed critical surface stayed listed');
assert.equal(eventResult.overall.executionCoverage, 1);
const highEvent = copy(inventory); highEvent.items[2].risk = 'high';
assert.deepEqual(calculateCoverage(highEvent, observations, context).criticalUnexecuted, [], 'a non-critical unexecuted surface was listed as critical');
const scopedCritical = copy(inventory); scopedCritical.items[3].risk = 'critical';
assert.deepEqual(calculateCoverage(scopedCritical, observations, context).criticalUnexecuted, ['SRF-EVENT-ORDER-CREATED'], 'a scoped critical surface was listed as unexecuted');

// Cases run only on executed surfaces, and a cited runner case must agree with the outcome.
const failedCase = copy(observations); row(failedCase, 'atlas:SRF-API-ORDERS-POST').cases[0].outcome = 'failed';
expectError(errorsOf(inventory, failedCase), /runner outcome pass does not match case outcome failed/, 'runner outcome mismatch');
const orphanCase = copy(observations);
orphanCase.observations = orphanCase.observations.filter((item) => item.observationId !== 'atalanta:SRF-API-ORDERS-POST');
row(orphanCase, 'atlas:SRF-API-ORDERS-POST').executions = [];
delete row(orphanCase, 'atlas:SRF-API-ORDERS-POST').cases[0].execution;
expectError(errorsOf(inventory, orphanCase), /CASE-API-ORDER-CREATE: executed case on an unexecuted surface/, 'passed case on an unexecuted surface');
const blockedCase = copy(orphanCase);
Object.assign(row(blockedCase, 'atlas:SRF-API-ORDERS-POST').cases[0], { outcome: 'blocked', reason: 'Payment sandbox unavailable' });
const blockedDepth = calculateCoverage(inventory, blockedCase, context).lanes.api.caseDepth;
assert.deepEqual([blockedDepth.executedWeight, blockedDepth.gaps], [0, [{ obligationId: 'CASE-API-ORDER-CREATE', reason: 'Payment sandbox unavailable' }]]);

// Defect outcomes come only from the ledger and never move a coverage metric.
const metrics = (value) => ['executionCoverage', 'assertionQuality', 'evidenceQuality', 'automatedExecution'].map((metric) => value.overall[metric]);
const refless = copy(observations); refless.observations.forEach((item) => { item.defectRefs = []; });
const noLedger = calculateCoverage(inventory, refless, { ...context, ledger: null });
assert.deepEqual(metrics(noLedger), metrics(result), 'the ledger changed coverage metrics');
assert.deepEqual(noLedger.defectOutcomes, { confirmed: 0, suspected: 0, needsOracle: 0, duplicate: 0, rejected: 0, headline: 0, linked: 0, unlinked: [], scoreContribution: 0 });
assert.deepEqual(noLedger.sourceSchemas, ['argus/surface-inventory@1', 'argus/coverage-observations@2', 'argus/evidence-reference@3']);
const retriaged = copy(ledger);
retriaged.bugs[1] = { ...retriaged.bugs[1], status: 'rejected', rejection: { reason: 'out-of-scope', rationale: 'Retriaged', evidenceIds: [] } };
delete retriaged.bugs[1].missingProof;
const retriagedResult = calculateCoverage(inventory, observations, { ...context, ledger: retriaged });
assert.deepEqual(metrics(retriagedResult), metrics(result), 'a ledger status change moved coverage metrics');
assert.deepEqual([retriagedResult.defectOutcomes.suspected, retriagedResult.defectOutcomes.rejected, retriagedResult.defectOutcomes.headline, retriagedResult.defectOutcomes.unlinked], [0, 2, 1, []]);
expectError(errorsOf(inventory, observations, { ...context, ledger: null }), /atalanta:SRF-API-ORDERS-POST: defect reference ATA-001 requires the canonical bug ledger/, 'defect references without a ledger');
const unknownRef = copy(observations); row(unknownRef, 'orion:SRF-UI-CHECKOUT').defectRefs = ['ORI-999'];
expectError(errorsOf(inventory, unknownRef), /orion:SRF-UI-CHECKOUT: unknown defect reference ORI-999/, 'unknown defect reference');
const linkedRefs = copy(observations); row(linkedRefs, 'orion:SRF-UI-CHECKOUT').defectRefs = ['ORI-002'];
const linkedResult = calculateCoverage(inventory, linkedRefs, context);
assert.deepEqual([surfaceOf(linkedResult, 'SRF-UI-CHECKOUT').defectIds, linkedResult.defectOutcomes.linked, linkedResult.defectOutcomes.unlinked], [['BUG-0002'], 2, []], 'an origin alias did not resolve to its ledger row');

// Denominators scale with the target's own inventory.
const small = copy(inventory);
small.items = small.items.slice(0, 1); small.discovery = { candidates: 1, characterized: 1 };
const smallObservations = copy(observations); smallObservations.observations = [row(smallObservations, 'orion:SRF-UI-CHECKOUT')];
assert.equal(calculateCoverage(small, smallObservations, context).overall.executionCoverage, 1, 'small target did not scale to its own denominator');
const large = copy(inventory);
for (let i = 0; i < 20; i += 1) large.items.push({ ...large.items[2], id: `SRF-EVENT-EXTRA-${i}`, risk: 'high' });
large.discovery = { candidates: 25, characterized: 24 };
assert(calculateCoverage(large, observations, context).overall.executionCoverage < result.overall.executionCoverage, 'large uncovered surface did not expand the denominator');
const invalid = copy(inventory); invalid.items.push({ ...invalid.items[0] });
assert(validateSurfaceInventory(invalid).some((error) => error.includes('duplicate surface id')), 'duplicate surface accepted');

// Retained bytes are integrity-checked at reconciliation, and a result cannot be hand-tuned.
const drifted = (source) => (source.endsWith('discovery-crawl.txt') ? Buffer.from('changed') : readArtifact(source));
expectError(reconcileCoverageEvidence(inventory, observations, evidence, drifted), /SRF-UI-CHECKOUT: discovery evidence: evidence digest drift EVD-0001/, 'discovery evidence drift');
expectError(reconcileCoverageEvidence(inventory, withExecution({ evidenceId: 'EVD-0999' }), evidence, readArtifact), /orion:SRF-UI-CHECKOUT: execution: unresolved evidence EVD-0999/, 'unresolved execution evidence');
const tuned = copy(result); tuned.criticalUnexecuted = []; tuned.defectOutcomes.headline = 3;
expectError(validateCoverageResult(tuned), /criticalUnexecuted must list exactly/, 'hidden critical surface');
expectError(validateCoverageResult(tuned), /headline must equal confirmed \+ suspected/, 'inflated headline');
NODE

node "$ROOT/scripts/sync-argus-runtime-assets.mjs" --write >/dev/null
COVERAGE_ARGS=(--inventory "$FIXTURES/surface-inventory.json" --observations "$FIXTURES/coverage-observations.json"
  --evidence "$FIXTURES/evidence-reference.json" --ledger "$FIXTURES/bug-ledger.json" --root "$FIXTURES")
"$CLI" coverage validate "${COVERAGE_ARGS[@]}" >/dev/null
"$CLI" coverage calculate "${COVERAGE_ARGS[@]}" --output "$TMP/cli-result.json" >/dev/null
jq -S 'del(.generatedAt)' "$TMP/result.json" >"$TMP/runtime-normalized.json"
jq -S 'del(.generatedAt)' "$TMP/cli-result.json" >"$TMP/cli-normalized.json"
cmp "$TMP/runtime-normalized.json" "$TMP/cli-normalized.json" >/dev/null || fail 'runtime and CLI coverage results differ'

# Without a registry the CLI refuses to credit any cited execution.
if "$CLI" coverage validate --inventory "$FIXTURES/surface-inventory.json" --observations "$FIXTURES/coverage-observations.json" \
  --ledger "$FIXTURES/bug-ledger.json" --root "$FIXTURES" >/dev/null 2>"$TMP/no-registry.err"; then
  fail 'coverage validate accepted cited evidence without a registry'
fi
grep -Fq 'coverage evidence registry required' "$TMP/no-registry.err" || fail "missing registry failed for another reason: $(<"$TMP/no-registry.err")"

# Evidence sources stay inside --root: no absolute path, no '..', and no symbolic-link escape.
cp -R "$FIXTURES" "$TMP/root"
printf 'outside\n' >"$TMP/outside.json"
rm "$TMP/root/reports/evidence/runner-full-suite.json"
ln -s "$TMP/outside.json" "$TMP/root/reports/evidence/runner-full-suite.json"
if "$CLI" coverage calculate "${COVERAGE_ARGS[@]:0:8}" --root "$TMP/root" >/dev/null 2>"$TMP/escape.err"; then
  fail 'coverage calculate followed a symbolic link out of --root'
fi
grep -Fq 'escapes --root through a symbolic link' "$TMP/escape.err" || fail "symbolic-link escape failed for another reason: $(<"$TMP/escape.err")"
jq '(.references[] | select(.id == "EVD-0103") | .source) = "reports/../reports/evidence/control-wrong-total.log"' "$FIXTURES/evidence-reference.json" >"$TMP/dotdot-registry.json"
if "$CLI" coverage validate --inventory "$FIXTURES/surface-inventory.json" --observations "$FIXTURES/coverage-observations.json" \
  --evidence "$TMP/dotdot-registry.json" --ledger "$FIXTURES/bug-ledger.json" --root "$FIXTURES" >/dev/null 2>"$TMP/dotdot.err"; then
  fail "coverage validate read an evidence source with a '..' segment"
fi
grep -Fq 'missing or unsafe evidence EVD-0103' "$TMP/dotdot.err" || fail "'..' evidence source failed for another reason: $(<"$TMP/dotdot.err")"

printf 'PASS  evidence-derived UI/API/event/data coverage: resolved executions, controlled assertions, delivery-gate automation, critical unexecuted surfaces, ledger-derived defect outcomes, proportional denominators, and CLI parity\n'
