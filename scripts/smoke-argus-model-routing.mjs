#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as signSignature } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildModelRoutingPreview,
  buildModelTelemetryEvent,
  controllerTurnBudget,
  modelAuthenticatedDocumentSha256,
  modelAuthenticationPayload,
  modelDecisionIntegritySha256,
  modelPublicKeyFingerprint,
  resolveModelDecision,
  roleModelConfig,
  validateModelDecisionBinding,
  validateModelPolicy,
} from '../argus/runtime/model-policy.mjs';
import { compileJsonSchema } from '../argus/runtime/json-schema.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = readJson('argus/model-policy.json');
const adapters = readJson('argus/runtime-adapters.json');
const benchmark = readJson('argus/model-policy.benchmark.json');
const validatePolicySchema = compileJsonSchema(readJson('argus/schemas/model-policy.schema.json'));
const validateAdapters = compileJsonSchema(readJson('argus/schemas/runtime-adapters.schema.json'));
const validateBenchmark = compileJsonSchema(readJson('argus/schemas/model-policy-benchmark.schema.json'));
const validateDecision = compileJsonSchema(readJson('argus/schemas/model-decision.schema.json'));
const validateTelemetry = compileJsonSchema(readJson('argus/schemas/model-telemetry-event.schema.json'));
const context = {
  engagementId: 'engagement-routing-smoke',
  engagementManifestSha256: 'a'.repeat(64),
  dispatchId: 'dispatch-aegis-001',
  attempt: 1,
  createdAt: '2026-07-12T12:00:00.000Z',
};

const runtimeKeys = generateKeyPairSync('ed25519');
const operatorKeys = generateKeyPairSync('ed25519');
const runtimePem = runtimeKeys.publicKey.export({ type: 'spki', format: 'pem' });
const operatorPem = operatorKeys.publicKey.export({ type: 'spki', format: 'pem' });
const modelTrust = {
  schema: 'argus/model-trust-bundle@1',
  source: 'host-trust-store',
  trustStoreSha256: 'd'.repeat(64),
  pinnedAt: '2026-07-12T11:50:00.000Z',
  keys: {
    runtimeAttestation: {
      keyId: 'routing-runtime-key', purpose: 'runtime-attestation', subjectId: 'argus-runtime-wrapper', algorithm: 'Ed25519',
      publicKeyPem: runtimePem, keyFingerprintSha256: modelPublicKeyFingerprint(runtimePem),
    },
    operatorApproval: {
      keyId: 'routing-operator-key', purpose: 'operator-approval', subjectId: 'routing-unit-operator', algorithm: 'Ed25519',
      publicKeyPem: operatorPem, keyFingerprintSha256: modelPublicKeyFingerprint(operatorPem),
    },
  },
};

assert(validateModelPolicy(policy, policy.roles.map(({ slug }) => slug)).length === 0, 'model policy is invalid');
assert(validatePolicySchema(policy).length === 0, 'model policy violates its schema');
assert(validateAdapters(adapters).length === 0, 'runtime adapter snapshot is invalid');
assert(validateBenchmark(benchmark).length === 0, 'model benchmark is invalid');
const derivedCounts = tierCounts(policy);
assert(policy.baseline.frontierRoles === derivedCounts.frontier && policy.baseline.standardRoles === derivedCounts.standard, 'baseline counts differ from the role tiers');
assert(policy.baseline.decision === `adopt-${derivedCounts.frontier}-frontier-${derivedCounts.standard}-standard`, 'baseline decision differs from the derived role tiers');
assert(policy.tiers.frontier.codex.model === 'gpt-6-sol' && policy.tiers.standard.codex.model === 'gpt-6-sol', 'Codex tier mapping drifted');
assert(policy.tiers.frontier.claude.model === 'claude-opus-5-5' && policy.tiers.standard.claude.model === 'claude-sonnet-5-5', 'Claude tier mapping drifted');

// Every complete role has one reviewed profile in both runtimes. Tier defaults
// must never erase the high-effort profiles during preview or dispatch.
const expectedProfileGroups = [
  ['critical', 'frontier', 'claude-opus-5-5', 'max', 'xhigh', ['odysseus', 'metis', 'minos', 'aristarchus']],
  ['frontier-high', 'frontier', 'claude-opus-5-5', 'high', 'high', ['ariadne', 'perseus', 'tyche', 'tiresias', 'atlas', 'kalchas', 'kleio']],
  ['standard-high', 'standard', 'claude-sonnet-5-5', 'high', 'high', ['antigone', 'atalanta', 'charon', 'hermes', 'lynceus', 'orion', 'proteus', 'nike', 'asklepios']],
  ['standard-medium', 'standard', 'claude-sonnet-5-5', 'medium', 'medium', ['aegis', 'daidalos', 'mnemosyne', 'talos', 'penelope', 'pistis', 'theseus']],
];
const profiledRoles = new Set();
for (const [executionProfile, tier, claudeModel, claudeEffort, codexEffort, slugs] of expectedProfileGroups) {
  for (const slug of slugs) {
    assert(!profiledRoles.has(slug), `${slug}: duplicate profile test assignment`);
    profiledRoles.add(slug);
    const role = policy.roles.find((item) => item.slug === slug);
    assert(role.executionProfile === executionProfile && role.tier === tier, `${slug}: reviewed profile assignment drifted`);
    for (const [runtime, model, effort] of [['claude', claudeModel, claudeEffort], ['codex', 'gpt-6-sol', codexEffort]]) {
      const expected = { tier, model, effort, maxTurns: role.maxTurns };
      const config = roleModelConfig(policy, role, runtime);
      const preview = buildModelRoutingPreview(policy, adapters, { slug, runtime });
      const decision = decide(adapters, { slug, runtime, signal: 'normal' });
      assert(stable(config) === stable(expected) && stable(preview.baselineConfig) === stable(expected) &&
        stable(decision.selectedConfig) === stable(expected), `${slug}/${runtime}: baseline resolver, preview, or dispatch lost the profile`);
    }
  }
}
assert(profiledRoles.size === 27 && derivedCounts.frontier === 11 && derivedCounts.standard === 16, 'reviewed model allocation is not 11 frontier and 16 standard roles');
assert(policy.tiers.mechanical.claude.model === 'claude-haiku-4-5-20251001' &&
  !Object.hasOwn(policy.tiers.mechanical.claude, 'effort') && policy.tiers.mechanical.codex.model === 'gpt-6-luna',
  'dormant helper models are unpinned or Haiku has an unsupported effort parameter');
assert(decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'schema-validated-mechanical' }).reasonCode === 'MECHANICAL_FULL_ROLE_FORBIDDEN',
  'a validated schema silently enabled a complete mechanical role');
