import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const MODEL_SIGNALS = [
  'normal',
  'ambiguity',
  'safety',
  'cross-lane',
  'conflicting-evidence',
  'oracle-ambiguity',
  'schema-validation-failure',
  'repeated-failure',
  'turn-limit',
  'model-unavailable',
  'schema-validated-mechanical',
];

const REQUIRED_ENFORCEMENTS = ['effort', 'maxTurns', 'model'];
const EXPECTED_TIERS = {
  frontier: { rank: 2, qualityCritical: true, claude: { model: 'opus', effort: 'max' }, codex: { model: 'sol', reasoningEffort: 'xhigh' } },
  standard: { rank: 1, qualityCritical: false, claude: { model: 'sonnet', effort: 'medium' }, codex: { model: 'terra', reasoningEffort: 'medium' } },
  mechanical: {
    rank: 0,
    qualityCritical: false,
    claude: { model: 'haiku', effort: 'low' },
    codex: { model: 'luna', reasoningEffort: 'medium' },
    eligibility: ['bounded-subrole', 'no-quality-judgment', 'deterministic-output-schema', 'validator-passes-before-merge'],
  },
};
const EXPECTED_MECHANICAL_DOWNGRADE = {
  fullRoleAllowed: false,
  requiresBoundedSubrole: true,
  requiresDeterministicSchema: true,
  requiresValidatorPass: true,
  forbiddenWhenQualityJudgment: true,
};

export function validateModelPolicy(policy, expectedSlugs = []) {
  const errors = [];
  if (policy?.schemaVersion !== 1 || policy?.policyId !== 'argus/model-policy@1') errors.push('policy identity must be argus/model-policy@1');
  const roles = Array.isArray(policy?.roles) ? policy.roles : [];
  if (roles.length !== 27) errors.push('policy must define exactly 27 roles');
  const slugs = roles.map((role) => role.slug);
  if (new Set(slugs).size !== slugs.length) errors.push('role slugs must be unique');
  if (expectedSlugs.length && JSON.stringify([...slugs].sort()) !== JSON.stringify([...expectedSlugs].sort())) errors.push('policy role inventory differs from the canonical roster');
  const counts = Object.groupBy ? Object.groupBy(roles, (role) => role.tier) : roles.reduce((result, role) => ((result[role.tier] ??= []).push(role), result), {});
  if ((counts.frontier ?? []).length !== 10 || (counts.standard ?? []).length !== 17) errors.push('baseline split must be 10 frontier and 17 standard roles');
  if (stableJson(policy?.tiers) !== stableJson(EXPECTED_TIERS)) errors.push('tier models, effort, rank, quality, and mechanical eligibility differ from the adopted mapping');
  if (stableJson(policy?.mechanicalDowngrade) !== stableJson(EXPECTED_MECHANICAL_DOWNGRADE)) errors.push('mechanical downgrade eligibility differs from the bounded-subrole contract');
  if (policy?.routing?.decisionDirectory !== 'ai_agents_internal/model-decisions' || policy?.routing?.decisionSchema !== 'argus/model-decision@2') {
    errors.push('routing must persist argus/model-decision@2 under ai_agents_internal/model-decisions');
  }
  if (!sameStrings(policy?.routing?.requiredEnforcements, REQUIRED_ENFORCEMENTS)) errors.push('routing must require model, effort, and maxTurns together');
  if (policy?.telemetry?.schema !== 'argus/model-telemetry-event@2') errors.push('telemetry schema must be argus/model-telemetry-event@2');
  for (const role of roles) {
    if (!policy?.tiers?.[role.tier]) errors.push(`${role.slug}: unknown tier ${role.tier}`);
    if (!Number.isInteger(role.maxTurns) || role.maxTurns < 1) errors.push(`${role.slug}: maxTurns must be a positive integer`);
    if (!policy?.escalationProfiles?.[role.escalationProfile]?.length) errors.push(`${role.slug}: escalation profile is missing or empty`);
    if (!policy?.fallbackPolicies?.[role.fallbackPolicy]) errors.push(`${role.slug}: fallback policy is missing`);
    if (role.mechanicalDowngrade !== false) errors.push(`${role.slug}: full-role mechanical downgrade must be false`);
    if (policy?.fallbackPolicies?.[role.fallbackPolicy]?.allowWeakerModel !== false) errors.push(`${role.slug}: weaker fallback must be forbidden`);
    if (role.tier === 'frontier' && role.fallbackPolicy !== 'frontier-fail-closed') errors.push(`${role.slug}: frontier judgment must fail closed`);
    if (role.tier === 'standard' && role.fallbackPolicy !== 'upward-only') errors.push(`${role.slug}: standard fallback must be upward-only`);
  }
  return errors;
}

