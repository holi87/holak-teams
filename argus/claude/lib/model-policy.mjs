import { createHash } from 'node:crypto';

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

export function resolveModelDecision(policy, { slug, runtime = 'claude', signal = 'normal', schemaValidated = false, boundedSubrole = false } = {}) {
  if (!['claude', 'codex'].includes(runtime)) throw new Error('runtime must be claude or codex');
  if (!MODEL_SIGNALS.includes(signal)) throw new Error(`unknown model signal: ${signal}`);
  const role = policy.roles.find((item) => item.slug === slug);
  if (!role) throw new Error(`unknown model-policy role: ${slug}`);
  let selectedTier = role.tier;
  let status = 'selected';
  let fallbackUsed = false;
  let operatorEscalation = false;
  let reason = 'role baseline';
  const triggers = policy.escalationProfiles[role.escalationProfile];

  if (signal === 'schema-validated-mechanical') {
    const allowed = role.mechanicalDowngrade === true && schemaValidated && boundedSubrole;
    if (allowed) {
      selectedTier = 'mechanical';
      reason = 'bounded subrole with deterministic schema validation';
    } else {
      reason = 'mechanical downgrade denied for a full role or missing validation evidence';
    }
  } else if (signal === 'model-unavailable') {
    if (role.tier === 'standard') {
      selectedTier = 'frontier';
      fallbackUsed = true;
      reason = 'standard model unavailable; upward-only fallback';
    } else {
      status = 'blocked';
      operatorEscalation = true;
      reason = 'frontier model unavailable; weaker fallback forbidden';
    }
  } else if (triggers.includes(signal)) {
    if (role.tier === 'standard') {
      selectedTier = 'frontier';
      fallbackUsed = true;
      reason = `${signal} trigger requires frontier reasoning`;
    } else {
      operatorEscalation = true;
      reason = `${signal} trigger retains frontier and escalates the decision`;
    }
  }

  const tier = policy.tiers[selectedTier];
  const runtimePolicy = tier[runtime];
  return {
    schema: 'argus/model-decision@1',
    policyId: policy.policyId,
    agent: slug,
    runtime,
    signal,
    status,
    baselineTier: role.tier,
    selectedTier,
    model: runtimePolicy.model,
    effort: runtime === 'claude' ? runtimePolicy.effort : runtimePolicy.reasoningEffort,
    maxTurns: role.maxTurns,
    escalationProfile: role.escalationProfile,
    fallbackPolicy: role.fallbackPolicy,
    fallbackUsed,
    operatorEscalation,
    weakerFallbackAllowed: false,
    reason,
  };
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
    agent: decision.agent,
    runtime: decision.runtime,
    tier: decision.selectedTier,
    model: decision.model,
    effort: decision.effort,
    maxTurns: decision.maxTurns,
    signal: decision.signal,
    fallbackUsed: decision.fallbackUsed,
    success: metrics.success,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    totalTokens: metrics.inputTokens + metrics.outputTokens,
    durationMs: metrics.durationMs,
  };
  if (metrics.reportedCostUsd !== undefined) event.reportedCostUsd = metrics.reportedCostUsd;
  const identity = JSON.stringify({ ...event, eventId: undefined });
  event.eventId = `MDL-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
  const unexpected = Object.keys(event).filter((field) => !policy.telemetry.allowedFields.includes(field));
  if (unexpected.length) throw new Error(`telemetry emitted forbidden fields: ${unexpected.join(', ')}`);
  return event;
}