const missingProfile = structuredClone(policy);
delete missingProfile.roles.find(({ slug }) => slug === 'orion').executionProfile;
assertPolicyRejected(missingProfile, 'executionProfile must be the reviewed', 'a missing role execution profile was accepted');
assert(validatePolicySchema(missingProfile).length > 0, 'schema accepted a missing role execution profile');
assertThrows(() => roleModelConfig(missingProfile, 'orion', 'claude'), 'missing profile silently fell back to a tier default');
const weakerProfile = structuredClone(policy);
weakerProfile.executionProfiles['standard-high'].codex.model = 'gpt-6-luna';
assertPolicyRejected(weakerProfile, 'execution profiles differ', 'a full-role Luna downgrade was accepted');
assert(validatePolicySchema(weakerProfile).length > 0, 'schema accepted a full-role Luna model');
const loweredCritical = structuredClone(policy);
loweredCritical.roles.find(({ slug }) => slug === 'minos').executionProfile = 'frontier-high';
assertPolicyRejected(loweredCritical, 'executionProfile must be the reviewed critical', 'critical adjudication silently lost its effort floor');
const astraBaseline = structuredClone(policy);
astraBaseline.roles.find(({ slug }) => slug === 'minos').executionProfile = 'astra-reasoning';
assertPolicyRejected(astraBaseline, 'executionProfile must be the reviewed critical', 'Astra became a complete-role baseline');
assertThrows(() => roleModelConfig(astraBaseline, 'minos', 'codex'), 'baseline helper accepted the escalation-only Astra profile');
for (const mutate of [
  (value) => { value.routing.codexReasoningEscalation.signals.push('turn-limit'); },
  (value) => { value.routing.codexReasoningEscalation.maxTurns = 81; },
]) {
  const invalid = structuredClone(policy);
  mutate(invalid);
  assertPolicyRejected(invalid, 'codexReasoningEscalation must bind', 'unbounded or non-reasoning Astra escalation was accepted');
  assert(validatePolicySchema(invalid).length > 0, 'schema accepted an invalid Astra escalation');
}

// The controller turn budget binds the native launch cap and its closeout reserve.
const controllerBudget = controllerTurnBudget(policy);
assert(stable(controllerBudget) === stable({ agent: 'odysseus', maxTurns: 400, closeoutReserveTurns: 30 }), `controller turn budget drifted: ${stable(controllerBudget)}`);
const shortController = structuredClone(policy);
shortController.roles.find(({ slug }) => slug === 'odysseus').maxTurns = 299;
assertPolicyRejected(shortController, 'controller maxTurns must be at least 300', 'a controller cap below 300 turns was accepted');
const oversizedReserve = structuredClone(policy);
oversizedReserve.controllerBudget.closeoutReserveTurns = 101;
assertPolicyRejected(oversizedReserve, 'closeoutReserveTurns must be an integer from 10 to floor(maxTurns/4)=100', 'a closeout reserve above a quarter of the cap was accepted');
assert(validatePolicySchema(oversizedReserve).length > 0, 'model policy schema accepted a closeout reserve above 100');
const missingBudget = structuredClone(policy);
delete missingBudget.controllerBudget;
assertPolicyRejected(missingBudget, 'controllerBudget is required', 'a policy without a controller budget was accepted');
assert(validatePolicySchema(missingBudget).length > 0, 'model policy schema accepted a missing controller budget');
assertThrows(() => controllerTurnBudget(missingBudget), 'controllerTurnBudget resolved a policy without a controller budget');

const claudePreview = buildModelRoutingPreview(policy, adapters, { slug: 'aegis', runtime: 'claude' });
assert(claudePreview.status === 'ready' && claudePreview.missingCapabilities.length === 0, 'native Claude baseline is not ready');
const codexPreview = buildModelRoutingPreview(policy, adapters, { slug: 'aegis', runtime: 'codex' });
assert(codexPreview.status === 'blocked' && same(codexPreview.missingCapabilities, ['maxTurns']), 'Codex preview did not fail closed on native maxTurns');

const claude = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'normal' });
assert(claude.status === 'selected' && claude.reasonCode === 'BASELINE_SELECTED', 'Claude baseline was not selected');
assert(same(claude.requiredEnforcements, ['model', 'effort', 'maxTurns']), 'Claude baseline has incomplete enforcement');
const codex = decide(adapters, { slug: 'aegis', runtime: 'codex', signal: 'normal' });
assert(codex.status === 'blocked' && codex.reasonCode === 'CAPABILITY_DRIFT', 'Codex route did not fail closed');
assert(same(codex.missingCapabilities, ['maxTurns']), 'Codex route reported the wrong missing capability');
const ignoredRetiredClaim = resolveModelDecision(policy, adapters, { ...context, slug: 'aegis', runtime: 'codex', signal: 'normal', runtimeAttestation: {} });
assert(ignoredRetiredClaim.status === 'blocked' && !Object.hasOwn(ignoredRetiredClaim, 'runtimeAttestation'), 'retired runtime attestation changed routing');

// Standard baselines remain allowlisted and upward-only; every supported baseline
// still requires native model, effort, and turn-cap enforcement.
const standardAegis = withStandardRole(policy, 'aegis', 'Synthetic routing fixture for the upward-only standard path.');
const standardAegisErrors = [...validateModelPolicy(standardAegis, slugsOf(standardAegis)), ...validatePolicySchema(standardAegis).map((error) => JSON.stringify(error))];
assert(standardAegisErrors.length === 0, `allowlisted standard fixture is invalid: ${standardAegisErrors.join('; ')}`);
const claudeEscalation = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'safety' }, standardAegis);
assert(claudeEscalation.status === 'blocked' && same(claudeEscalation.missingCapabilities, ['effort']), 'Claude escalation hid its missing effort override');
const highClaudeEscalation = decide(adapters, { slug: 'orion', runtime: 'claude', signal: 'safety', attempt: 2, escalationBinding: escalationBinding() });
assert(highClaudeEscalation.status === 'selected' && highClaudeEscalation.selectedConfig.model === 'claude-opus-5-5' &&
  highClaudeEscalation.selectedConfig.effort === 'high' && same(highClaudeEscalation.requiredOverrides, ['model']) &&
  highClaudeEscalation.selectedConfig.maxTurns === highClaudeEscalation.baselineConfig.maxTurns,
  'Claude model-only escalation did not preserve the native high effort and role turn cap');
assert(adapters.claude.routingCapabilities.escalation.effort === false, 'derived unchanged-effort enforcement mutated the adapter override claim');
const unattestedHighEscalation = decide(adapters, {
  slug: 'orion', runtime: 'claude', signal: 'safety', attempt: 2, escalationBinding: escalationBinding(), trust: 'unattested',
});
assert(unattestedHighEscalation.status === 'blocked' && unattestedHighEscalation.reasonCode === 'CAPABILITY_DRIFT' &&
  same(unattestedHighEscalation.missingCapabilities, ['model']) && unattestedHighEscalation.continuation === null,
  'unattested Claude advertised a model override without authenticated alias pins');
assert(decide(adapters, { slug: 'orion', runtime: 'claude', signal: 'normal', trust: 'unattested' }).status === 'selected',
  'unattested full-ID baseline was incorrectly blocked with model overrides');
const noBaselineEffort = structuredClone(adapters);
noBaselineEffort.claude.routingCapabilities.baseline.effort = false;
assert(decide(noBaselineEffort, { slug: 'orion', runtime: 'claude', signal: 'safety' }).reasonCode === 'CAPABILITY_DRIFT',
  'Claude inferred unchanged effort without native baseline enforcement');
assert(decide(adapters, { slug: 'orion', runtime: 'codex', signal: 'safety' }).reasonCode === 'CAPABILITY_DRIFT',
  'Codex inherited the Claude-only unchanged-effort capability');