export function adapterSnapshotSha256(adapters) {
  return sha256(stableJson(adapters));
}

export function modelPolicySha256(policy) {
  return sha256(stableJson(policy));
}

export function resolveModelDecision(policy, adapters, {
  slug,
  runtime,
  signal,
  engagementId,
  engagementManifestSha256,
  dispatchId,
  attempt,
  createdAt = new Date().toISOString(),
} = {}) {
  const policyErrors = validateModelPolicy(policy);
  if (policyErrors.length) throw new Error(`invalid model policy: ${policyErrors.join('; ')}`);
  if (!['claude', 'codex'].includes(runtime)) throw new Error('runtime must be claude or codex');
  requireStableId(engagementId, 'engagementId');
  requireSha256(engagementManifestSha256, 'engagementManifestSha256');
  requireStableId(dispatchId, 'dispatchId');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new Error('createdAt must be an ISO date-time');
  if (typeof signal !== 'string' || signal.length === 0) throw new Error('signal is required');
  const role = policy.roles.find((item) => item.slug === slug);
  if (!role) throw new Error(`unknown model-policy role: ${slug}`);
  const runtimeAdapter = adapters?.[runtime];
  if (adapters?.schemaVersion !== 3 || adapters?.contractId !== 'argus/runtime-adapters@3' || !runtimeAdapter?.adapterId) {
    throw new Error('trusted runtime adapter snapshot is not argus/runtime-adapters@3');
  }

  const baselineConfig = modelConfig(policy, role.tier, runtime, role.maxTurns);
  let selectedConfig = baselineConfig;
  let status = 'selected';
  let reasonCode = 'BASELINE_SELECTED';
  let reason = 'reviewed role baseline selected';
  let fallbackUsed = false;
  let operatorEscalation = false;
  const triggers = policy.escalationProfiles[role.escalationProfile];

  if (signal === 'normal') {
    // The reviewed baseline is the only non-escalation route.
  } else if (signal === 'schema-validated-mechanical') {
    status = 'blocked';
    reasonCode = 'MECHANICAL_FULL_ROLE_FORBIDDEN';
    reason = 'full-role mechanical downgrade is forbidden; no validated bounded-subrole contract was supplied by the trusted policy';
  } else if (signal === 'model-unavailable') {
    if (role.tier === 'frontier') {
      status = 'blocked';
      reasonCode = 'FRONTIER_UNAVAILABLE';
      reason = 'frontier model unavailable; weaker fallback is forbidden';
      operatorEscalation = true;
    } else {
      selectedConfig = modelConfig(policy, 'frontier', runtime, role.maxTurns);
      reasonCode = 'ESCALATION_SELECTED';
      reason = 'standard model unavailable; upward-only frontier route requested';
      fallbackUsed = true;
    }
  } else if (!MODEL_SIGNALS.includes(signal) || !triggers.includes(signal)) {
    status = 'blocked';
    reasonCode = 'SIGNAL_NOT_ALLOWED';
    reason = `signal ${signal} is not allowed by escalation profile ${role.escalationProfile}`;
  } else if (role.tier === 'standard') {
    selectedConfig = modelConfig(policy, 'frontier', runtime, role.maxTurns);
    reasonCode = 'ESCALATION_SELECTED';
    reason = `${signal} requires an upward-only frontier route`;
    fallbackUsed = true;
  } else {
    reasonCode = 'ESCALATION_SELECTED';
    reason = `${signal} retains the frontier baseline and escalates the decision`;
    operatorEscalation = true;
  }

  const adapterMode = selectedConfig.tier === baselineConfig.tier ? 'baseline' : 'escalation';
  const capabilities = structuredClone(runtimeAdapter.routingCapabilities[adapterMode]);
  const requiredOverrides = ['effort', 'model'].filter((field) => selectedConfig[field] !== baselineConfig[field]);
  const missingCapabilities = REQUIRED_ENFORCEMENTS.filter((field) => capabilities[field] !== true);
  if (status === 'selected' && missingCapabilities.length > 0) {
    status = 'blocked';
    reasonCode = 'CAPABILITY_DRIFT';
    reason = `${runtimeAdapter.adapterId} cannot enforce ${missingCapabilities.join(', ')} for the ${adapterMode} route`;
  }

  const snapshotSha256 = adapterSnapshotSha256(adapters);
  const policySha256 = modelPolicySha256(policy);
  const semantic = {
    schema: policy.routing.decisionSchema,
    policyId: policy.policyId,
    policySha256,
    engagementId,
    engagementManifestSha256,
    dispatchId,
    attempt,
    agent: slug,
    runtime,
    signal,
    adapterContractId: adapters.contractId,
    adapterId: runtimeAdapter.adapterId,
    adapterSnapshotSha256: snapshotSha256,
    status,
    reasonCode,
    baselineConfig,
    selectedConfig,
    requiredOverrides,
    requiredEnforcements: [...REQUIRED_ENFORCEMENTS],
    adapterMode,
    adapterCapabilities: capabilities,
    missingCapabilities,
    fallbackUsed,
    operatorEscalation,
    weakerFallbackAllowed: false,
    reason,
  };
  const decisionId = `MDR-${sha256(stableJson(semantic)).slice(0, 24)}`;
  const decision = {
    schema: policy.routing.decisionSchema,
    decisionId,
    integritySha256: '',
    relativePath: `${policy.routing.decisionDirectory}/${decisionId}.json`,
    createdAt,
    policyId: policy.policyId,
    policySha256,
    engagementId,
    engagementManifestSha256,
    dispatchId,
    attempt,
    agent: slug,
    runtime,
    signal,
    status,
    reasonCode,
    baselineConfig,
    selectedConfig,
    requiredOverrides,
    requiredEnforcements: [...REQUIRED_ENFORCEMENTS],
    adapter: {
      contractId: adapters.contractId,
      adapterId: runtimeAdapter.adapterId,
      snapshotSha256,
      runtime,
      mode: adapterMode,
      capabilities,
    },
    missingCapabilities,
    fallbackUsed,
    operatorEscalation,
    weakerFallbackAllowed: false,
    reason,
  };
  decision.integritySha256 = modelDecisionIntegritySha256(decision);
  return decision;
}

