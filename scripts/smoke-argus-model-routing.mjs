#!/usr/bin/env node

import { generateKeyPairSync, sign as signSignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildModelRoutingPreview,
  buildModelTelemetryEvent,
  modelAuthenticatedDocumentSha256,
  modelAuthenticationPayload,
  modelDecisionIntegritySha256,
  modelPublicKeyFingerprint,
  resolveModelDecision,
  validateModelDecisionBinding,
  validateModelPolicy,
} from '../argus/runtime/model-policy.mjs';
import { compileJsonSchema } from '../argus/runtime/json-schema.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = readJson('argus/model-policy.json');
const adapters = readJson('argus/runtime-adapters.json');
const benchmark = readJson('argus/model-policy.benchmark.json');
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
assert(validateAdapters(adapters).length === 0, 'runtime adapter snapshot is invalid');
assert(validateBenchmark(benchmark).length === 0, 'model benchmark is invalid');
assert(policy.roles.filter(({ tier }) => tier === 'frontier').length === 10, 'frontier roster count drifted');
assert(policy.roles.filter(({ tier }) => tier === 'standard').length === 17, 'standard roster count drifted');
assert(policy.tiers.frontier.codex.model === 'sol' && policy.tiers.standard.codex.model === 'terra', 'Codex tier mapping drifted');
assert(policy.tiers.frontier.claude.model === 'opus' && policy.tiers.standard.claude.model === 'sonnet', 'Claude tier mapping drifted');

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

const claudeEscalation = decide(adapters, { slug: 'aegis', runtime: 'claude', signal: 'safety' });
assert(claudeEscalation.status === 'blocked' && same(claudeEscalation.missingCapabilities, ['effort']), 'Claude escalation hid its missing effort override');
const full = structuredClone(adapters);
for (const runtime of ['claude', 'codex']) for (const mode of ['baseline', 'escalation']) for (const field of ['model', 'effort', 'maxTurns']) full[runtime].routingCapabilities[mode][field] = true;
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

console.log('PASS  Argus model routing: native Claude enforcement, fail-closed Codex, authenticated frontier decisions, immutable telemetry');

function decide(snapshot, overrides) {
  const decision = resolveModelDecision(policy, snapshot, { ...context, ...overrides });
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

function assertThrows(operation, message) {
  try { operation(); } catch { return; }
  assert(false, message);
}

function readJson(relativePath) { return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')); }
function same(left, right) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function assert(value, message) { if (!value) throw new Error(message); }
