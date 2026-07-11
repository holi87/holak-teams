#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildModelTelemetryEvent,
  modelDecisionIntegritySha256,
  resolveModelDecision,
  validateModelDecisionBinding,
  validateModelPolicy,
} from '../argus/runtime/model-policy.mjs';
import { compileJsonSchema } from '../argus/runtime/json-schema.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = readJson('argus/model-policy.json');
const adapters = readJson('argus/runtime-adapters.json');
const validateAdapters = compileJsonSchema(readJson('argus/schemas/runtime-adapters.schema.json'));
const validateDecision = compileJsonSchema(readJson('argus/schemas/model-decision.schema.json'));
const validateTelemetry = compileJsonSchema(readJson('argus/schemas/model-telemetry-event.schema.json'));
const baseContext = {
  engagementId: 'engagement-routing-smoke',
  engagementManifestSha256: 'a'.repeat(64),
  dispatchId: 'dispatch-aegis-001',
  attempt: 1,
  createdAt: '2026-07-12T12:00:00.000Z',
};

assert(validateModelPolicy(policy, policy.roles.map((role) => role.slug)).length === 0, 'model policy is invalid');
assert(validateAdapters(adapters).length === 0, 'runtime adapter snapshot is invalid');

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
const unavailable = decide(fullAdapters, { slug: 'perseus', runtime: 'claude', signal: 'model-unavailable' });
assert(unavailable.status === 'blocked' && unavailable.reasonCode === 'FRONTIER_UNAVAILABLE', 'frontier unavailability did not fail closed');

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
});
assert(validBinding.length === 0, `valid decision binding failed: ${validBinding.join('; ')}`);

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

console.log('PASS  Argus model routing unit contract: immutable v2 decisions, honest adapters, exact capability drift, semantic tamper rejection, decision-bound telemetry v2');

function decide(snapshot, overrides) {
  const decision = resolveModelDecision(policy, snapshot, { ...baseContext, ...overrides });
  const errors = validateDecision(decision);
  assert(errors.length === 0, `model decision schema rejected ${overrides.runtime}/${overrides.signal}: ${errors.map((error) => `${error.instancePath} ${error.message}`).join('; ')}`);
  return decision;
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