// Once attempt 2 uses Opus, another standard-tier branch must not allocate a
// fresh full cap forever under the name of upward escalation.
for (const signal of ['turn-limit', 'repeated-failure', 'safety', 'cross-lane', 'oracle-ambiguity']) {
  const repeat = decide(adapters, { slug: 'orion', runtime: 'claude', signal, attempt: 3, escalationBinding: escalationBinding() });
  assert(repeat.status === 'blocked' && repeat.reasonCode === 'AUTO_CONTINUATION_EXHAUSTED' &&
    repeat.selectedConfig.model === 'claude-opus-5-5' && repeat.continuation === null && repeat.operatorEscalation === false,
    `${signal}: an already escalated standard role renewed its budget or silently downgraded`);
}
const repeatUnavailable = decide(adapters, { slug: 'orion', runtime: 'claude', signal: 'model-unavailable', attempt: 3, availabilityBinding: availabilityBinding(1) });
assert(repeatUnavailable.reasonCode === 'AUTO_CONTINUATION_EXHAUSTED', 'repeated standard unavailability renewed the frontier allocation');
for (const maxEscalations of [undefined, 0, 2]) {
  const invalid = structuredClone(policy);
  if (maxEscalations === undefined) delete invalid.fallbackPolicies['upward-only'].maxEscalations;
  else invalid.fallbackPolicies['upward-only'].maxEscalations = maxEscalations;
  assertPolicyRejected(invalid, 'upward-only must allow exactly one', 'an absent or changed standard escalation cap was accepted');
  assert(validatePolicySchema(invalid).length > 0, 'schema accepted an absent or changed standard escalation cap');
}
const frontierMinos = decide(adapters, { slug: 'minos', runtime: 'claude', signal: 'safety' });
assert(frontierMinos.status === 'blocked' && frontierMinos.reasonCode === 'OPERATOR_ESCALATION_REQUIRED', 'committed frontier minos escalation bypassed the operator');

const unlisted = withStandardRole(policy, 'aegis', null);
assertPolicyRejected(unlisted, 'standardAllowlist', 'standard role without an allowlist entry was accepted');
const standardMinos = withStandardRole(policy, 'minos', 'Synthetic fixture that must never lower a judgment role.');
assertPolicyRejected(standardMinos, 'require the frontier tier', 'judgment role on the standard tier was accepted');
const offByOne = structuredClone(policy);
offByOne.baseline.frontierRoles -= 1;
offByOne.baseline.standardRoles += 1;
assertPolicyRejected(offByOne, 'baseline counts must equal the role tiers', 'baseline counts off by one were accepted');
const wrongDecision = structuredClone(policy);
wrongDecision.baseline.decision = `adopt-${derivedCounts.frontier - 1}-frontier-${derivedCounts.standard + 1}-standard`;
assertPolicyRejected(wrongDecision, 'baseline decision must be', 'a decision string that differs from the role tiers was accepted');
const full = structuredClone(adapters);
for (const runtime of ['claude', 'codex']) for (const mode of ['baseline', 'escalation']) for (const field of ['model', 'effort', 'maxTurns']) full[runtime].routingCapabilities[mode][field] = true;
// Even a stronger model on the same quality tier must take the escalation
// adapter. Current Codex cannot dispatch it, including after signed approval.
const astraRoute = { slug: 'ariadne', runtime: 'codex', signal: 'ambiguity', attempt: 2, escalationBinding: escalationBinding() };
const astraPending = decide(adapters, astraRoute);
assertOperatorGate(astraPending, 'OPERATOR_ESCALATION_REQUIRED', 'Astra frontier reasoning before operator approval');
assert(astraPending.selectedConfig.model === 'gpt-6-astra' && astraPending.selectedConfig.effort === 'high' &&
  astraPending.selectedConfig.maxTurns === 80 && astraPending.adapter.mode === 'escalation',
  'Astra did not use the bounded escalation profile');
const astraBlocked = decide(adapters, { ...astraRoute, operatorDecision: operatorDecisionBinding(astraPending, 'continue-frontier') });
assert(astraBlocked.status === 'blocked' && astraBlocked.reasonCode === 'CAPABILITY_DRIFT' &&
  same(astraBlocked.missingCapabilities, ['effort', 'maxTurns', 'model']), 'operator approval fabricated Codex native Astra enforcement');
const astraSupportedPending = decide(full, astraRoute);
const astraSupported = decide(full, { ...astraRoute, operatorDecision: operatorDecisionBinding(astraSupportedPending, 'continue-frontier') });
assert(astraSupported.status === 'selected' && astraSupported.selectedConfig.maxTurns === 80 && astraSupported.continuation === null,
  'a hypothetical fully enforced Astra route did not retain its bound');
for (const retry of [
  { signal: 'ambiguity', escalationBinding: escalationBinding() },
  { signal: 'turn-limit', escalationBinding: escalationBinding() },
  { signal: 'repeated-failure', escalationBinding: escalationBinding() },
  { signal: 'model-unavailable', availabilityBinding: availabilityBinding(1) },
  { signal: 'no-artifact', outcomeBinding: outcomeBinding(0) },
]) {
  const afterAstra = decide(full, { slug: 'ariadne', runtime: 'codex', attempt: 3, ...retry });
  assert(afterAstra.status === 'blocked' && afterAstra.reasonCode === 'AUTO_CONTINUATION_EXHAUSTED' &&
    afterAstra.continuation === null && afterAstra.operatorEscalation === false,
    `${retry.signal}: Codex repeated an escalation or lost the prior Astra profile without authenticated context`);
}
for (const [snapshot, decision] of [[adapters, highClaudeEscalation], [adapters, astraBlocked], [full, astraSupported]]) {
  const errors = validateModelDecisionBinding(policy, snapshot, decision, {
    engagementId: context.engagementId, engagementManifestSha256: context.engagementManifestSha256, modelTrust,
  });
  assert(errors.length === 0, `${decision.agent}/${decision.runtime}: escalation profile binding failed: ${errors.join('; ')}`);
}
const unboundAstra = decide(full, { slug: 'ariadne', runtime: 'codex', signal: 'ambiguity', attempt: 2 });
assert(unboundAstra.selectedConfig.model === 'gpt-6-sol', 'Astra routed without an exact checkpoint binding');
for (const signal of ['safety', 'turn-limit', 'repeated-failure']) {
  const ordinary = decide(full, { ...astraRoute, signal });
  assert(ordinary.selectedConfig.model === 'gpt-6-sol', `${signal}: routine continuation or safety gate silently selected Astra`);
}
const frontierPending = decide(full, { slug: 'ariadne', runtime: 'claude', signal: 'safety' });
assert(frontierPending.status === 'blocked' && frontierPending.reasonCode === 'OPERATOR_ESCALATION_REQUIRED', 'frontier escalation bypassed the operator');
const approved = decide(full, {
  slug: 'ariadne', runtime: 'claude', signal: 'safety', operatorDecision: operatorDecisionBinding(frontierPending, 'continue-frontier'),
});
assert(approved.status === 'selected' && approved.reasonCode === 'OPERATOR_APPROVAL_SELECTED', 'signed operator continuation was not selected');
const bindingErrors = validateModelDecisionBinding(policy, full, approved, {
  engagementId: context.engagementId,
  engagementManifestSha256: context.engagementManifestSha256,
  modelTrust,
});
assert(bindingErrors.length === 0, `valid operator decision failed binding: ${bindingErrors.join('; ')}`);

