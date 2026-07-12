#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign as signSignature } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  adapterSnapshotSha256,
  buildModelTelemetryEvent,
  modelAuthenticatedDocumentSha256,
  modelAuthenticationPayload,
  modelConfigSha256,
  modelDecisionIntegritySha256,
  modelPublicKeyFingerprint,
  resolveModelDecision,
  validateModelDecisionBinding,
  validateModelPolicy,
} from '../argus/runtime/model-policy.mjs';
import { compileJsonSchema } from '../argus/runtime/json-schema.mjs';
import { allocateWorker, createDefaultEngagement, initializeEngagementState } from '../argus/runtime/engagement.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = readJson('argus/model-policy.json');
const adapters = readJson('argus/runtime-adapters.json');
const benchmark = readJson('argus/model-policy.benchmark.json');
const validateAdapters = compileJsonSchema(readJson('argus/schemas/runtime-adapters.schema.json'));
const validateBenchmark = compileJsonSchema(readJson('argus/schemas/model-policy-benchmark.schema.json'));
const validateDecision = compileJsonSchema(readJson('argus/schemas/model-decision.schema.json'));
const validateDispatchAuthorization = compileJsonSchema(readJson('argus/schemas/model-dispatch-authorization.schema.json'));
const validateTelemetry = compileJsonSchema(readJson('argus/schemas/model-telemetry-event.schema.json'));
const baseContext = {
  engagementId: 'engagement-routing-smoke',
  engagementManifestSha256: 'a'.repeat(64),
  dispatchId: 'dispatch-aegis-001',
  attempt: 1,
  createdAt: '2026-07-12T12:00:00.000Z',
};
const runtimeSigningKeys = generateKeyPairSync('ed25519');
const operatorSigningKeys = generateKeyPairSync('ed25519');
const runtimePublicKeyPem = runtimeSigningKeys.publicKey.export({ type: 'spki', format: 'pem' });
const operatorPublicKeyPem = operatorSigningKeys.publicKey.export({ type: 'spki', format: 'pem' });
const modelTrust = {
  schema: 'argus/model-trust-bundle@1',
  source: 'host-trust-store',
  trustStoreSha256: 'd'.repeat(64),
  pinnedAt: '2026-07-12T11:50:00.000Z',
  keys: {
    runtimeAttestation: {
      keyId: 'routing-runtime-key', purpose: 'runtime-attestation', subjectId: 'codex-parent', algorithm: 'Ed25519',
      publicKeyPem: runtimePublicKeyPem, keyFingerprintSha256: modelPublicKeyFingerprint(runtimePublicKeyPem),
    },
    operatorApproval: {
      keyId: 'routing-operator-key', purpose: 'operator-approval', subjectId: 'routing-unit-operator', algorithm: 'Ed25519',
      publicKeyPem: operatorPublicKeyPem, keyFingerprintSha256: modelPublicKeyFingerprint(operatorPublicKeyPem),
    },
  },
  legacyBootstrap: null,
};

assert(validateModelPolicy(policy, policy.roles.map((role) => role.slug)).length === 0, 'model policy is invalid');
assert(validateAdapters(adapters).length === 0, 'runtime adapter snapshot is invalid');
assert(validateBenchmark(benchmark).length === 0, 'model policy benchmark is invalid');
const oversizedBenchmark = structuredClone(benchmark);
oversizedBenchmark.scenarios[0].runs.push(structuredClone(oversizedBenchmark.scenarios[0].runs[0]));
assert(validateBenchmark(oversizedBenchmark).some((error) => error.keyword === 'maxItems'), 'runtime schema compiler ignored maxItems');
for (const tier of ['frontier', 'standard', 'mechanical']) {
  assertPolicyMutation((copy) => { copy.tiers[tier].rank += 1; }, `${tier} rank`);
  assertPolicyMutation((copy) => { copy.tiers[tier].qualityCritical = !copy.tiers[tier].qualityCritical; }, `${tier} qualityCritical`);
  for (const [runtime, effortField] of [['claude', 'effort'], ['codex', 'reasoningEffort']]) {
    assertPolicyMutation((copy) => { copy.tiers[tier][runtime].model += '-drift'; }, `${tier} ${runtime} model`);
    assertPolicyMutation((copy) => { copy.tiers[tier][runtime][effortField] += '-drift'; }, `${tier} ${runtime} effort`);
  }
}
assertPolicyMutation((copy) => { copy.tiers.mechanical.eligibility.pop(); }, 'mechanical eligibility');
assertPolicyMutation((copy) => { copy.mechanicalDowngrade.fullRoleAllowed = true; }, 'mechanical downgrade');