export function buildModelRoutingPreview(policy, adapters, { slug, runtime = 'claude' } = {}) {
  const role = policy.roles.find((item) => item.slug === slug);
  if (!role) throw new Error(`unknown model-policy role: ${slug}`);
  const runtimeAdapter = adapters?.[runtime];
  if (!runtimeAdapter?.routingCapabilities?.baseline) throw new Error(`runtime adapter is missing baseline capabilities: ${runtime}`);
  const missingCapabilities = REQUIRED_ENFORCEMENTS.filter((field) => runtimeAdapter.routingCapabilities.baseline[field] !== true);
  return {
    schema: 'argus/model-routing-preview@1',
    policyId: policy.policyId,
    agent: slug,
    runtime,
    status: missingCapabilities.length ? 'blocked' : 'ready',
    baselineConfig: modelConfig(policy, role.tier, runtime, role.maxTurns),
    requiredOverrides: [],
    requiredEnforcements: [...REQUIRED_ENFORCEMENTS],
    adapterId: runtimeAdapter.adapterId,
    adapterSnapshotSha256: adapterSnapshotSha256(adapters),
    missingCapabilities,
    reason: missingCapabilities.length
      ? `${runtimeAdapter.adapterId} cannot enforce ${missingCapabilities.join(', ')} for the baseline route`
      : `${runtimeAdapter.adapterId} can enforce the complete reviewed baseline`,
  };
}

export function modelDecisionIntegritySha256(decision) {
  const copy = structuredClone(decision);
  copy.integritySha256 = '';
  return sha256(stableJson(copy));
}