const deterministic = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'normal', createdAt: '2026-07-12T13:00:00.000Z' });
assert(deterministic.decisionId === claude.decisionId, 'decision identity depends on persistence time');
const nextAttempt = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'normal', attempt: 2 });
assert(nextAttempt.decisionId !== claude.decisionId, 'decision identity does not bind attempt');

for (const mutate of [
  (value) => { value.selectedConfig.model = 'tampered'; },
  (value) => { value.adapter.snapshotSha256 = 'b'.repeat(64); },
  (value) => { value.policySha256 = 'c'.repeat(64); },
]) {
  const tampered = structuredClone(claude);
  mutate(tampered);
  tampered.integritySha256 = modelDecisionIntegritySha256(tampered);
  assert(validateModelDecisionBinding(policy, adapters, tampered, {
    engagementId: context.engagementId,
    engagementManifestSha256: context.engagementManifestSha256,
    modelTrust,
  }).length > 0, 'semantically tampered decision passed binding');
}

const telemetry = buildModelTelemetryEvent(policy, claude, {
  inputTokens: 120, outputTokens: 30, durationMs: 450, reportedCostUsd: 0.012, success: true,
}, '2026-07-12T13:00:00.000Z');
assert(validateTelemetry(telemetry).length === 0 && telemetry.decisionId === claude.decisionId, 'decision-bound telemetry is invalid');
for (const forbidden of ['prompt', 'completion', 'target', 'url', 'path', 'account', 'token', 'evidence']) {
  assert(!Object.hasOwn(telemetry, forbidden), `telemetry leaked ${forbidden}`);
}

// Automatic frontier continuation: checkpoint-resume, checkpoint-less fresh restart, and
// unavailability backoff all keep the exact frontier baseline and a fresh native cap.
const autoContinue = policy.fallbackPolicies['frontier-fail-closed'].autoContinue;
assert(autoContinue.enabled === true && autoContinue.maxAutoContinuations === 3 && autoContinue.maxCheckpointlessRetries === 1, 'committed autoContinue flag drifted');
assert(same(autoContinue.unavailableBackoffSeconds, [60, 180, 300]) && same(autoContinue.excludedAgents, ['odysseus']), 'committed autoContinue backoff or exclusions drifted');
const ariadneTurns = policy.roles.find(({ slug }) => slug === 'ariadne').maxTurns;
const ariadne = { slug: 'ariadne', runtime: 'claude', dispatchId: 'dispatch-ariadne-001' };

const resumed = decide(adapters, { ...ariadne, signal: 'turn-limit', attempt: 2, escalationBinding: escalationBinding() });
assertAutoContinue(resumed, 'AUTO_CONTINUE_SELECTED', { kind: 'checkpoint-resume', sequence: 1, perAttemptMaxTurns: ariadneTurns, cumulativeTurnBudget: ariadneTurns * 2, backoffSeconds: 0 }, 'ariadne turn-limit checkpoint resume');
const repeated = decide(adapters, { ...ariadne, signal: 'repeated-failure', attempt: 4, escalationBinding: escalationBinding() });
assertAutoContinue(repeated, 'AUTO_CONTINUE_SELECTED', { kind: 'checkpoint-resume', sequence: 3, perAttemptMaxTurns: ariadneTurns, cumulativeTurnBudget: ariadneTurns * 4, backoffSeconds: 0 }, 'ariadne repeated-failure at the continuation ceiling');
const pastCeiling = decide(adapters, { ...ariadne, signal: 'turn-limit', attempt: 5, escalationBinding: escalationBinding() });
assertOperatorGate(pastCeiling, 'OPERATOR_ESCALATION_REQUIRED', 'ariadne turn-limit past maxAutoContinuations');
const ariadneSafety = decide(adapters, { ...ariadne, signal: 'safety', attempt: 2, escalationBinding: escalationBinding() });
assertOperatorGate(ariadneSafety, 'OPERATOR_ESCALATION_REQUIRED', 'ariadne safety');
const unboundTurnLimit = decide(adapters, { ...ariadne, signal: 'turn-limit', attempt: 2 });
assertOperatorGate(unboundTurnLimit, 'OPERATOR_ESCALATION_REQUIRED', 'ariadne turn-limit without a checkpoint or outcome binding');

const freshRestart = decide(adapters, { ...ariadne, signal: 'no-artifact', attempt: 2, outcomeBinding: outcomeBinding(0) });
assertAutoContinue(freshRestart, 'AUTO_CONTINUE_SELECTED', { kind: 'fresh-restart', sequence: 1, perAttemptMaxTurns: ariadneTurns, cumulativeTurnBudget: ariadneTurns * 2, backoffSeconds: 0 }, 'ariadne no-artifact fresh restart');
const restartExhausted = decide(adapters, { ...ariadne, signal: 'no-artifact', attempt: 3, outcomeBinding: outcomeBinding(1) });
assert(restartExhausted.status === 'blocked' && restartExhausted.reasonCode === 'AUTO_CONTINUATION_EXHAUSTED' && restartExhausted.operatorEscalation === false && restartExhausted.continuation === null, 'a second checkpoint-less restart was not exhausted');
const continuationsExhausted = decide(adapters, { ...ariadne, signal: 'no-artifact', attempt: 5, outcomeBinding: outcomeBinding(0) });
assert(continuationsExhausted.reasonCode === 'AUTO_CONTINUATION_EXHAUSTED', 'a fresh restart beyond maxAutoContinuations was selected');
const contradicted = decide(adapters, { ...ariadne, signal: 'no-artifact', attempt: 2, outcomeBinding: outcomeBinding(0, ['solution/FINDINGS.md']) });
assert(contradicted.status === 'blocked' && contradicted.reasonCode === 'SIGNAL_NOT_ALLOWED' && contradicted.continuation === null, 'no-artifact with observed artifacts was not refused');
assertThrows(() => decide(adapters, { ...ariadne, signal: 'no-artifact', attempt: 2 }), 'no-artifact without an outcome binding was routed');
const uncheckpointed = decide(adapters, { ...ariadne, signal: 'turn-limit', attempt: 2, outcomeBinding: outcomeBinding(0, ['solution/FINDINGS.md']) });
assertAutoContinue(uncheckpointed, 'AUTO_CONTINUE_SELECTED', { kind: 'fresh-restart', sequence: 1, perAttemptMaxTurns: ariadneTurns, cumulativeTurnBudget: ariadneTurns * 2, backoffSeconds: 0 }, 'uncheckpointed ariadne turn-limit');
const zeroCandidates = decide(adapters, { ...ariadne, signal: 'zero-candidates', attempt: 2, outcomeBinding: outcomeBinding(0, ['solution/FINDINGS.md']) });
assert(zeroCandidates.status === 'selected' && zeroCandidates.reasonCode === 'AUTO_CONTINUE_SELECTED', 'ariadne zero-candidates restart was not selected');
const kalchasZero = decide(adapters, { slug: 'kalchas', runtime: 'claude', dispatchId: 'dispatch-kalchas-001', signal: 'zero-candidates', attempt: 2, outcomeBinding: outcomeBinding(0) });
assert(kalchasZero.status === 'blocked' && kalchasZero.reasonCode === 'SIGNAL_NOT_ALLOWED', 'kalchas zero-candidates bypassed the hunter-only rule');