const actualClaudeBaseline = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'normal' });
assert(actualClaudeBaseline.status === 'selected', 'Claude baseline must be enforceable by static agent configuration');
assert(actualClaudeBaseline.reasonCode === 'BASELINE_SELECTED', 'Claude baseline reason code drifted');
assert(actualClaudeBaseline.requiredOverrides.length === 0, 'baseline must not claim dynamic overrides');
assert(same(actualClaudeBaseline.requiredEnforcements, ['effort', 'maxTurns', 'model']), 'baseline must enforce model, effort, and maxTurns together');

const actualClaudeEscalation = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'safety' });
assert(actualClaudeEscalation.status === 'blocked', 'Claude escalation must block without a verified effort override');
assert(actualClaudeEscalation.reasonCode === 'CAPABILITY_DRIFT', 'Claude escalation must report capability drift');
assert(same(actualClaudeEscalation.missingCapabilities, ['effort']), 'Claude escalation must identify only the missing effort override');

const actualCodexBaseline = decide(adapters, { slug: 'aegis', runtime: 'codex', signal: 'normal' });
assert(actualCodexBaseline.status === 'blocked', 'Codex baseline must block without maxTurns enforcement');
assert(same(actualCodexBaseline.missingCapabilities, ['maxTurns']), 'Codex baseline must identify only maxTurns as missing');
const codexAttestedBaseline = decide(adapters, {
  slug: 'aegis',
  runtime: 'codex',
  signal: 'normal',
  runtimeAttestation: codexAttestation(adapters, actualCodexBaseline.selectedConfig),
});
assert(codexAttestedBaseline.status === 'selected', 'exact Codex parent attestation must make the baseline executable');
assert(codexAttestedBaseline.reasonCode === 'BASELINE_SELECTED', 'attested Codex baseline reason drifted');
assert(codexAttestedBaseline.missingCapabilities.length === 0, 'attested Codex baseline retained missing capabilities');
assert(/^[a-f0-9]{64}$/.test(codexAttestedBaseline.runtimeAttestation.documentSha256), 'Codex attestation was not bound to the decision');
assertThrows(() => decide(adapters, {
  slug: 'aegis', runtime: 'codex', signal: 'normal',
  runtimeAttestation: codexAttestation(adapters, actualCodexBaseline.selectedConfig, { dispatchId: 'wrong-dispatch' }),
}), 'Codex attestation for another dispatch was accepted');
assertThrows(() => decide(adapters, {
  slug: 'aegis', runtime: 'codex', signal: 'normal',
  runtimeAttestation: codexAttestation(adapters, actualCodexBaseline.selectedConfig, { enforcements: { model: true, effort: true, maxTurns: false } }),
}), 'partial Codex enforcement attestation was accepted');
assertThrows(() => decide(adapters, {
  slug: 'aegis', runtime: 'codex', signal: 'normal',
  runtimeAttestation: codexAttestation(adapters, actualCodexBaseline.selectedConfig, { expiresAt: '2026-07-12T11:59:59.000Z' }),
}), 'expired Codex attestation was accepted');
assertThrows(() => decide(adapters, {
  slug: 'aegis', runtime: 'claude', signal: 'normal',
  runtimeAttestation: codexAttestation(adapters, actualCodexBaseline.selectedConfig),
}), 'Codex parent attestation was accepted for Claude');

