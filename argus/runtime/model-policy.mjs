import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
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

export function modelConfigSha256(config) {
  return sha256(stableJson(config));
}

export function modelAuthenticatedDocumentSha256(document) {
  return sha256(stableJson(document));
}

export function modelPublicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('model trust key must be Ed25519');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}

export function modelAuthenticationPayload(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || !document.authentication || typeof document.authentication !== 'object') {
    throw new Error('signed model document requires authentication metadata');
  }
  const payload = structuredClone(document);
  delete payload.authentication.signatureBase64;
  return stableJson(payload);
}

export function verifyModelDocumentAuthentication(document, modelTrust) {
  const trust = validateModelTrust(modelTrust);
  const expected = ['MODEL_RUNTIME_ATTESTATION', 'MODEL_DISPATCH_AUTHORIZATION'].includes(document?.kind)
    ? { slot: 'runtimeAttestation', purpose: 'runtime-attestation', identityField: 'issuedBy' }
    : document?.kind === 'MODEL_OPERATOR_DECISION'
      ? { slot: 'operatorApproval', purpose: 'operator-approval', identityField: 'approvedBy' }
      : null;
  if (!expected) throw new Error('signed model document kind has no trusted key purpose');
  const trustKey = trust.keys[expected.slot];
  const authentication = document?.authentication;
  if (authentication?.algorithm !== 'Ed25519' || authentication.keyId !== trustKey.keyId ||
      authentication.purpose !== expected.purpose || authentication.keyFingerprintSha256 !== trustKey.keyFingerprintSha256) {
    throw new Error(`model document authentication does not match the pinned ${expected.purpose} trust anchor`);
  }
  if (document[expected.identityField] !== trustKey.subjectId) throw new Error(`model document ${expected.identityField} differs from the pinned signer subject`);
  const signature = decodeBase64(authentication.signatureBase64, 'model document signature', 64);
  const payload = modelAuthenticationPayload(document);
  if (!verifySignature(null, Buffer.from(payload), createPublicKey(trustKey.publicKeyPem), signature)) {
    throw new Error('model document Ed25519 signature is invalid');
  }
  return {
    algorithm: 'Ed25519',
    keyId: trustKey.keyId,
    purpose: expected.purpose,
    keyFingerprintSha256: trustKey.keyFingerprintSha256,
    signatureBase64: authentication.signatureBase64,
    canonicalPayloadBase64: Buffer.from(payload).toString('base64'),
  };
}

export function verifyModelAuthenticationProof(proof, modelTrust) {
  const payload = decodeBase64(proof?.canonicalPayloadBase64, 'canonical model authentication payload').toString('utf8');
  let document;
  try { document = JSON.parse(payload); }
  catch { throw new Error('canonical model authentication payload is not JSON'); }
  if (stableJson(document) !== payload) throw new Error('model authentication payload is not canonical JSON');
  document.authentication ??= {};
  document.authentication.signatureBase64 = proof?.signatureBase64;
  const expected = verifyModelDocumentAuthentication(document, modelTrust);
  if (stableJson(expected) !== stableJson(proof)) throw new Error('model authentication proof differs from its signed payload');
  return document;
}