const backoffFirst = decide(adapters, { ...ariadne, signal: 'model-unavailable', attempt: 2, availabilityBinding: availabilityBinding(0) });
assertAutoContinue(backoffFirst, 'BACKOFF_RETRY_SELECTED', { kind: 'backoff-retry', sequence: 1, perAttemptMaxTurns: ariadneTurns, cumulativeTurnBudget: ariadneTurns * 2, backoffSeconds: 60 }, 'first ariadne unavailability retry');
const backoffLast = decide(adapters, { ...ariadne, signal: 'model-unavailable', attempt: 4, availabilityBinding: availabilityBinding(2) });
assertAutoContinue(backoffLast, 'BACKOFF_RETRY_SELECTED', { kind: 'backoff-retry', sequence: 3, perAttemptMaxTurns: ariadneTurns, cumulativeTurnBudget: ariadneTurns * 4, backoffSeconds: 300 }, 'third ariadne unavailability retry');
const backoffExhausted = decide(adapters, { ...ariadne, signal: 'model-unavailable', attempt: 5, availabilityBinding: availabilityBinding(3) });
assertOperatorGate(backoffExhausted, 'FRONTIER_UNAVAILABLE', 'ariadne unavailability after every backoff');
const missingRetryCount = availabilityBinding(0);
delete missingRetryCount.priorUnavailableRetries;
assertThrows(() => decide(adapters, { ...ariadne, signal: 'model-unavailable', attempt: 2, availabilityBinding: missingRetryCount }), 'an availability binding without priorUnavailableRetries was routed');

const controllerTurnLimit = decide(adapters, { slug: 'odysseus', runtime: 'claude', dispatchId: 'dispatch-odysseus-001', signal: 'turn-limit', attempt: 2, escalationBinding: escalationBinding() });
assertOperatorGate(controllerTurnLimit, 'OPERATOR_ESCALATION_REQUIRED', 'odysseus turn-limit');
const controllerOutcome = decide(adapters, { slug: 'odysseus', runtime: 'claude', dispatchId: 'dispatch-odysseus-001', signal: 'no-artifact', attempt: 2, outcomeBinding: outcomeBinding(0) });
assert(controllerOutcome.reasonCode === 'SIGNAL_NOT_ALLOWED', 'the excluded controller received an automatic restart');
const codexContinuation = decide(adapters, { ...ariadne, runtime: 'codex', signal: 'turn-limit', attempt: 2, escalationBinding: escalationBinding() });
assert(codexContinuation.reasonCode === 'CAPABILITY_DRIFT' && codexContinuation.continuation === null, 'Codex continuation bypassed the missing native turn cap');

for (const [overrides, message] of [
  [{ signal: 'no-artifact', attempt: 2, outcomeBinding: outcomeBinding(0), escalationBinding: escalationBinding() }, 'outcome and escalation bindings together'],
  [{ signal: 'safety', attempt: 2, outcomeBinding: outcomeBinding(0) }, 'an outcome binding on an operator-gated signal'],
  [{ signal: 'model-unavailable', attempt: 2, outcomeBinding: outcomeBinding(0), availabilityBinding: availabilityBinding(0) }, 'an outcome binding on model-unavailable'],
  [{ signal: 'no-artifact', attempt: 1, outcomeBinding: outcomeBinding(0) }, 'an outcome binding on attempt 1'],
  [{ signal: 'no-artifact', attempt: 2, outcomeBinding: { ...outcomeBinding(0), priorCheckpointlessRetries: -1 } }, 'a negative checkpoint-less retry count'],
  [{ signal: 'no-artifact', attempt: 2, outcomeBinding: { ...outcomeBinding(0), observedArtifacts: 'solution/FINDINGS.md' } }, 'a non-array observedArtifacts'],
  [{ signal: 'turn-limit', attempt: 2, outcomeBinding: outcomeBinding(0), operatorDecision: operatorDecisionBinding(pastCeiling, 'continue-frontier') }, 'an outcome binding with an operator decision'],
]) {
  assertThrows(() => resolveModelDecision(policy, adapters, { ...context, ...ariadne, ...overrides }), `resolver accepted ${message}`);
}

// With the flag disabled every path returns to the 4.x operator-gated behaviour.
const disabled = structuredClone(policy);
disabled.fallbackPolicies['frontier-fail-closed'].autoContinue.enabled = false;
assert(validateModelPolicy(disabled, slugsOf(disabled)).length === 0 && validatePolicySchema(disabled).length === 0, 'a disabled autoContinue flag is not a valid policy');
assertOperatorGate(decide(adapters, { ...ariadne, signal: 'turn-limit', attempt: 2, escalationBinding: escalationBinding() }, disabled), 'OPERATOR_ESCALATION_REQUIRED', 'disabled-flag turn-limit');
const disabledUnavailable = decide(adapters, { ...ariadne, signal: 'model-unavailable', attempt: 2, availabilityBinding: availabilityBinding(0) }, disabled);
assertOperatorGate(disabledUnavailable, 'FRONTIER_UNAVAILABLE', 'disabled-flag unavailability');
assert(disabledUnavailable.reason === 'frontier model unavailable; weaker fallback is forbidden and retry or abort requires an external operator decision', 'disabled-flag unavailability reason drifted from 4.x');
assert(decide(adapters, { ...ariadne, signal: 'no-artifact', attempt: 2, outcomeBinding: outcomeBinding(0) }, disabled).reasonCode === 'SIGNAL_NOT_ALLOWED', 'disabled flag still restarted a no-artifact lane');

// Unattested engagements have no operator anchor, so the automatic paths are their only continuation.
const unattestedResume = decide(adapters, { ...ariadne, signal: 'turn-limit', attempt: 2, escalationBinding: escalationBinding(), trust: 'unattested' });
assert(unattestedResume.trust === 'unattested' && unattestedResume.reasonCode === 'AUTO_CONTINUE_SELECTED', 'unattested turn-limit did not take the automatic path');
const unattestedBackoff = decide(adapters, { ...ariadne, signal: 'model-unavailable', attempt: 2, availabilityBinding: availabilityBinding(1), trust: 'unattested' });
assert(unattestedBackoff.reasonCode === 'BACKOFF_RETRY_SELECTED' && unattestedBackoff.continuation.backoffSeconds === 180, 'unattested unavailability did not back off');
const unattestedErrors = validateModelDecisionBinding(policy, adapters, unattestedResume, {
  engagementId: context.engagementId, engagementManifestSha256: context.engagementManifestSha256, modelTrust: null, launchAssurance: 'unattested',
});
assert(unattestedErrors.length === 0, `unattested automatic continuation failed binding: ${unattestedErrors.join('; ')}`);