const fullAdapters = structuredClone(adapters);
for (const runtime of ['claude', 'codex']) {
  for (const mode of ['baseline', 'escalation']) {
    for (const field of ['model', 'effort', 'maxTurns']) fullAdapters[runtime].routingCapabilities[mode][field] = true;
  }
  const escalated = decide(fullAdapters, { slug: 'aegis', runtime, signal: 'safety' });
  assert(escalated.status === 'selected', `${runtime} full adapter did not select the frontier escalation`);
  assert(escalated.selectedConfig.tier === 'frontier', `${runtime} full adapter did not route standard to frontier`);
  assert(same(escalated.requiredOverrides, ['effort', 'model']), `${runtime} escalation dynamic override set drifted`);
  assert(escalated.adapter.adapterId === adapters[runtime].adapterId, `${runtime} adapterId was not bound to the decision`);
  assert(escalated.adapter.snapshotSha256 !== actualClaudeBaseline.adapter.snapshotSha256, `${runtime} fake snapshot digest was not bound exactly`);

  for (const mode of ['baseline', 'escalation']) {
    for (const field of ['model', 'effort', 'maxTurns']) {
      const missingOne = structuredClone(fullAdapters);
      missingOne[runtime].routingCapabilities[mode][field] = false;
      const signal = mode === 'baseline' ? 'normal' : 'safety';
      const decision = decide(missingOne, { slug: 'aegis', runtime, signal });
      assert(decision.status === 'blocked', `${runtime}/${mode}/${field}: missing capability did not block`);
      assert(decision.reasonCode === 'CAPABILITY_DRIFT', `${runtime}/${mode}/${field}: missing capability did not report drift`);
      assert(same(decision.missingCapabilities, [field]), `${runtime}/${mode}/${field}: missing capability set is not exact`);
    }
  }
}

const unallowed = decide(fullAdapters, { slug: 'aegis', runtime: 'claude', signal: 'conflicting-evidence' });
assert(unallowed.status === 'blocked' && unallowed.reasonCode === 'SIGNAL_NOT_ALLOWED', 'profile-disallowed signal did not block');
const unknown = decide(fullAdapters, { slug: 'aegis', runtime: 'claude', signal: 'invented-signal' });
assert(unknown.status === 'blocked' && unknown.reasonCode === 'SIGNAL_NOT_ALLOWED', 'unknown signal did not block');
const mechanical = decide(fullAdapters, { slug: 'theseus', runtime: 'claude', signal: 'schema-validated-mechanical' });
assert(mechanical.status === 'blocked' && mechanical.reasonCode === 'MECHANICAL_FULL_ROLE_FORBIDDEN', 'full-role mechanical route did not block');
const availabilityBinding = {
  previousDecisionId: actualClaudeBaseline.decisionId,
  previousDecisionIntegritySha256: actualClaudeBaseline.integritySha256,
  allocationId: 'f'.repeat(24),
  allocationSha256: '1'.repeat(64),
};
const unavailable = decide(fullAdapters, { slug: 'perseus', runtime: 'claude', signal: 'model-unavailable', attempt: 2, availabilityBinding });
assert(unavailable.status === 'blocked' && unavailable.reasonCode === 'FRONTIER_UNAVAILABLE', 'frontier unavailability did not fail closed');
assertThrows(() => decide(fullAdapters, { slug: 'perseus', runtime: 'claude', signal: 'model-unavailable', attempt: 2 }), 'model-unavailable accepted no prior-decision/allocation binding');
const retryBinding = {
  ...operatorDecisionBinding(unavailable, 'retry-frontier'),
};
const unavailableRetry = decide(fullAdapters, {
  slug: 'perseus', runtime: 'claude', signal: 'model-unavailable', attempt: 2, availabilityBinding, operatorDecision: retryBinding,
});
assert(unavailableRetry.status === 'selected' && unavailableRetry.reasonCode === 'OPERATOR_RETRY_SELECTED', 'operator frontier retry did not resolve unavailability');
const unavailableAbort = decide(fullAdapters, {
  slug: 'perseus', runtime: 'claude', signal: 'model-unavailable', attempt: 2, availabilityBinding,
  operatorDecision: operatorDecisionBinding(unavailable, 'abort'),
});
assert(unavailableAbort.status === 'blocked' && unavailableAbort.reasonCode === 'OPERATOR_ABORTED', 'operator frontier abort did not resolve unavailability');
assertThrows(() => decide(fullAdapters, {
  slug: 'perseus', runtime: 'claude', signal: 'model-unavailable', attempt: 2, availabilityBinding,
  operatorDecision: { ...retryBinding, action: 'continue-frontier' },
}), 'model-unavailable accepted the declared-signal continuation action');
const operatorEscalation = decide(fullAdapters, { slug: 'ariadne', runtime: 'claude', signal: 'safety' });
assert(operatorEscalation.status === 'blocked' && operatorEscalation.reasonCode === 'OPERATOR_ESCALATION_REQUIRED' && operatorEscalation.operatorEscalation, 'frontier escalation bypassed the operator');
const operatorBinding = {
  ...operatorDecisionBinding(operatorEscalation, 'continue-frontier'),
};
const operatorApproved = decide(fullAdapters, { slug: 'ariadne', runtime: 'claude', signal: 'safety', operatorDecision: operatorBinding });
assert(operatorApproved.status === 'selected' && operatorApproved.reasonCode === 'OPERATOR_APPROVAL_SELECTED' && !operatorApproved.operatorEscalation, 'explicit frontier approval did not create a selected continuation');
const operatorAborted = decide(fullAdapters, { slug: 'ariadne', runtime: 'claude', signal: 'safety', operatorDecision: operatorDecisionBinding(operatorEscalation, 'abort') });
assert(operatorAborted.status === 'blocked' && operatorAborted.reasonCode === 'OPERATOR_ABORTED' && !operatorAborted.operatorEscalation, 'explicit frontier abort did not remain terminal');