export function resolveModelDecision(policy, adapters, {
  slug,
  runtime,
  signal,
  engagementId,
  engagementManifestSha256,
  dispatchId,
  attempt,
  escalationBinding = null,
  availabilityBinding = null,
  legacyResumeBinding = null,
  operatorDecision = null,
  runtimeAttestation = null,
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
  if (!(escalationBinding === null || (typeof escalationBinding === 'object' && !Array.isArray(escalationBinding)))) throw new Error('escalationBinding must be an object or null');
  if (!(availabilityBinding === null || (typeof availabilityBinding === 'object' && !Array.isArray(availabilityBinding)))) throw new Error('availabilityBinding must be an object or null');
  if (!(legacyResumeBinding === null || (typeof legacyResumeBinding === 'object' && !Array.isArray(legacyResumeBinding)))) throw new Error('legacyResumeBinding must be an object or null');
  if (!(operatorDecision === null || (typeof operatorDecision === 'object' && !Array.isArray(operatorDecision)))) throw new Error('operatorDecision must be an object or null');
  if (!(runtimeAttestation === null || (typeof runtimeAttestation === 'object' && !Array.isArray(runtimeAttestation)))) throw new Error('runtimeAttestation must be an object or null');
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
  const unavailableSignal = signal === 'model-unavailable';
  if (unavailableSignal !== (availabilityBinding !== null)) {
    throw new Error('model-unavailable requires an exact prior-decision/allocation binding, and no other signal may carry one');
  }
  if (legacyResumeBinding !== null && (signal !== 'normal' || attempt !== 1)) {
    throw new Error('legacyResumeBinding is valid only for a normal attempt 1');
  }
  if (operatorDecision !== null && !(role.tier === 'frontier' && (triggers.includes(signal) || unavailableSignal))) {
    throw new Error('operatorDecision is valid only for a declared or unavailable frontier escalation');
  }
  if (runtimeAttestation !== null && runtime !== 'codex') {
    throw new Error('runtimeAttestation is valid only for Codex routing');
  }

  if (signal === 'normal') {
    // The reviewed baseline is the only non-escalation route.
  } else if (signal === 'schema-validated-mechanical') {
    status = 'blocked';
    reasonCode = 'MECHANICAL_FULL_ROLE_FORBIDDEN';
    reason = 'full-role mechanical downgrade is forbidden; no validated bounded-subrole contract was supplied by the trusted policy';
  } else if (signal === 'model-unavailable') {
    if (role.tier === 'frontier') {
      if (operatorDecision?.action === 'retry-frontier') {
        reasonCode = 'OPERATOR_RETRY_SELECTED';
        reason = 'operator requested a new attempt on the unchanged frontier baseline after availability recovery';
      } else if (operatorDecision?.action === 'abort') {
        status = 'blocked';
        reasonCode = 'OPERATOR_ABORTED';
        reason = 'frontier model unavailability was explicitly aborted by the operator';
      } else if (operatorDecision === null) {
        status = 'blocked';
        reasonCode = 'FRONTIER_UNAVAILABLE';
        reason = 'frontier model unavailable; weaker fallback is forbidden and retry or abort requires an external operator decision';
        operatorEscalation = true;
      } else {
        throw new Error('model-unavailable accepts only retry-frontier or abort operator actions');
      }
    } else {
      if (operatorDecision !== null) throw new Error('standard model unavailability cannot carry an operator decision');
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
    if (operatorDecision?.action === 'continue-frontier') {
      reasonCode = 'OPERATOR_APPROVAL_SELECTED';
      reason = `${signal} retained the frontier baseline after an explicit operator approval`;
    } else if (operatorDecision?.action === 'abort') {
      status = 'blocked';
      reasonCode = 'OPERATOR_ABORTED';
      reason = `${signal} was explicitly aborted by the operator`;
    } else {
      if (operatorDecision !== null) throw new Error('declared frontier escalation accepts only continue-frontier or abort operator actions');
      status = 'blocked';
      reasonCode = 'OPERATOR_ESCALATION_REQUIRED';
      reason = `${signal} retains the frontier baseline but requires an explicit operator decision`;
      operatorEscalation = true;
    }
  }

  const adapterMode = selectedConfig.tier === baselineConfig.tier ? 'baseline' : 'escalation';
  const capabilities = effectiveRoutingCapabilities({
    adapters,
    runtime,
    runtimeAdapter,
    adapterMode,
    runtimeAttestation,
    selectedConfig,
    engagementId,
    dispatchId,
    attempt,
    slug,
    createdAt,
  });
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
    escalationBinding,
    availabilityBinding,
    legacyResumeBinding,
    operatorDecision,
    runtimeAttestation,
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
    escalationBinding,
    availabilityBinding,
    legacyResumeBinding,
    operatorDecision,
    runtimeAttestation,
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
    status: missingCapabilities.length ? (runtime === 'codex' ? 'attestation-required' : 'blocked') : 'ready',
    baselineConfig: modelConfig(policy, role.tier, runtime, role.maxTurns),
    requiredOverrides: [],
    requiredEnforcements: [...REQUIRED_ENFORCEMENTS],
    adapterId: runtimeAdapter.adapterId,
    adapterSnapshotSha256: adapterSnapshotSha256(adapters),
    missingCapabilities,
    reason: missingCapabilities.length
      ? runtime === 'codex'
        ? `${runtimeAdapter.adapterId} requires an external dispatch-bound parent attestation for ${missingCapabilities.join(', ')}`
        : `${runtimeAdapter.adapterId} cannot enforce ${missingCapabilities.join(', ')} for the baseline route`
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
  modelTrust,
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
  if (!sameStrings(decision?.requiredEnforcements, REQUIRED_ENFORCEMENTS)) errors.push('decision requiredEnforcements are incomplete');
  if (decision?.policySha256 !== modelPolicySha256(policy)) errors.push('decision policy hash differs from the packaged policy');
  if (decision?.integritySha256 !== modelDecisionIntegritySha256(decision)) errors.push('decision integrity hash is invalid');
  try { validateModelTrust(modelTrust); }
  catch (error) { errors.push(`decision model trust is invalid: ${error.message}`); }
  validateDecisionAuthentication(decision, modelTrust, errors);
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
      escalationBinding: decision?.escalationBinding,
      availabilityBinding: decision?.availabilityBinding,
      legacyResumeBinding: decision?.legacyResumeBinding,
      operatorDecision: decision?.operatorDecision,
      runtimeAttestation: decision?.runtimeAttestation,
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

function effectiveRoutingCapabilities({
  adapters,
  runtime,
  runtimeAdapter,
  adapterMode,
  runtimeAttestation,
  selectedConfig,
  engagementId,
  dispatchId,
  attempt,
  slug,
  createdAt,
}) {
  const capabilities = structuredClone(runtimeAdapter.routingCapabilities[adapterMode]);
  if (runtimeAttestation === null) return capabilities;
  if (runtime !== 'codex') throw new Error('only Codex may use a parent runtime attestation');
  const expectedIdentity = {
    engagementId,
    dispatchId,
    attempt,
    agent: slug,
    runtime,
    parentRuntime: 'codex',
    adapterContractId: adapters.contractId,
    adapterId: runtimeAdapter.adapterId,
  };
  for (const [field, expected] of Object.entries(expectedIdentity)) {
    if (runtimeAttestation[field] !== expected) throw new Error(`runtime attestation ${field} differs from the route`);
  }
  requireSha256(runtimeAttestation.documentSha256, 'runtimeAttestation.documentSha256');
  requireStableId(runtimeAttestation.parentSessionId, 'runtimeAttestation.parentSessionId');
  if (typeof runtimeAttestation.issuedBy !== 'string' || runtimeAttestation.issuedBy.trim().length === 0) throw new Error('runtime attestation issuedBy is required');
  if (runtimeAttestation.adapterSnapshotSha256 !== adapterSnapshotSha256(adapters)) throw new Error('runtime attestation adapter snapshot differs from the route');
  if (runtimeAttestation.selectedConfigSha256 !== modelConfigSha256(selectedConfig)) throw new Error('runtime attestation selectedConfig differs from the route');
  if (stableJson(runtimeAttestation.enforcements) !== stableJson({ model: true, effort: true, maxTurns: true })) {
    throw new Error('runtime attestation must enforce model, effort, and maxTurns together');
  }
  const issuedAt = Date.parse(runtimeAttestation.issuedAt);
  const expiresAt = Date.parse(runtimeAttestation.expiresAt);
  const routedAt = Date.parse(createdAt);
  if (![issuedAt, expiresAt, routedAt].every(Number.isFinite)) throw new Error('runtime attestation timestamps must be ISO date-times');
  const maximumValiditySeconds = runtimeAdapter.capabilityAttestation?.maxValiditySeconds;
  if (!Number.isInteger(maximumValiditySeconds) || maximumValiditySeconds < 1) throw new Error('Codex runtime adapter attestation policy is invalid');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumValiditySeconds * 1000) throw new Error('runtime attestation validity window is invalid');
  if (routedAt < issuedAt || routedAt > expiresAt) throw new Error('runtime attestation is not valid at routing time');
  return structuredClone(runtimeAttestation.enforcements);
}

function requireStableId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} must be a stable identifier`);
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function validateModelTrust(modelTrust) {
  if (!modelTrust || modelTrust.schema !== 'argus/model-trust-bundle@1' || modelTrust.source !== 'host-trust-store') throw new Error('pinned modelTrust bundle is required');
  requireSha256(modelTrust.trustStoreSha256, 'modelTrust.trustStoreSha256');
  if (typeof modelTrust.pinnedAt !== 'string' || Number.isNaN(Date.parse(modelTrust.pinnedAt))) throw new Error('modelTrust.pinnedAt must be an ISO date-time');
  const expected = { runtimeAttestation: 'runtime-attestation', operatorApproval: 'operator-approval' };
  for (const [slot, purpose] of Object.entries(expected)) {
    const key = modelTrust.keys?.[slot];
    if (!key || key.algorithm !== 'Ed25519' || key.purpose !== purpose || typeof key.publicKeyPem !== 'string' || typeof key.subjectId !== 'string' || !key.subjectId.trim()) {
      throw new Error(`modelTrust ${slot} key is incomplete`);
    }
    requireStableId(key.keyId, `modelTrust.keys.${slot}.keyId`);
    const fingerprint = modelPublicKeyFingerprint(key.publicKeyPem);
    if (key.keyFingerprintSha256 !== fingerprint) throw new Error(`modelTrust ${slot} fingerprint is invalid`);
  }
  if (modelTrust.keys.runtimeAttestation.keyId === modelTrust.keys.operatorApproval.keyId ||
      modelTrust.keys.runtimeAttestation.keyFingerprintSha256 === modelTrust.keys.operatorApproval.keyFingerprintSha256) {
    throw new Error('runtime-attestation and operator-approval trust anchors must be distinct');
  }
  return modelTrust;
}

function validateDecisionAuthentication(decision, modelTrust, errors) {
  if (decision?.runtimeAttestation) {
    try {
      const document = verifyModelAuthenticationProof(decision.runtimeAttestation.authentication, modelTrust);
      const expected = {
        engagementId: decision.engagementId,
        dispatchId: decision.dispatchId,
        attempt: decision.attempt,
        agent: decision.agent,
        runtime: decision.runtime,
        parentRuntime: 'codex',
        adapterContractId: decision.adapter.contractId,
        adapterId: decision.adapter.adapterId,
        parentSessionId: decision.runtimeAttestation.parentSessionId,
        issuedBy: decision.runtimeAttestation.issuedBy,
        issuedAt: decision.runtimeAttestation.issuedAt,
        expiresAt: decision.runtimeAttestation.expiresAt,
      };
      for (const [field, value] of Object.entries(expected)) if (document[field] !== value) errors.push(`runtime attestation signed ${field} differs from decision`);
      if (document.schema !== 'argus/model-runtime-attestation@1' || document.kind !== 'MODEL_RUNTIME_ATTESTATION') errors.push('runtime attestation signed identity is invalid');
      if (modelAuthenticatedDocumentSha256(document) !== decision.runtimeAttestation.documentSha256) errors.push('runtime attestation signed document digest differs from decision');
      if (modelConfigSha256(document.selectedConfig) !== decision.runtimeAttestation.selectedConfigSha256) errors.push('runtime attestation signed configuration differs from decision');
      if (stableJson(document.enforcements) !== stableJson(decision.runtimeAttestation.enforcements)) errors.push('runtime attestation signed enforcements differ from decision');
    } catch (error) {
      errors.push(`runtime attestation authentication is invalid: ${error.message}`);
    }
  }
  if (decision?.operatorDecision) {
    try {
      const document = verifyModelAuthenticationProof(decision.operatorDecision.authentication, modelTrust);
      const expected = {
        engagementId: decision.engagementId,
        dispatchId: decision.dispatchId,
        attempt: decision.attempt,
        agent: decision.agent,
        signal: decision.signal,
        blockedDecisionId: decision.operatorDecision.blockedDecisionId,
        action: decision.operatorDecision.action,
        approvedBy: decision.operatorDecision.approvedBy,
        approvedAt: decision.operatorDecision.approvedAt,
        reason: decision.operatorDecision.reason,
      };
      for (const [field, value] of Object.entries(expected)) if (document[field] !== value) errors.push(`operator decision signed ${field} differs from decision`);
      if (document.schema !== 'argus/model-operator-decision@1' || document.kind !== 'MODEL_OPERATOR_DECISION') errors.push('operator decision signed identity is invalid');
      if (modelAuthenticatedDocumentSha256(document) !== decision.operatorDecision.documentSha256) errors.push('operator decision signed document digest differs from decision');
      if (Date.parse(document.approvedAt) > Date.parse(decision.createdAt) + 300_000) errors.push('operator decision approval time is unreasonably later than the selected decision');
    } catch (error) {
      errors.push(`operator decision authentication is invalid: ${error.message}`);
    }
  }
}

function decodeBase64(value, label, expectedBytes) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${label} is not canonical base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expectedBytes !== undefined && bytes.length !== expectedBytes)) throw new Error(`${label} has an invalid length or encoding`);
  return bytes;
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