for (const decision of [resumed, freshRestart, restartExhausted, contradicted, backoffFirst, backoffExhausted, kalchasZero, pastCeiling]) {
  const errors = validateModelDecisionBinding(policy, adapters, decision, {
    engagementId: context.engagementId, engagementManifestSha256: context.engagementManifestSha256, modelTrust,
  });
  assert(errors.length === 0, `${decision.agent}/${decision.signal}/${decision.reasonCode} binding round-trip failed: ${errors.join('; ')}`);
}
const tamperedOutcome = structuredClone(freshRestart);
tamperedOutcome.outcomeBinding.priorCheckpointlessRetries = 1;
tamperedOutcome.integritySha256 = modelDecisionIntegritySha256(tamperedOutcome);
assert(validateModelDecisionBinding(policy, adapters, tamperedOutcome, {
  engagementId: context.engagementId, engagementManifestSha256: context.engagementManifestSha256, modelTrust,
}).length > 0, 'a rewritten outcome retry count passed binding');
const tamperedContinuation = structuredClone(resumed);
tamperedContinuation.continuation.perAttemptMaxTurns = ariadneTurns * 2;
tamperedContinuation.integritySha256 = modelDecisionIntegritySha256(tamperedContinuation);
assert(validateModelDecisionBinding(policy, adapters, tamperedContinuation, {
  engagementId: context.engagementId, engagementManifestSha256: context.engagementManifestSha256, modelTrust,
}).length > 0, 'a raised continuation turn cap passed binding');
const nullCheckpoint = structuredClone(resumed);
nullCheckpoint.escalationBinding.checkpointRef = null;
assert(validateDecision(nullCheckpoint).length > 0, 'decision schema accepted a checkpoint-less escalation binding');
for (const decision of [resumed, freshRestart, restartExhausted, backoffFirst]) {
  const event = buildModelTelemetryEvent(policy, decision, { inputTokens: 10, outputTokens: 5, durationMs: 40, success: decision.status === 'selected' }, '2026-07-12T13:05:00.000Z');
  assert(validateTelemetry(event).length === 0 && event.schema === 'argus/model-telemetry-event@3' && event.reasonCode === decision.reasonCode, `${decision.reasonCode} telemetry violates @3`);
}

// Policy negative cases: operator-gated signals, outcome leakage, and bounds.
assertAutoPolicyRejected((auto) => { auto.workerSignals.push('safety'); }, 'lists operator-gated signals: safety', 'safety in workerSignals');
assertAutoPolicyRejected((auto) => { auto.checkpointlessSignals.push('ambiguity'); }, 'lists operator-gated signals: ambiguity', 'ambiguity in checkpointlessSignals');
assertAutoPolicyRejected((auto) => { auto.outcomeSignals = ['no-artifact']; auto.checkpointlessSignals = ['turn-limit', 'no-artifact']; }, 'outcomeSignals must be exactly', 'a partial outcome signal list');
assertAutoPolicyRejected((auto) => { auto.checkpointlessSignals = ['turn-limit', 'no-artifact']; }, 'checkpointlessSignals must include', 'checkpointless signals without zero-candidates');
assertAutoPolicyRejected((auto) => { auto.workerSignals = ['turn-limit']; auto.checkpointlessSignals.push('repeated-failure'); }, 'must be a subset of workerSignals and outcomeSignals', 'a checkpointless signal outside the continuable set');
assertAutoPolicyRejected((auto) => { auto.workerSignals.push('no-artifact'); }, 'workerSignals lists controller-observed outcome signals', 'an outcome signal in workerSignals');
assertAutoPolicyRejected((auto) => { auto.zeroCandidatesRoles.push('nobody'); }, 'zeroCandidatesRoles nobody: entry must name an existing frontier role', 'an unknown zero-candidates role');
assertAutoPolicyRejected((auto) => { auto.excludedAgents = []; }, 'excludedAgents must contain the controller odysseus', 'a controller that is not excluded');
assertAutoPolicyRejected((auto) => { auto.unavailableBackoffSeconds = [300, 60]; }, 'unavailableBackoffSeconds must be non-decreasing', 'decreasing backoff');
assertAutoPolicyRejected((auto) => { auto.maxAutoContinuations = 6; }, 'maxAutoContinuations must be an integer from 0 to 5', 'too many continuations');
assertAutoPolicyRejected((auto) => { auto.maxCheckpointlessRetries = 3; }, 'maxCheckpointlessRetries must be an integer from 0 to 2', 'too many checkpoint-less restarts');
assertAutoPolicyRejected((auto) => { auto.unavailableBackoffSeconds = [60, 301]; }, 'unavailableBackoffSeconds must hold 1 to 5 integers from 1 to 300', 'a backoff above 300 seconds');
const leakedProfile = structuredClone(policy);
leakedProfile.escalationProfiles.execution.push('no-artifact');
assertPolicyRejected(leakedProfile, 'escalationProfiles.execution declares controller-observed outcome signals: no-artifact', 'an outcome signal in an escalation profile');
const standardZeroRole = withStandardRole(policy, 'aegis', 'Synthetic routing fixture for the upward-only standard path.');
standardZeroRole.fallbackPolicies['frontier-fail-closed'].autoContinue.zeroCandidatesRoles.push('aegis');
assertPolicyRejected(standardZeroRole, 'zeroCandidatesRoles aegis: entry must name an existing frontier role', 'a standard zero-candidates role');
const missingAuto = structuredClone(policy);
delete missingAuto.fallbackPolicies['frontier-fail-closed'].autoContinue;
assertPolicyRejected(missingAuto, 'fallbackPolicies.frontier-fail-closed.autoContinue is required', 'a frontier fallback without the autoContinue flag');
assert(validatePolicySchema(missingAuto).length > 0, 'model policy schema accepted a missing autoContinue flag');
const upwardAuto = structuredClone(policy);
upwardAuto.fallbackPolicies['upward-only'].autoContinue = structuredClone(autoContinue);
assertPolicyRejected(upwardAuto, 'fallbackPolicies.upward-only.autoContinue is valid only for frontier-fail-closed', 'an autoContinue flag on the upward-only fallback');
assert(validatePolicySchema(upwardAuto).length > 0, 'model policy schema accepted autoContinue on the upward-only fallback');
for (const [mutate, message] of [
  [(auto) => { delete auto.enabled; }, 'a missing enabled key'],
  [(auto) => { auto.extra = true; }, 'an unknown autoContinue key'],
  [(auto) => { auto.workerSignals.push('turn-limit'); }, 'a duplicate worker signal'],
  [(auto) => { auto.workerSignals.push('model-unavailable'); }, 'a non-continuable worker signal'],
  [(auto) => { auto.unavailableBackoffSeconds = [10, 20, 30, 40, 50, 60]; }, 'six backoff entries'],
  [(auto) => { auto.unavailableBackoffSeconds = [60, 60]; }, 'duplicate backoff entries'],
  [(auto) => { auto.maxAutoContinuations = 6; }, 'maxAutoContinuations above 5'],
  [(auto) => { auto.maxCheckpointlessRetries = 3; }, 'maxCheckpointlessRetries above 2'],
  [(auto) => { auto.excludedAgents.push('Odysseus'); }, 'a malformed excluded slug'],
]) {
  const candidate = structuredClone(policy);
  mutate(candidate.fallbackPolicies['frontier-fail-closed'].autoContinue);
  assert(validatePolicySchema(candidate).length > 0, `model policy schema accepted ${message}`);
}
const openFallback = structuredClone(policy);
openFallback.fallbackPolicies['frontier-fail-closed'].allowWeakerModel = true;
assert(validatePolicySchema(openFallback).length > 0, 'model policy schema accepted a weaker frontier fallback');

conditionalSealScenario();

console.log('PASS  Argus model routing: 27 reviewed execution profiles, critical effort floors, bounded Astra reasoning, model-only Claude escalation, fail-closed effort changes and Codex, controller turn budget, authenticated decisions, automatic frontier continuation and backoff, immutable telemetry, sealed conditional lanes released only by resolve-gates');