const deterministicAgain = decide(adapters, {
  slug: 'aegis', runtime: 'claude', signal: 'normal', createdAt: '2026-07-12T12:30:00.000Z',
});
assert(deterministicAgain.decisionId === actualClaudeBaseline.decisionId, 'decisionId depends on creation time');
const nextAttempt = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'normal', attempt: 2 });
assert(nextAttempt.decisionId !== actualClaudeBaseline.decisionId, 'decisionId does not bind the attempt');
const nextDispatch = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'normal', dispatchId: 'dispatch-aegis-002' });
assert(nextDispatch.decisionId !== actualClaudeBaseline.decisionId, 'decisionId does not bind the dispatchId');

const artifactRoot = '/tmp/argus-model-routing-smoke';
const validBinding = validateModelDecisionBinding(policy, adapters, actualClaudeBaseline, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, actualClaudeBaseline.relativePath),
  artifactRoot,
  modelTrust,
});
assert(validBinding.length === 0, `valid decision binding failed: ${validBinding.join('; ')}`);
const noTrustErrors = validateModelDecisionBinding(policy, adapters, actualClaudeBaseline, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, actualClaudeBaseline.relativePath),
  artifactRoot,
});
assert(noTrustErrors.some((error) => error.includes('model trust')), 'decision binding did not fail closed without a pinned trust key');
assert(validateModelDecisionBinding(policy, adapters, codexAttestedBaseline, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, codexAttestedBaseline.relativePath),
  artifactRoot,
}).some((error) => error.includes('runtime attestation authentication')), 'signed runtime attestation did not fail closed without a trust key');
assert(validateModelDecisionBinding(policy, fullAdapters, operatorApproved, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, operatorApproved.relativePath),
  artifactRoot,
}).some((error) => error.includes('operator decision authentication')), 'signed operator decision did not fail closed without a trust key');
assert(validateModelDecisionBinding(policy, fullAdapters, operatorApproved, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, operatorApproved.relativePath),
  artifactRoot,
  modelTrust,
}).length === 0, 'valid signed operator decision failed authentication');