export function validateModelDecisionBinding(policy, adapters, decision, {
  engagementId,
  engagementManifestSha256,
  decisionPath,
  artifactRoot,
} = {}) {
  const errors = [];
  if (decision?.schema !== policy?.routing?.decisionSchema) errors.push(`decision schema must be ${policy?.routing?.decisionSchema}`);
  if (decision?.policyId !== policy?.policyId) errors.push('decision policyId differs from the packaged policy');
  if (decision?.engagementId !== engagementId) errors.push('decision engagementId differs from the validated engagement');
  if (decision?.engagementManifestSha256 !== engagementManifestSha256) errors.push('decision engagement manifest hash differs from the validated engagement');
  const snapshotSha256 = adapterSnapshotSha256(adapters);
  if (decision?.adapter?.contractId !== adapters?.contractId) errors.push('decision adapter contract differs from the packaged adapter');
  if (decision?.adapter?.adapterId !== adapters?.[decision?.runtime]?.adapterId) errors.push('decision adapterId differs from the packaged runtime adapter');
  if (decision?.adapter?.snapshotSha256 !== snapshotSha256) errors.push('decision adapter snapshot hash differs from the packaged adapter');
  if (decision?.adapter?.runtime !== decision?.runtime) errors.push('decision adapter runtime differs from decision runtime');
  const expectedCapabilities = adapters?.[decision?.runtime]?.routingCapabilities?.[decision?.adapter?.mode];
  if (stableJson(decision?.adapter?.capabilities) !== stableJson(expectedCapabilities)) errors.push('decision adapter capabilities differ from the packaged snapshot');
  if (!sameStrings(decision?.requiredEnforcements, REQUIRED_ENFORCEMENTS)) errors.push('decision requiredEnforcements are incomplete');
  if (decision?.policySha256 !== modelPolicySha256(policy)) errors.push('decision policy hash differs from the packaged policy');
  if (decision?.integritySha256 !== modelDecisionIntegritySha256(decision)) errors.push('decision integrity hash is invalid');
  let expected;
  try {
    expected = resolveModelDecision(policy, adapters, {
      slug: decision?.agent,
      runtime: decision?.runtime,
      signal: decision?.signal,
      engagementId: decision?.engagementId,
      engagementManifestSha256: decision?.engagementManifestSha256,
      dispatchId: decision?.dispatchId,
      attempt: decision?.attempt,
      createdAt: decision?.createdAt,
    });
  } catch (error) {
    errors.push(`decision routing inputs are invalid: ${error.message}`);
  }
  if (expected) {
    const actualSemantic = withoutDecisionPersistence(decision);
    const expectedSemantic = withoutDecisionPersistence(expected);
    if (stableJson(actualSemantic) !== stableJson(expectedSemantic)) errors.push('decision semantics differ from the packaged policy and adapter');
    if (decision?.decisionId !== expected.decisionId) errors.push('decisionId is not deterministic for its immutable routing inputs and semantics');
    if (decision?.relativePath !== expected.relativePath) errors.push('decision relativePath does not match decisionId');
  }
  if (decisionPath !== undefined && artifactRoot !== undefined) {
    const expectedPath = resolve(artifactRoot, decision.relativePath);
    if (resolve(decisionPath) !== expectedPath) errors.push('decision path is not the exact persisted path under the engagement artifact root');
  }
  return [...new Set(errors)];
}

export function buildModelTelemetryEvent(policy, decision, metrics, timestamp = new Date().toISOString()) {
  for (const field of ['inputTokens', 'outputTokens', 'durationMs']) {
    if (!Number.isFinite(metrics[field]) || metrics[field] < 0) throw new Error(`${field} must be a non-negative number`);
  }
  if (typeof metrics.success !== 'boolean') throw new Error('success must be true or false');
  if (metrics.reportedCostUsd !== undefined && (!Number.isFinite(metrics.reportedCostUsd) || metrics.reportedCostUsd < 0)) throw new Error('reportedCostUsd must be a non-negative number');
  const event = {
    schema: policy.telemetry.schema,
    timestamp,
    eventId: '',
    decisionId: decision.decisionId,
    decisionIntegritySha256: decision.integritySha256,
    adapterId: decision.adapter.adapterId,
    adapterSnapshotSha256: decision.adapter.snapshotSha256,
    engagementId: decision.engagementId,
    dispatchId: decision.dispatchId,
    attempt: decision.attempt,
    agent: decision.agent,
    runtime: decision.runtime,
    tier: decision.selectedConfig.tier,
    model: decision.selectedConfig.model,
    effort: decision.selectedConfig.effort,
    maxTurns: decision.selectedConfig.maxTurns,
    signal: decision.signal,
    reasonCode: decision.reasonCode,
    fallbackUsed: decision.fallbackUsed,
    success: metrics.success,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    totalTokens: metrics.inputTokens + metrics.outputTokens,
    durationMs: metrics.durationMs,
  };
  if (metrics.reportedCostUsd !== undefined) event.reportedCostUsd = metrics.reportedCostUsd;
  event.eventId = `MDL-${sha256(stableJson(event)).slice(0, 24)}`;
  const unexpected = Object.keys(event).filter((field) => !policy.telemetry.allowedFields.includes(field));
  if (unexpected.length) throw new Error(`telemetry emitted forbidden fields: ${unexpected.join(', ')}`);
  return event;
}

function modelConfig(policy, tierName, runtime, maxTurns) {
  const runtimePolicy = policy.tiers[tierName][runtime];
  return {
    tier: tierName,
    model: runtimePolicy.model,
    effort: runtime === 'claude' ? runtimePolicy.effort : runtimePolicy.reasoningEffort,
    maxTurns,
  };
}

function requireStableId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} must be a stable identifier`);
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function sameStrings(left, right) {
  return Array.isArray(left) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function withoutDecisionPersistence(decision) {
  if (!decision || typeof decision !== 'object') return decision;
  const { createdAt, decisionId, integritySha256, relativePath, ...semantic } = decision;
  return semantic;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