// End to end through the packaged CLI: preflight marks recon-provable lanes conditional, the
// model-control seal binds their attempt-1 decisions, allocation waits for resolve-gates, and
// only a gate the runtime re-checks from Kalchas's evidence releases a lane. The browser
// runtime is declared available, so every pending gate is a target gate and no probe runs.
function conditionalSealScenario() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-routing-conditional-')));
  try {
    const target = join(work, 'target');
    const artifacts = join(work, 'artifacts');
    const modelHost = join(work, 'model-host');
    mkdirSync(join(target, 'src', 'server'), { recursive: true });
    mkdirSync(join(target, 'tests'), { recursive: true });
    mkdirSync(artifacts);
    writeFileSync(join(target, 'src', 'server', 'orders.ts'), 'export const orders = [];\n');
    writeFileSync(join(target, 'tests', 'orders.spec.ts'), 'test("orders", () => {});\n');
    const profile = join(work, 'profile.json');
    writeFileSync(profile, `${JSON.stringify({ ...readJson('scripts/fixtures/argus-preflight/partial.json'), features: ['browser-runtime'] }, null, 2)}\n`);
    const cli = join(ROOT, 'argus/claude/bin/argus-assets');
    const smokeCli = join(ROOT, 'scripts/lib/argus-smoke-cli.sh');
    const baseEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('ARGUS_') && !['DATABASE_URL', 'PGHOST', 'MYSQL_HOST'].includes(name)));
    const smokeEnv = {
      ...baseEnv,
      ARGUS_SMOKE_REAL_CLI: cli,
      ARGUS_SMOKE_HOST_ROOT: join(work, 'native-host'),
      ARGUS_SMOKE_LAUNCHER: join(ROOT, 'argus/claude/bin/argus-launch'),
      ARGUS_SMOKE_CLAUDE: join(ROOT, 'scripts/fixtures/argus-launcher/claude'),
      ARGUS_SMOKE_PREFLIGHT_CLI: smokeCli,
    };
    const run = (command, args, env = smokeEnv) => spawnSync(command, args, { cwd: work, env, encoding: 'utf8' });
    const succeed = (label, result) => {
      assert(result.status === 0, `${label} failed (${result.status}): ${result.stderr || result.stdout}`);
      return result.stdout;
    };
    const refuse = (label, result, expected) => {
      assert(result.status !== 0, `${label} unexpectedly succeeded`);
      assert(`${result.stdout}${result.stderr}`.includes(expected), `${label} failed for the wrong reason: ${result.stderr || result.stdout}`);
    };

    succeed('conditional preflight', run(smokeCli, ['preflight', '--target', target, '--artifact-root', artifacts, '--mode', 'A',
      '--profile', profile, '--environment', 'unknown']));
    const manifest = join(artifacts, 'ai_agents_internal', 'engagement.json');
    succeed('model-control preparation', run('bash', ['-c', 'source "$1"; shift; argus_smoke_prepare_model_control "$@"', 'bash',
      join(ROOT, 'scripts/lib/argus-smoke-model-control.sh'), smokeCli, manifest, target, artifacts, 'A', profile, modelHost]));
    const report = JSON.parse(readFileSync(join(artifacts, 'ai_agents_internal', 'preflight.json'), 'utf8'));
    const expectedConditional = {
      asklepios: ['existing-suite'], proteus: ['non-rest-surface'], tiresias: ['source-access'],
    };
    const conditional = Object.fromEntries(report.agents.filter((agent) => agent.status === 'conditional').map((agent) => [agent.slug, agent.pendingGates]));
    assert(stable(conditional) === stable(expectedConditional), `preflight conditional lanes differ: ${JSON.stringify(conditional)}`);
    // Operator-feature-only gates are never sealed as conditional: recon could not release them.
    for (const lane of ['charon', 'mnemosyne', 'pistis']) {
      const record = report.agents.find((agent) => agent.slug === lane);
      assert(record.status === 'skipped' && record.pendingGates.length === 0 && !record.dispatchAllowed, `${lane} must stay skipped, got ${record.status}`);
    }

    const controlId = createHash('sha256').update(`${manifest}\0${JSON.parse(readFileSync(manifest, 'utf8')).engagementId}`).digest('hex').slice(0, 24);
    const controlRoot = join(modelHost, controlId);
    const cliEnv = { ...baseEnv, ARGUS_MODEL_TRUST_STORE: realpathSync(join(controlRoot, 'model-trust.json')) };
    const decisionPath = (lane) => readFileSync(join(controlRoot, 'decisions', `${lane}.path`), 'utf8').trim();
    const allocate = (lane, controllerToken) => run(cli, ['engagement', 'allocate', '--manifest', manifest, '--lane', lane,
      '--decision', decisionPath(lane), ...(controllerToken ? ['--controller-token', controllerToken] : [])], cliEnv);
    const controller = JSON.parse(succeed('odysseus allocation', allocate('odysseus'))).token;

    // The seal binds every conditional lane with its own selected normal attempt-1 decision.
    const seal = JSON.parse(readFileSync(join(artifacts, 'ai_agents_internal', 'model-control-seal.json'), 'utf8'));
    assert(!seal.dispatchableAgents.some((lane) => ['charon', 'mnemosyne', 'pistis'].includes(lane)), 'the seal bound an operator-feature-only lane');
    for (const lane of Object.keys(expectedConditional)) {
      assert(seal.dispatchableAgents.includes(lane), `seal omitted conditional lane ${lane}`);
      const decision = JSON.parse(readFileSync(decisionPath(lane), 'utf8'));
      assert(decision.agent === lane && decision.status === 'selected' && decision.signal === 'normal' && decision.attempt === 1
        && seal.decisions[lane]?.modelDecisionId === decision.decisionId, `seal does not bind the attempt-1 decision of ${lane}`);
    }
    const sealedState = JSON.parse(succeed('engagement status', run(cli, ['engagement', 'status', '--manifest', manifest], cliEnv)));
    assert(stable(sealedState.conditionalAgents) === stable(expectedConditional) && sealedState.gateResolution === null,
      `sealed state conditional projection differs: ${JSON.stringify(sealedState.conditionalAgents)}`);

    // A bound conditional map that differs from the sealed report is refused before any allocation.
    const statePath = join(artifacts, 'ai_agents_internal', 'engagement-state.json');
    const stateBytes = readFileSync(statePath);
    const tampered = JSON.parse(stateBytes.toString('utf8'));
    delete tampered.conditionalAgents.proteus;
    writeFileSync(statePath, `${JSON.stringify(tampered, null, 2)}\n`);
    refuse('tampered conditional projection', allocate('kalchas', controller), 'engagement state conditional projection differs from the sealed preflight');
    writeFileSync(statePath, stateBytes);

    refuse('pre-resolution conditional allocation', allocate('tiresias', controller), 'tiresias is conditional on source-access; run engagement resolve-gates first');
    const kalchas = JSON.parse(succeed('kalchas allocation', allocate('kalchas', controller))).token;
    succeed('kalchas discovery arrival', run(cli, ['engagement', 'barrier', 'arrive', '--manifest', manifest, '--lane', 'kalchas',
      '--token', kalchas, '--phase', 'discovery'], cliEnv));

    // The P-06 capability-evidence fixture, rebound to this engagement and target source tree.
    const evidence = readJson('scripts/fixtures/argus-schemas/valid/capability-evidence.json');
    evidence.engagementId = sealedState.engagementId;
    const sourceGate = evidence.gates.find((gate) => gate.capability === 'source-access');
    sourceGate.proof.path = join(target, 'src');
    sourceGate.proof.fileRead = join(target, 'src', 'server', 'orders.ts');
    const evidencePath = join(artifacts, 'solution', 'discovery', 'capability-evidence.json');
    mkdirSync(join(artifacts, 'solution', 'discovery'), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
    const resolution = JSON.parse(succeed('resolve-gates', run(cli, ['engagement', 'resolve-gates', '--manifest', manifest,
      '--controller-token', controller], cliEnv)));
    assert(stable({ released: resolution.released, gateUnmet: resolution.gateUnmet })
      === stable({ released: ['tiresias'], gateUnmet: ['asklepios', 'proteus'] }),
      `resolve-gates released the wrong lanes: ${JSON.stringify(resolution)}`);
    assert(resolution.gateResolution.evidenceSha256 === createHash('sha256').update(readFileSync(evidencePath)).digest('hex')
      && resolution.gateResolution.capabilities['source-access'].basis === 'kalchas-evidence+path-check', 'resolve-gates did not bind the capability evidence');

    const released = JSON.parse(succeed('released conditional allocation', allocate('tiresias', controller)));
    assert(released.lane === 'tiresias' && typeof released.token === 'string', 'the released conditional lane did not receive a lease');
    refuse('gate-unmet allocation', allocate('asklepios', controller), 'asklepios was omitted: gate unmet (existing-suite)');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function decide(snapshot, overrides, activePolicy = policy) {
  const decision = resolveModelDecision(activePolicy, snapshot, { ...context, ...overrides });
  const errors = validateDecision(decision);
  assert(errors.length === 0, `decision schema rejected ${overrides.runtime}/${overrides.signal}: ${JSON.stringify(errors)}`);
  return decision;
}

function operatorDecisionBinding(blocked, action) {
  const document = {
    schema: 'argus/model-operator-decision@1', kind: 'MODEL_OPERATOR_DECISION',
    engagementId: blocked.engagementId, dispatchId: blocked.dispatchId, attempt: blocked.attempt,
    agent: blocked.agent, signal: blocked.signal, blockedDecisionId: blocked.decisionId, action,
    approvedBy: 'routing-unit-operator', approvedAt: '2026-07-12T12:01:00.000Z', reason: 'Explicit operator disposition.',
    authentication: {
      algorithm: 'Ed25519', keyId: modelTrust.keys.operatorApproval.keyId, purpose: 'operator-approval',
      keyFingerprintSha256: modelTrust.keys.operatorApproval.keyFingerprintSha256, signatureBase64: '',
    },
  };
  const payload = modelAuthenticationPayload(document);
  document.authentication.signatureBase64 = signSignature(null, Buffer.from(payload), operatorKeys.privateKey).toString('base64');
  return {
    action, blockedDecisionId: blocked.decisionId, approvedBy: document.approvedBy, approvedAt: document.approvedAt,
    reason: document.reason, documentSha256: modelAuthenticatedDocumentSha256(document),
    authentication: { ...document.authentication, canonicalPayloadBase64: Buffer.from(payload).toString('base64') },
  };
}

// Moves one role to the standard tier with upward-only fallback and rewrites the
// baseline to the derived counts. A null justification omits the allowlist entry.
function withStandardRole(source, slug, justification) {
  const fixture = structuredClone(source);
  const role = fixture.roles.find((item) => item.slug === slug);
  assert(role, `${slug}: fixture role missing`);
  role.tier = 'standard';
  role.executionProfile = 'standard-medium';
  role.fallbackPolicy = 'upward-only';
  const counts = tierCounts(fixture);
  fixture.baseline.frontierRoles = counts.frontier;
  fixture.baseline.standardRoles = counts.standard;
  fixture.baseline.decision = `adopt-${counts.frontier}-frontier-${counts.standard}-standard`;
  fixture.baseline.standardAllowlist = fixture.baseline.standardAllowlist.filter((entry) => entry.slug !== slug);
  if (justification !== null) fixture.baseline.standardAllowlist.push({ slug, justification });
  return fixture;
}

// Synthetic lineage bindings. The resolver checks their routing-relevant fields; the CLI
// derives the real values from the active allocation, checkpoint, and prior decision.
function escalationBinding() {
  return {
    requestSha256: 'e'.repeat(64),
    checkpointRef: 'ai_agents_internal/checkpoints/ariadne/00000001.json',
    checkpointSha256: 'f'.repeat(64),
    previousDecisionId: `MDR-${'1'.repeat(24)}`,
  };
}

function availabilityBinding(priorUnavailableRetries) {
  return { ...priorAllocationBinding(), priorUnavailableRetries };
}

function outcomeBinding(priorCheckpointlessRetries, observedArtifacts = []) {
  return { ...priorAllocationBinding(), priorCheckpointlessRetries, observedArtifacts };
}

function priorAllocationBinding() {
  return {
    previousDecisionId: `MDR-${'1'.repeat(24)}`,
    previousDecisionIntegritySha256: '2'.repeat(64),
    allocationId: '3'.repeat(24),
    allocationSha256: '4'.repeat(64),
  };
}

function assertAutoContinue(decision, reasonCode, continuation, label) {
  assert(decision.status === 'selected' && decision.reasonCode === reasonCode, `${label}: expected selected ${reasonCode}, got ${decision.status} ${decision.reasonCode}`);
  assert(stable(decision.selectedConfig) === stable(decision.baselineConfig) && decision.adapter.mode === 'baseline', `${label}: continuation left the frontier baseline`);
  assert(decision.requiredOverrides.length === 0 && decision.fallbackUsed === false && decision.operatorEscalation === false, `${label}: continuation claimed an override or operator gate`);
  assert(stable(decision.continuation) === stable(continuation), `${label}: continuation ${JSON.stringify(decision.continuation)} differs from ${JSON.stringify(continuation)}`);
}

function assertOperatorGate(decision, reasonCode, label) {
  assert(decision.status === 'blocked' && decision.reasonCode === reasonCode && decision.operatorEscalation === true && decision.continuation === null,
    `${label}: expected an operator-gated ${reasonCode}, got ${decision.status} ${decision.reasonCode}`);
}

function assertAutoPolicyRejected(mutate, expected, message) {
  const candidate = structuredClone(policy);
  mutate(candidate.fallbackPolicies['frontier-fail-closed'].autoContinue);
  assertPolicyRejected(candidate, expected, `${message} was accepted`);
}

function assertPolicyRejected(candidate, expected, message) {
  const errors = validateModelPolicy(candidate, slugsOf(candidate));
  assert(errors.some((error) => error.includes(expected)), `${message}: ${errors.join('; ') || 'no validation error'}`);
}

function tierCounts(source) {
  return {
    frontier: source.roles.filter(({ tier }) => tier === 'frontier').length,
    standard: source.roles.filter(({ tier }) => tier === 'standard').length,
  };
}

function slugsOf(source) { return source.roles.map(({ slug }) => slug); }

function assertThrows(operation, message) {
  try { operation(); } catch { return; }
  assert(false, message);
}

function readJson(relativePath) { return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')); }
function same(left, right) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function stable(record) { return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))); }
function assert(value, message) { if (!value) throw new Error(message); }