const replayedAttestation = structuredClone(codexAttestedBaseline);
replayedAttestation.runtimeAttestation.dispatchId = 'replayed-other-dispatch';
replayedAttestation.integritySha256 = modelDecisionIntegritySha256(replayedAttestation);
const replayErrors = validateModelDecisionBinding(policy, adapters, replayedAttestation, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, replayedAttestation.relativePath),
  artifactRoot,
  modelTrust,
});
assert(replayErrors.length > 0, 'persisted decision replay accepted an attestation scoped to another dispatch');
for (const [field, value] of [
  ['parentSessionId', 'forged-parent-session'],
  ['issuedBy', 'forged-runtime'],
  ['issuedAt', '2026-07-12T11:58:59.999Z'],
  ['expiresAt', '2026-07-12T12:10:00.001Z'],
  ['documentSha256', 'e'.repeat(64)],
]) {
  const tampered = structuredClone(codexAttestedBaseline);
  tampered.runtimeAttestation[field] = value;
  tampered.integritySha256 = modelDecisionIntegritySha256(tampered);
  const errors = validateModelDecisionBinding(policy, adapters, tampered, {
    engagementId: baseContext.engagementId,
    engagementManifestSha256: baseContext.engagementManifestSha256,
    modelTrust,
  });
  assert(errors.some((error) => error.includes('signed')), `persisted decision accepted unsigned compact runtimeAttestation.${field}`);
}
const tamperedSignature = structuredClone(codexAttestedBaseline);
tamperedSignature.runtimeAttestation.authentication.signatureBase64 = `${tamperedSignature.runtimeAttestation.authentication.signatureBase64[0] === 'A' ? 'B' : 'A'}${tamperedSignature.runtimeAttestation.authentication.signatureBase64.slice(1)}`;
tamperedSignature.integritySha256 = modelDecisionIntegritySha256(tamperedSignature);
assert(validateModelDecisionBinding(policy, adapters, tamperedSignature, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, tamperedSignature.relativePath),
  artifactRoot,
  modelTrust,
}).some((error) => error.includes('signature')), 'tampered runtime-attestation signature passed binding validation');
for (const [field, value] of [
  ['approvedBy', 'forged-operator'],
  ['approvedAt', '2026-07-12T12:01:00.001Z'],
  ['reason', 'Forged unsigned disposition.'],
  ['documentSha256', 'f'.repeat(64)],
]) {
  const tampered = structuredClone(operatorApproved);
  tampered.operatorDecision[field] = value;
  tampered.integritySha256 = modelDecisionIntegritySha256(tampered);
  const errors = validateModelDecisionBinding(policy, fullAdapters, tampered, {
    engagementId: baseContext.engagementId,
    engagementManifestSha256: baseContext.engagementManifestSha256,
    modelTrust,
  });
  assert(errors.some((error) => error.includes('signed')), `persisted decision accepted unsigned compact operatorDecision.${field}`);
}
const wrongKeys = generateKeyPairSync('ed25519');
const wrongPem = wrongKeys.publicKey.export({ type: 'spki', format: 'pem' });
const wrongTrust = structuredClone(modelTrust);
wrongTrust.keys.runtimeAttestation.publicKeyPem = wrongPem;
wrongTrust.keys.runtimeAttestation.keyFingerprintSha256 = modelPublicKeyFingerprint(wrongPem);
assert(validateModelDecisionBinding(policy, adapters, codexAttestedBaseline, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  decisionPath: join(artifactRoot, codexAttestedBaseline.relativePath),
  artifactRoot,
  modelTrust: wrongTrust,
}).some((error) => error.includes('authentication')), 'runtime attestation passed under the wrong pinned key');
const reusedPurposeTrust = structuredClone(modelTrust);
reusedPurposeTrust.keys.operatorApproval.publicKeyPem = runtimePublicKeyPem;
reusedPurposeTrust.keys.operatorApproval.keyFingerprintSha256 = modelTrust.keys.runtimeAttestation.keyFingerprintSha256;
assert(validateModelDecisionBinding(policy, adapters, actualClaudeBaseline, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  modelTrust: reusedPurposeTrust,
}).some((error) => error.includes('distinct')), 'one public key was accepted for both trust purposes');
const swappedPurpose = structuredClone(codexAttestedBaseline);
swappedPurpose.runtimeAttestation.authentication.purpose = 'operator-approval';
swappedPurpose.integritySha256 = modelDecisionIntegritySha256(swappedPurpose);
assert(validateModelDecisionBinding(policy, adapters, swappedPurpose, {
  engagementId: baseContext.engagementId,
  engagementManifestSha256: baseContext.engagementManifestSha256,
  modelTrust,
}).some((error) => error.includes('authentication')), 'runtime attestation accepted an operator-approval proof purpose');

for (const mutate of [
  (decision) => { decision.selectedConfig.model = 'tampered-model'; },
  (decision) => { decision.status = 'blocked'; decision.reasonCode = 'CAPABILITY_DRIFT'; },
  (decision) => { decision.adapter.snapshotSha256 = 'b'.repeat(64); },
  (decision) => { decision.policySha256 = 'c'.repeat(64); },
]) {
  const tampered = structuredClone(actualClaudeBaseline);
  mutate(tampered);
  tampered.integritySha256 = modelDecisionIntegritySha256(tampered);
  const errors = validateModelDecisionBinding(policy, adapters, tampered, {
    engagementId: baseContext.engagementId,
    engagementManifestSha256: baseContext.engagementManifestSha256,
    decisionPath: join(artifactRoot, tampered.relativePath),
    artifactRoot,
    modelTrust,
  });
  assert(errors.length > 0, 'tampered decision passed semantic binding after its integrity hash was recomputed');
}

const telemetry = buildModelTelemetryEvent(policy, actualClaudeBaseline, {
  inputTokens: 120,
  outputTokens: 30,
  durationMs: 450,
  reportedCostUsd: 0.012,
  success: true,
}, '2026-07-12T13:00:00.000Z');
assert(validateTelemetry(telemetry).length === 0, 'decision-bound telemetry does not satisfy schema v2');
assert(telemetry.decisionId === actualClaudeBaseline.decisionId, 'telemetry is not bound to the decisionId');
assert(telemetry.reasonCode === actualClaudeBaseline.reasonCode, 'telemetry did not copy reasonCode from the decision');
assert(telemetry.adapterId === actualClaudeBaseline.adapter.adapterId, 'telemetry did not copy adapterId from the decision');
assert(telemetry.adapterSnapshotSha256 === actualClaudeBaseline.adapter.snapshotSha256, 'telemetry did not copy the exact adapter snapshot digest');
for (const forbidden of ['prompt', 'completion', 'target', 'url', 'path', 'account', 'token', 'evidence']) {
  assert(!Object.hasOwn(telemetry, forbidden), `telemetry leaked forbidden field ${forbidden}`);
}

testJitCodexDispatchAuthorization();

console.log('PASS  Argus model routing unit contract: immutable v2 decisions, honest adapters, exact capability drift, semantic tamper rejection, decision-bound telemetry v2');

function decide(snapshot, overrides) {
  const decision = resolveModelDecision(policy, snapshot, { ...baseContext, ...overrides });
  const errors = validateDecision(decision);
  assert(errors.length === 0, `model decision schema rejected ${overrides.runtime}/${overrides.signal}: ${errors.map((error) => `${error.instancePath} ${error.message}`).join('; ')}`);
  return decision;
}

function assertPolicyMutation(mutate, label) {
  const copy = structuredClone(policy);
  mutate(copy);
  assert(
    validateModelPolicy(copy, copy.roles.map((role) => role.slug)).some((error) => error.includes('adopted mapping') || error.includes('bounded-subrole')),
    `${label} mutation passed model-policy validation`,
  );
}

function codexAttestation(snapshot, selectedConfig, overrides = {}) {
  const signed = signModelDocument({
    schema: 'argus/model-runtime-attestation@1',
    kind: 'MODEL_RUNTIME_ATTESTATION',
    engagementId: baseContext.engagementId,
    dispatchId: baseContext.dispatchId,
    attempt: baseContext.attempt,
    agent: 'aegis',
    runtime: 'codex',
    parentRuntime: 'codex',
    adapterContractId: snapshot.contractId,
    adapterId: snapshot.codex.adapterId,
    parentSessionId: 'codex-parent-session-001',
    selectedConfig,
    enforcements: { model: true, effort: true, maxTurns: true },
    issuedBy: 'codex-parent',
    issuedAt: '2026-07-12T11:59:00.000Z',
    expiresAt: '2026-07-12T12:10:00.000Z',
    reason: 'The parent enforces the exact selected configuration and hard turn cap.',
    ...overrides,
  });
  return {
    engagementId: signed.document.engagementId,
    dispatchId: signed.document.dispatchId,
    attempt: signed.document.attempt,
    agent: signed.document.agent,
    runtime: signed.document.runtime,
    parentRuntime: signed.document.parentRuntime,
    adapterContractId: signed.document.adapterContractId,
    adapterId: signed.document.adapterId,
    parentSessionId: signed.document.parentSessionId,
    adapterSnapshotSha256: adapterSnapshotSha256(snapshot),
    selectedConfigSha256: modelConfigSha256(signed.document.selectedConfig),
    enforcements: signed.document.enforcements,
    issuedBy: signed.document.issuedBy,
    issuedAt: signed.document.issuedAt,
    expiresAt: signed.document.expiresAt,
    documentSha256: modelAuthenticatedDocumentSha256(signed.document),
    authentication: signed.authentication,
  };
}

function operatorDecisionBinding(blocked, action) {
  const signed = signModelDocument({
    schema: 'argus/model-operator-decision@1',
    kind: 'MODEL_OPERATOR_DECISION',
    engagementId: blocked.engagementId,
    dispatchId: blocked.dispatchId,
    attempt: blocked.attempt,
    agent: blocked.agent,
    signal: blocked.signal,
    blockedDecisionId: blocked.decisionId,
    action,
    approvedBy: 'routing-unit-operator',
    approvedAt: '2026-07-12T12:01:00.000Z',
    reason: 'Explicit signed operator disposition.',
  });
  return {
    action,
    blockedDecisionId: blocked.decisionId,
    approvedBy: signed.document.approvedBy,
    approvedAt: signed.document.approvedAt,
    reason: signed.document.reason,
    documentSha256: modelAuthenticatedDocumentSha256(signed.document),
    authentication: signed.authentication,
  };
}

function signModelDocument(document) {
  const signed = structuredClone(document);
  const runtime = ['MODEL_RUNTIME_ATTESTATION', 'MODEL_DISPATCH_AUTHORIZATION'].includes(signed.kind);
  const trustKey = runtime ? modelTrust.keys.runtimeAttestation : modelTrust.keys.operatorApproval;
  const signingKey = runtime ? runtimeSigningKeys.privateKey : operatorSigningKeys.privateKey;
  signed.authentication = {
    algorithm: 'Ed25519',
    keyId: trustKey.keyId,
    purpose: trustKey.purpose,
    keyFingerprintSha256: trustKey.keyFingerprintSha256,
    signatureBase64: '',
  };
  const payload = modelAuthenticationPayload(signed);
  signed.authentication.signatureBase64 = signSignature(null, Buffer.from(payload), signingKey).toString('base64');
  return {
    document: signed,
    authentication: { ...signed.authentication, canonicalPayloadBase64: Buffer.from(payload).toString('base64') },
  };
}

function testJitCodexDispatchAuthorization() {
  const root = mkdtempSync(join(tmpdir(), 'argus-jit-dispatch-'));
  try {
    const template = readJson('argus/policies/engagement.template.json');
    const manifest = createDefaultEngagement({
      template,
      target: root,
      targetRoot: root,
      artifactRoot: root,
      mode: 'A',
      engagementId: baseContext.engagementId,
      selectedAgents: ['odysseus'],
    });
    manifest.modelTrust = structuredClone(modelTrust);
    initializeEngagementState(manifest);
    const preview = decide(adapters, {
      slug: 'odysseus', runtime: 'codex', signal: 'normal', dispatchId: 'dispatch-odysseus-001',
    });
    const decision = decide(adapters, {
      slug: 'odysseus', runtime: 'codex', signal: 'normal', dispatchId: 'dispatch-odysseus-001',
      runtimeAttestation: codexAttestation(adapters, preview.selectedConfig, {
        agent: 'odysseus', dispatchId: 'dispatch-odysseus-001', parentSessionId: 'codex-parent-jit-001',
      }),
    });
    const decisionDirectory = join(root, 'ai_agents_internal/model-decisions');
    mkdirSync(decisionDirectory, { recursive: true });
    writeFileSync(join(decisionDirectory, `${decision.decisionId}.json`), `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 });
    const executionBinding = {
      modelDecisionId: decision.decisionId,
      modelDecisionIntegritySha256: decision.integritySha256,
      dispatchId: decision.dispatchId,
      attempt: decision.attempt,
      runtime: decision.runtime,
    };
    assertThrows(() => allocateWorker(manifest, 'odysseus', { executionBinding }), 'Codex allocation accepted no JIT dispatch authorization');
    const first = dispatchAuthorization(decision, {
      allocationId: 'c'.repeat(24),
      issuedAt: new Date(Date.now() - 2_000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'jit-dispatch-nonce-0001',
    });
    assert(validateDispatchAuthorization(first).length === 0, 'valid JIT dispatch authorization failed its schema');
    const allocation = allocateWorker(manifest, 'odysseus', { executionBinding, dispatchAuthorization: first });
    assert(allocation.allocationId === first.allocationId, 'Codex allocation did not bind the signed allocation identity');
    assert(allocation.dispatchAuthorizationSha256 === modelAuthenticatedDocumentSha256(first), 'Codex allocation did not bind the signed JIT document');
    assertThrows(
      () => allocateWorker(manifest, 'odysseus', { resumeToken: allocation.token, executionBinding, dispatchAuthorization: first }),
      'exact JIT authorization replay was accepted twice',
    );
    const repeatedNonce = dispatchAuthorization(decision, {
      allocationId: first.allocationId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: first.nonce,
      reason: 'A different signed document may not reuse a consumed nonce.',
    });
    assertThrows(
      () => allocateWorker(manifest, 'odysseus', { resumeToken: allocation.token, executionBinding, dispatchAuthorization: repeatedNonce }),
      'refreshed JIT dispatch authorization reused its consumed nonce',
    );
    const refreshed = dispatchAuthorization(decision, {
      allocationId: first.allocationId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'jit-dispatch-nonce-0002',
    });
    const resumed = allocateWorker(manifest, 'odysseus', { resumeToken: allocation.token, executionBinding, dispatchAuthorization: refreshed });
    assert(resumed.dispatchAuthorizationSha256 === modelAuthenticatedDocumentSha256(refreshed), 'fresh JIT authorization did not replace the active dispatch binding');
    assert(resumed.dispatchAuthorizationHistory.length === 2, 'fresh JIT authorization was not recorded in bounded replay history');
    assertThrows(
      () => allocateWorker(manifest, 'odysseus', { resumeToken: allocation.token, executionBinding, dispatchAuthorization: first }),
      'older JIT dispatch authorization replaced a newer active binding',
    );
    const wrongDecision = dispatchAuthorization(decision, { allocationId: first.allocationId, decisionId: `MDR-${'f'.repeat(24)}`, nonce: 'jit-dispatch-nonce-0003' });
    assertThrows(
      () => allocateWorker(manifest, 'odysseus', { resumeToken: allocation.token, executionBinding, dispatchAuthorization: wrongDecision }),
      'JIT dispatch authorization for another decision was accepted',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function dispatchAuthorization(decision, overrides = {}) {
  const now = Date.now();
  return signModelDocument({
    schema: 'argus/model-dispatch-authorization@1',
    kind: 'MODEL_DISPATCH_AUTHORIZATION',
    engagementId: decision.engagementId,
    decisionId: decision.decisionId,
    decisionIntegritySha256: decision.integritySha256,
    allocationId: 'c'.repeat(24),
    agent: decision.agent,
    runtime: 'codex',
    parentRuntime: 'codex',
    parentSessionId: 'codex-parent-jit-001',
    selectedConfigSha256: modelConfigSha256(decision.selectedConfig),
    issuedBy: 'codex-parent',
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
    nonce: 'jit-dispatch-nonce-default',
    reason: 'Trusted wrapper is starting this exact allocation with the immutable selected configuration.',
    ...overrides,
  }).document;
}

function assertThrows(operation, message) {
  try { operation(); }
  catch { return; }
  assert(false, message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

function same(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function assert(value, message) {
  if (!value) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}
