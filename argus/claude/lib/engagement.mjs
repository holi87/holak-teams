import { calculateCoverage, coverageEvidenceReferences } from './coverage.mjs';
import { ledgerEvidenceIds, quarantineFindings, reconcileCoverageEvidence, reconcileFindings } from './finding-quality.mjs';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupersession, collectionOwnershipErrors, isCollectionContract, mergeCanonicalDocuments, migrateCanonicalDocument, renderFinalSummary, schemaId, stableIdentity, validateCanonicalDocument, validateCanonicalFragment } from './contracts.mjs';
import { binaryRegistrationErrors, binaryReviewAuditErrors, isBinaryReference, loadRedactionPatterns, parseAuditLog, validateEvidenceContent } from './evidence.mjs';
import { compileJsonSchema } from './json-schema.mjs';
import {
  modelAuthenticatedDocumentSha256,
  modelConfigSha256,
  modelDecisionIntegritySha256,
  verifyModelDocumentAuthentication,
} from './model-policy.mjs';

const ENGAGEMENT_MANIFEST_VERSION = 2;
const ENGAGEMENT_STATE_VERSION = 3;
// The phase plan is derived from the packaged orchestration plan when the manifest is
// created (derivePhasePlan). The runtime never hard-codes phase ids or lane membership.
const PHASE_WAVES = ['controller', 'W0', 'W1', 'W2', 'W3', 'W4'];
const PHASE_KINDS = ['control', 'work', 'proof', 'deep-hunt'];
const PASS_PHASE_KINDS = ['proof', 'deep-hunt'];
const PHASE_KEYS = ['id', 'wave', 'kind', 'pass', 'skippable', 'participants', 'standby'];
const PROOF_VALIDATOR = 'minos';
const SKIP_REASONS = ['converged', 'controller-budget'];
const LEDGER_SNAPSHOT_STATUSES = [
  ['confirmed', 'confirmed'], ['suspected', 'suspected'], ['needsOracle', 'needs-oracle'],
  ['bounced', 'bounced'], ['quarantined', 'quarantined'],
];
const LEDGER_SNAPSHOT_KEYS = ['fragmentIds', ...LEDGER_SNAPSHOT_STATUSES.map(([field]) => field), 'newConfirmed', 'mergedAt'];
const CANONICAL_MERGE_MODES = ['concatenate', 'latest-revision'];
const HEARTBEAT_STATUSES = ['started', 'running', 'blocked', 'degraded', 'complete', 'failed'];
const EXECUTION_BINDING_FIELDS = ['modelDecisionId', 'modelDecisionIntegritySha256', 'dispatchId', 'attempt', 'runtime'];
const DISPATCH_AUTHORIZATION_FIELDS = [
  'dispatchAuthorizationSha256', 'dispatchAuthorizationNonce', 'dispatchAuthorizedAt',
  'dispatchAuthorizationExpiresAt', 'dispatchParentSessionId',
];
// A conditional lane is sealed with its model decision but allocates only after the
// controller records the recon gate verdicts during discovery. Odysseus resolves the gates
// and Kalchas's discovery arrival is their evidence, so neither can be conditional.
const UNCONDITIONAL_LANES = ['odysseus', 'kalchas'];
const GATE_RESOLUTION_KEYS = ['resolvedAt', 'evidenceSha256', 'capabilities', 'lanes'];
const GATE_VERDICT_KEYS = ['status', 'basis', 'reason'];
const GATE_RESOLUTION_PHASE = 'discovery';

export function createDefaultEngagement({ template, target, targetRoot, artifactRoot, mode, engagementId, selectedAgents, browserSupport, accessibilityRequirement, phasePlan }) {
  if (!Array.isArray(phasePlan)) throw new Error('createDefaultEngagement requires a derived phasePlan');
  const manifest = structuredClone(template);
  const agents = [...new Set(selectedAgents)].sort();
  manifest.$schema = 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/engagement-manifest.schema.json';
  manifest.schemaVersion = ENGAGEMENT_MANIFEST_VERSION;
  manifest.engagementId = engagementId;
  manifest.mode = mode;
  manifest.target = { identifier: target, root: targetRoot };
  manifest.artifactRoot = artifactRoot;
  manifest.selectedAgents = agents;
  manifest.accessibilityPolicy = accessibilityPolicy(manifest.accessibilityPolicy, accessibilityRequirement);
  manifest.browserPolicy.coverage = deriveBrowserCoverage(manifest.browserPolicy.coverage, browserSupport);
  manifest.phasePlan = structuredClone(phasePlan);
  return manifest;
}

export function deriveBrowserCoverage(fallback, support) {
  if (!plainObject(support)) return structuredClone(fallback);
  const browsers = [...new Set(support.browsers ?? [])];
  const viewports = support.viewports ?? [];
  const riskSignals = [...new Set(['accessibility', ...(support.riskSignals ?? [])])];
  if (!nonEmpty(support.source) || !browsers.length || !browsers.every((item) => ['chromium', 'firefox', 'webkit'].includes(item))) {
    throw new Error('browserSupport requires source and supported browsers');
  }
  if (!viewports.length || !viewports.every((item) => nonEmpty(item?.device) && Number.isInteger(item?.width) && Number.isInteger(item?.height) && item.width >= 240 && item.height >= 240)) {
    throw new Error('browserSupport requires named viewports with integer width/height >= 240');
  }
  if (!riskSignals.every(nonEmpty)) throw new Error('browserSupport riskSignals must be non-empty strings');
  return {
    derivation: 'target-support-and-risk',
    supportSource: support.source,
    riskSignals,
    rationale: support.rationale ?? `Coverage includes every declared browser and viewport because target support and ${riskSignals.join(', ')} risks require them.`,
    matrix: browsers.flatMap((browser) => viewports.map((viewport) => ({
      browser,
      device: viewport.device,
      viewport: { width: viewport.width, height: viewport.height },
      reasons: [...new Set([`target-support:${browser}`, `target-support:${viewport.device}`, ...riskSignals])],
    }))),
  };
}

export function validateEngagementManifest(manifest) {
  const errors = [];
  if (!plainObject(manifest)) return ['manifest must be a JSON object'];
  if (manifest.schemaVersion !== ENGAGEMENT_MANIFEST_VERSION) errors.push(`schemaVersion must be ${ENGAGEMENT_MANIFEST_VERSION}`);
  if (!nonEmpty(manifest.engagementId)) errors.push('engagementId is required');
  if (!['A', 'B', 'C', 'D'].includes(manifest.mode)) errors.push('mode must be A, B, C, or D');
  if (!plainObject(manifest.target) || !nonEmpty(manifest.target.identifier) || !(manifest.target.root === null || nonEmpty(manifest.target.root))) {
    errors.push('target identifier/root are invalid');
  }
  if (!nonEmpty(manifest.artifactRoot) || !isAbsolute(manifest.artifactRoot)) errors.push('artifactRoot must be absolute');
  if (!stringList(manifest.selectedAgents, true) || !manifest.selectedAgents.every(validSlug)) errors.push('selectedAgents must contain unique slugs');
  const modelTrust = manifest.modelTrust ?? null;
  const runtimeTrust = modelTrust?.keys?.runtimeAttestation;
  const operatorTrust = modelTrust?.keys?.operatorApproval;
  if (modelTrust !== null && (!plainObject(modelTrust) || modelTrust.schema !== 'argus/model-trust-bundle@1' || modelTrust.source !== 'host-trust-store' ||
      !nonEmpty(modelTrust.trustStorePath) || !isAbsolute(modelTrust.trustStorePath) ||
      !/^[a-f0-9]{64}$/.test(modelTrust.trustStoreSha256 ?? '') || !validDate(modelTrust.pinnedAt) ||
      !validModelTrustKey(runtimeTrust, 'runtime-attestation') || !validModelTrustKey(operatorTrust, 'operator-approval') ||
      runtimeTrust.keyId === operatorTrust.keyId || runtimeTrust.keyFingerprintSha256 === operatorTrust.keyFingerprintSha256)) {
    errors.push('modelTrust must be null or a complete purpose-separated host-trust-store Ed25519 bundle');
  }
  // launchAssurance is the operator's explicit, recorded opt-out of native-launch
  // attestation. Absent means attested. An unknown value is rejected outright rather
  // than silently downgraded, and an unattested engagement can never pin a trust bundle.
  if (manifest.launchAssurance !== undefined && !['attested', 'unattested'].includes(manifest.launchAssurance)) {
    errors.push('launchAssurance must be attested or unattested');
  }
  if (manifest.launchAssurance === 'unattested' && modelTrust !== null) {
    errors.push('an unattested engagement must not pin a modelTrust bundle');
  }
  validateAccessibilityPolicy(manifest.accessibilityPolicy, errors);
  validateBrowserPolicy(manifest.browserPolicy, manifest.selectedAgents, errors);
  validatePhasePlan(manifest.phasePlan, Array.isArray(manifest.selectedAgents) ? manifest.selectedAgents : [], errors);
  const policy = manifest.writePolicy;
  if (!plainObject(policy)) return [...errors, 'writePolicy must be an object'];
  for (const key of ['auditPath', 'fragmentRoot', 'checkpointRoot', 'workerRoot']) {
    if (!safeRelative(policy[key])) errors.push(`writePolicy.${key} must be a safe relative path`);
  }
  for (const key of ['allowedArtifactRoots', 'generatedTestRoots']) {
    if (!stringList(policy[key], false) || !policy[key].every(safeRelative)) errors.push(`writePolicy.${key} must contain safe relative paths`);
  }
  if (!Array.isArray(policy.canonicalArtifacts) || policy.canonicalArtifacts.length === 0) {
    errors.push('writePolicy.canonicalArtifacts must be non-empty');
  } else {
    const paths = new Set();
    for (const item of policy.canonicalArtifacts) {
      if (!safeRelative(item?.path) || !validSlug(item?.owner) || !['markdown', 'text', 'json', 'json-document'].includes(item?.format) || (item.schema !== undefined && ![null, 'bug-ledger', 'lane-plan', 'evidence-reference', 'automation-status', 'surface-inventory', 'coverage-observations', 'coverage-result', 'final-summary', 'automation-review'].includes(item.schema)) || (item.schema && item.format !== 'json-document')) {
        errors.push('canonical artifact path, owner, or format is invalid');
      } else if (paths.has(item.path)) errors.push(`duplicate canonical artifact: ${item.path}`);
      else paths.add(item.path);
      errors.push(...canonicalMergeErrors(item));
    }
  }
  validateOwnedWritePolicy(policy, errors);
  const bypass = policy.bypass;
  if (!plainObject(bypass) || typeof bypass.enabled !== 'boolean' || !stringList(bypass.allowedPaths, false) || !bypass.allowedPaths.every(safeRelative)) {
    errors.push('writePolicy.bypass is invalid');
  } else if (bypass.enabled && (!nonEmpty(bypass.approvedBy) || !nonEmpty(bypass.reason) || !validDate(bypass.expiresAt) || !/^[a-f0-9]{64}$/.test(bypass.tokenSha256 ?? '') || bypass.allowedPaths.length === 0)) {
    errors.push('enabled bypass requires approver, reason, expiry, exact paths, and tokenSha256');
  }
  const resource = manifest.resourcePolicy;
  if (!plainObject(resource) || !plainObject(resource.portRange) || !Number.isInteger(resource.portRange.start) || !Number.isInteger(resource.portRange.end) || resource.portRange.start < 1024 || resource.portRange.end > 65535 || resource.portRange.end < resource.portRange.start) {
    errors.push('resourcePolicy.portRange is invalid');
  } else if (resource.portRange.end - resource.portRange.start + 1 < manifest.selectedAgents.length) {
    errors.push('resourcePolicy.portRange is too small for selectedAgents');
  }
  if (!plainObject(resource?.exclusiveOperations) || !Object.values(resource.exclusiveOperations).every(validSlug)) errors.push('exclusive operation owners are invalid');
  if (!plainObject(manifest.idAllocators) || Object.keys(manifest.idAllocators).length === 0) errors.push('idAllocators must be non-empty');
  else for (const [kind, allocator] of Object.entries(manifest.idAllocators)) {
    if (!validSlug(allocator?.owner) || !/^[A-Z][A-Z0-9-]*$/.test(allocator?.prefix ?? '') || !Number.isInteger(allocator?.width) || allocator.width < 1) errors.push(`idAllocators.${kind} is invalid`);
  }
  const cleanupKeys = ['browser-profile', 'browser-artifacts', 'auth', 'tmp', 'locks'];
  if (!plainObject(manifest.cleanup) || !stringList(manifest.cleanup.removeOnRelease, true) || !cleanupKeys.every((key) => manifest.cleanup.removeOnRelease.includes(key))) {
    errors.push(`cleanup.removeOnRelease must include ${cleanupKeys.join(', ')}`);
  }
  if (!safeRelative(manifest.statePath)) errors.push('statePath must be a safe relative path');
  return [...new Set(errors)];
}

export function createInitialEngagementState(manifest) {
  const phases = phaseIds(manifest);
  return {
    $schema: 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/engagement-state.schema.json',
    schemaVersion: ENGAGEMENT_STATE_VERSION,
    engagementId: manifest.engagementId,
    revision: 0,
    currentPhase: phases[1],
    completedPhases: ['preflight'],
    skippedPhases: {},
    dispatchableAgents: null,
    conditionalAgents: null,
    gateResolution: null,
    allocations: {},
    barriers: Object.fromEntries(phases.map((phase) => [phase, []])),
    exclusiveLocks: {},
    nextIds: Object.fromEntries(Object.keys(manifest.idAllocators).map((kind) => [kind, 1])),
    idKeys: Object.fromEntries(Object.keys(manifest.idAllocators).map((kind) => [kind, {}])),
    checkpoints: {},
    fragments: {},
    merges: {},
    ledgerSnapshots: {},
  };
}

export function initializeEngagementState(manifest) {
  const statePath = engagementPath(manifest, manifest.statePath);
  if (existsSync(statePath)) {
    const state = withStateLock(manifest, () => readState(manifest, { persistMigration: true }));
    return { state, created: false, path: statePath };
  }
  mkdirSync(dirname(statePath), { recursive: true });
  atomicWriteJson(statePath, createInitialEngagementState(manifest));
  return { state: readState(manifest), created: true, path: statePath };
}

export function bindDispatchableAgents(manifest, agents, conditional = {}) {
  const normalized = [...new Set(agents ?? [])].sort();
  if (!normalized.includes('odysseus') || normalized.some((lane) => !manifest.selectedAgents.includes(lane))) {
    throw new Error('dispatchable agent projection must include Odysseus and remain within selectedAgents');
  }
  const conditionalAgents = normalizeConditionalAgents(conditional, normalized);
  return mutateState(manifest, (state) => {
    if (Object.values(state.allocations).some((allocation) => allocation.status === 'active')) {
      throw new Error('dispatchable agent projection must be sealed before allocation');
    }
    if (Array.isArray(state.dispatchableAgents)) {
      if (JSON.stringify(state.dispatchableAgents) !== JSON.stringify(normalized) ||
          JSON.stringify(state.conditionalAgents) !== JSON.stringify(conditionalAgents)) {
        throw new Error('dispatchable agent projection is immutable once bound');
      }
      return { result: normalized, changed: false };
    }
    state.dispatchableAgents = normalized;
    state.conditionalAgents = conditionalAgents;
    return { result: normalized, changed: true };
  });
}

// Conditional lanes are dispatchable workers whose preflight record still waits on target or
// browser gates. Keys and gate lists are sorted so the bound projection compares byte-stably.
function normalizeConditionalAgents(conditional, dispatchable) {
  if (conditional === null || conditional === undefined) return {};
  if (!plainObject(conditional)) throw new Error('conditional lanes must be an object of lane gate lists');
  const normalized = {};
  for (const lane of Object.keys(conditional).sort()) {
    if (!dispatchable.includes(lane) || UNCONDITIONAL_LANES.includes(lane)) {
      throw new Error(`conditional lane ${lane} must be a dispatchable worker other than ${UNCONDITIONAL_LANES.join(' and ')}`);
    }
    const gates = conditional[lane];
    if (!Array.isArray(gates) || gates.length === 0 || !gates.every(validCapabilityId)) {
      throw new Error(`conditional lane ${lane} must list one or more capability ids`);
    }
    normalized[lane] = [...new Set(gates)].sort();
  }
  return normalized;
}

export function allocateWorker(manifest, lane, { resumeToken, controllerToken, executionBinding, dispatchAuthorization } = {}) {
  requireSelected(manifest, lane);
  return mutateState(manifest, (state) => {
    requireDispatchableState(state, lane);
    requireConditionalRelease(state, lane);
    const workerRoot = engagementPath(manifest, join(manifest.writePolicy.workerRoot, lane));
    const leasePath = join(workerRoot, '.lease');
    const leaseEntry = lstatEntry(leasePath);
    if (leaseEntry?.isSymbolicLink()) throw new Error(`unsafe symbolic lease entry for ${lane}`);
    const existing = state.allocations[lane];
    const effectiveControllerToken = controllerToken ?? (lane === 'odysseus' ? resumeToken : null);
    if (existing?.status === 'active' && leaseEntry) {
      requireLeaseState(manifest, state, lane, resumeToken);
      requireLiveLeaseFile(manifest, state, lane, resumeToken, { allowMigratedToken: true });
      requireControllerAllocation(manifest, state, lane, effectiveControllerToken);
      if (!hasExecutionBinding(existing)) throw new Error(`${lane} allocation must bind its authenticated model decision before resume`);
      if (executionBinding && !sameExecutionBinding(existing, executionBinding)) throw new Error(`${lane} resume decision differs from its active allocation`);
      const dispatchBinding = validateDispatchAuthorization(manifest, lane, existing, dispatchAuthorization, existing.allocationId);
      if (existing.runtime === 'codex') {
        validateDispatchAuthorizationUse(manifest, state, lane, existing, dispatchBinding, { operation: 'resume' });
        Object.assign(existing, dispatchBindingWithHistory(existing, dispatchBinding));
        return { result: { ...publicAllocation(existing), token: resumeToken, resumed: true }, changed: true };
      }
      return { result: { ...publicAllocation(existing), token: resumeToken, resumed: true }, changed: false };
    }
    if (leaseEntry) throw new Error(`unexpected existing lease file for ${lane}`);
    const recoveredFromCrash = existing?.status === 'active';
    let binding;
    let dispatchBinding;
    if (recoveredFromCrash) {
      binding = validateExecutionBinding(executionBinding);
      requireLeaseState(manifest, state, lane, resumeToken);
      requireControllerAllocation(manifest, state, lane, effectiveControllerToken, { selfRecovery: lane === 'odysseus' });
      if (!hasExecutionBinding(existing)) throw new Error(`${lane} allocation must bind its authenticated model decision before recovery`);
      if (!sameExecutionBinding(existing, binding)) throw new Error(`${lane} recovery decision differs from its active allocation`);
      dispatchBinding = validateDispatchAuthorization(manifest, lane, binding, dispatchAuthorization, existing.allocationId);
      if (binding.runtime === 'codex') validateDispatchAuthorizationUse(manifest, state, lane, existing, dispatchBinding, { operation: 'recovery' });
    } else {
      binding = validateExecutionBinding(executionBinding);
      requireControllerAllocation(manifest, state, lane, controllerToken, { bootstrap: true });
      dispatchBinding = validateDispatchAuthorization(manifest, lane, binding, dispatchAuthorization);
      if (binding.runtime === 'codex') validateDispatchAuthorizationUse(manifest, state, lane, existing, dispatchBinding, { operation: 'allocation' });
    }
    if (dispatchBinding && !recoveredFromCrash && existing?.status === 'released' && existing.allocationId === dispatchBinding.allocationId) {
      throw new Error(`${lane} replacement dispatch authorization reuses its released allocation identity`);
    }
    if (dispatchBinding && Object.values(state.allocations).some((candidate) =>
      candidate.lane !== lane && (candidate.allocationId === dispatchBinding.allocationId || candidate.dispatchAuthorizationNonce === dispatchBinding.dispatchAuthorizationNonce))) {
      throw new Error(`${lane} dispatch authorization identity is already bound to another allocation`);
    }
    // Recovery removes sensitive residue only after every token, decision, and
    // JIT authorization check has passed. A rejected recovery is non-mutating.
    if (recoveredFromCrash) recoverInterruptedAllocation(manifest, state, lane, existing);
    const token = randomBytes(32).toString('hex');
    const coordinates = allocationCoordinates(manifest, lane);
    const allocation = {
      lane,
      status: 'active',
      ...coordinates.public,
      leaseTokenSha256: sha256(token),
      allocationId: recoveredFromCrash ? existing.allocationId : (dispatchBinding?.allocationId ?? sha256(`${manifest.engagementId}:${lane}:${token}`).slice(0, 24)),
      ...binding,
      ...(dispatchBinding ? dispatchBindingWithHistory(existing, dispatchBinding) : {}),
      allocatedAt: recoveredFromCrash ? existing.allocatedAt : new Date().toISOString(),
      releasedAt: null,
      outcome: null,
      recoveredFromCrash,
    };
    for (const path of [allocation.browserProfile, allocation.authDirectory, allocation.temporaryDirectory, allocation.outputDirectory, allocation.browserArtifactsDirectory]) mkdirSync(path, { recursive: true });
    for (const name of ['downloads', 'traces', 'videos', 'screenshots']) mkdirSync(join(allocation.browserArtifactsDirectory, name), { recursive: true });
    createManagedFile(leasePath, `${leaseMarker(allocation)}\n`, `${lane} lease`);
    if (!recoveredFromCrash && existing?.status === 'released') delete state.checkpoints[lane];
    state.allocations[lane] = allocation;
    return { result: { ...publicAllocation(allocation), token, resumed: false }, changed: true };
  });
}

export function startWorkerAttempt(manifest, lane, { token, controllerToken, executionBinding, dispatchAuthorization } = {}) {
  requireSelected(manifest, lane);
  const binding = validateExecutionBinding(executionBinding);
  return mutateState(manifest, (state) => {
    requireDispatchableState(state, lane);
    const allocation = state.allocations[lane];
    // A worker retry may be started on controller authority alone; the controller then
    // receives the rotated lane token without ever holding the consumed one.
    const authority = requireLaneOrControllerAuthority(manifest, state, lane, { token, controllerToken });
    if (authority === 'lane') requireLiveLeaseFile(manifest, state, lane, token);
    requireControllerAllocation(manifest, state, lane, controllerToken ?? (lane === 'odysseus' ? token : null));
    if (!hasExecutionBinding(allocation)) throw new Error(`${lane} retry requires an authenticated active attempt`);
    if (binding.runtime !== allocation.runtime || binding.dispatchId !== allocation.dispatchId || binding.attempt !== allocation.attempt + 1) {
      throw new Error(`${lane} retry must advance exactly one attempt on the same runtime and dispatch`);
    }
    const decision = loadImmutableSelectedDecision(manifest, lane, binding);
    validateRetryLineage(manifest, state, allocation, decision);
    requireRetryBackoffElapsed(lane, decision);
    const dispatchBinding = validateDispatchAuthorization(manifest, lane, binding, dispatchAuthorization, allocation.allocationId);
    if (binding.runtime === 'codex') validateDispatchAuthorizationUse(manifest, state, lane, allocation, dispatchBinding, { operation: 'retry' });
    const nextToken = randomBytes(32).toString('hex');
    Object.assign(allocation, binding);
    if (dispatchBinding) Object.assign(allocation, dispatchBindingWithHistory(allocation, dispatchBinding));
    allocation.leaseTokenSha256 = sha256(nextToken);
    return {
      result: { ...publicAllocation(allocation), token: nextToken, attemptStarted: true, previousAttempt: binding.attempt - 1, authority },
      changed: true,
    };
  });
}

export function getEngagementStatus(manifest) {
  return withStateLock(manifest, () => readState(manifest, { persistMigration: true }));
}

export function claimExclusive(manifest, lane, token, resource) {
  const owner = manifest.resourcePolicy.exclusiveOperations[resource];
  if (!owner) throw new Error(`unknown exclusive resource: ${resource}`);
  if (owner !== lane) throw new Error(`${resource} is owned by ${owner}, not ${lane}`);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const held = state.exclusiveLocks[resource];
    if (held && held.lane !== lane) throw new Error(`${resource} is already held by ${held.lane}`);
    if (held) return { result: held, changed: false };
    const lock = { lane, acquiredAt: new Date().toISOString() };
    state.exclusiveLocks[resource] = lock;
    return { result: lock, changed: true };
  });
}

export function releaseExclusive(manifest, lane, token, resource) {
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const held = state.exclusiveLocks[resource];
    if (!held) return { result: { released: false }, changed: false };
    if (held.lane !== lane) throw new Error(`${resource} is held by ${held.lane}`);
    delete state.exclusiveLocks[resource];
    return { result: { released: true }, changed: true };
  });
}

export function writeFragment(manifest, lane, token, canonicalPath, fragmentId, content) {
  const canonical = requireCanonical(manifest, canonicalPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fragmentId)) throw new Error('fragment id must be a stable filename-safe identifier');
  const revised = canonical.merge === 'latest-revision';
  if (revised && lane !== canonical.owner) throw new Error(`${canonical.path} revisions are written only by ${canonical.owner}`);
  if (isSingleDocumentCanonical(canonical) && lane !== canonical.owner) {
    throw new Error(`${canonical.path} is a single-document contract; only ${canonical.owner} may submit fragments`);
  }
  let persistedContent = String(content);
  if (canonical.schema) {
    const { errors, document } = validateCanonicalFragment(canonical.schema, content);
    if (errors.length) throw new Error(`fragment does not satisfy a compatible ${canonical.schema} contract: ${errors.join('; ')}`);
    if (document.engagementId !== manifest.engagementId) throw new Error(`fragment engagementId does not match ${manifest.engagementId}`);
    if (canonical.schema === 'evidence-reference') {
      const registration = document.references.flatMap((ref) => binaryRegistrationErrors(ref, lane));
      if (registration.length) throw new Error(registration.join('; '));
    }
    // An owned collection record belongs to its lane, so the writer learns of a foreign record now.
    const ownership = collectionOwnershipErrors(canonical.schema, document, lane, canonical.owner);
    if (ownership.length) throw new Error(ownership.join('; '));
    const migrated = migrateCanonicalDocument(canonical.schema, document);
    if (migrated !== document) persistedContent = `${JSON.stringify(migrated, null, 2)}\n`;
  }
  let digest = sha256(persistedContent);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const key = sha256(canonical.path).slice(0, 16);
    const dir = engagementPath(manifest, join(manifest.writePolicy.fragmentRoot, key));
    const path = join(dir, `${fragmentId}--${lane}.${canonical.format.startsWith('json') ? 'json' : canonical.format === 'markdown' ? 'md' : 'txt'}`);
    mkdirSync(dir, { recursive: true });
    if (existsSync(path)) {
      const existing = readManagedFile(path, `${lane} immutable fragment`);
      const existingDigest = sha256(existing);
      if (existingDigest !== digest) {
        const { errors, document } = canonical.schema ? validateCanonicalFragment(canonical.schema, existing) : { errors: [], document: null };
        const migrated = canonical.schema && errors.length === 0 && document?.$schema !== schemaId(canonical.schema)
          ? `${JSON.stringify(migrateCanonicalDocument(canonical.schema, document), null, 2)}\n`
          : null;
        if (migrated !== persistedContent) throw new Error(`immutable fragment already exists with different content: ${fragmentId}`);
        digest = existingDigest;
      }
    } else {
      writeFileSync(path, persistedContent, { flag: 'wx', mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const list = state.fragments[canonical.path] ?? [];
    // An identical replay keeps the record, and with it the sequence, it was first given.
    const replay = list.find((item) => item.id === fragmentId && item.lane === lane);
    if (replay) return { result: replay, changed: false };
    const record = { id: fragmentId, lane, path: relative(manifest.artifactRoot, path).split(sep).join('/'), sha256: digest, sequence: nextFragmentSequence(state.fragments) };
    if (revised) record.revision = nextFragmentRevision(list);
    list.push(record);
    state.fragments[canonical.path] = list.sort(fragmentOrder);
    return { result: record, changed: true };
  });
}

export function mergeCanonical(manifest, owner, token, canonicalPath) {
  const canonical = requireCanonical(manifest, canonicalPath);
  if (canonical.owner !== owner) throw new Error(`${canonical.path} is owned by ${canonical.owner}, not ${owner}`);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, owner, token);
    const records = [...(state.fragments[canonical.path] ?? [])].sort(fragmentOrder);
    if (records.length === 0) throw new Error(`no fragments exist for ${canonical.path}`);
    const contents = records.map((record) => {
      const path = engagementPath(manifest, record.path);
      const content = readManagedFile(path, `canonical fragment ${record.path}`);
      if (sha256(content) !== record.sha256) throw new Error(`fragment digest drift: ${record.path}`);
      return content.toString('utf8').trimEnd();
    });
    // Every revision stays digest-checked above; only the highest one is published.
    const latest = canonical.merge === 'latest-revision' ? latestFragmentRevision(canonical, records) : null;
    let quarantined = [];
    let effective = null;
    let output;
    if (canonical.format === 'json-document') {
      let documents = contents.map((content) => JSON.parse(content));
      // A superseded single document stays digest-checked and valid; only the latest one is merged.
      if (isSingleDocumentCanonical(canonical) && records.length > 1) {
        effective = supersedingFragment(manifest, canonical, records, contents);
        documents = [documents[records.indexOf(effective)]];
      }
      // An owned collection record is superseded by its owner's later fragment of the same key.
      const writers = isCollectionContract(canonical.schema) ? records.map((record) => ({ lane: record.lane, sequence: fragmentSequence(canonical, record) })) : null;
      const document = mergeCanonicalDocuments(canonical.schema, documents, { writers, canonicalOwner: canonical.owner });
      if (canonical.schema === 'evidence-reference') verifyEvidenceRegistry(manifest, records, documents, document);
      if (canonical.schema === 'automation-review') assertCurrentReviewCorpus(manifest, document);
      if (canonical.schema === 'coverage-result') {
        const readDocument = (kind, path) => {
          const checked = validateCanonicalFragment(kind, readManagedFile(engagementPath(manifest, path), path));
          if (checked.errors.length || checked.document.engagementId !== manifest.engagementId) throw new Error(`invalid ${kind} reconciliation input`);
          return checked.document;
        };
        const inventory = readDocument('surface-inventory', 'solution/surface-inventory.json');
        const observations = readDocument('coverage-observations', 'solution/coverage-observations.json');
        const evidence = existsSync(engagementPath(manifest, 'solution/evidence-reference.json'))
          ? readDocument('evidence-reference', 'solution/evidence-reference.json') : null;
        // Defect outcomes follow the canonical ledger; only an engagement without Minos may omit it.
        let ledger = null;
        if (state.merges['solution/bug-ledger.json']) ledger = readDocument('bug-ledger', 'solution/bug-ledger.json');
        else if ((state.dispatchableAgents ?? manifest.selectedAgents).includes('minos')) throw new Error('coverage defect outcomes require the canonical bug ledger');
        // Once Atlas has merged the automation status, every credited runner case must map to its surface.
        const automationStatus = state.merges['solution/automation-status.json']
          ? readDocument('automation-status', 'solution/automation-status.json') : null;
        const readArtifact = source => readManagedFile(engagementPath(manifest, source), 'coverage evidence');
        if (evidence && coverageEvidenceReferences(inventory, observations).length) {
          const errors = reconcileCoverageEvidence(inventory, observations, evidence, readArtifact);
          if (errors.length) throw new Error(errors.join('; '));
        }
        const calculated = calculateCoverage(inventory, observations, { evidence, ledger, automationStatus, readArtifact });
        const canonicalJson = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
        if (canonicalJson({ ...document, generatedAt: null }) !== canonicalJson({ ...calculated, generatedAt: null })) throw new Error('coverage result does not match canonical inputs');
      }
      if (canonical.schema === 'final-summary') applyFinalSummaryFacts(manifest, state, document);
      if (canonical.schema === 'bug-ledger' && document.bugs.some(bug => ledgerEvidenceIds(bug).length > 0)) {
        const evidencePath = engagementPath(manifest, 'solution/evidence-reference.json');
        const evidenceRecords = state.fragments['solution/evidence-reference.json'] ?? [];
        // Minos runs before Kleio's reporting wave. Verify immutable contributions
        // directly; requiring the later canonical evidence merge would deadlock.
        const registrars = new Map();
        const content = evidenceRecords.length ? JSON.stringify(mergeCanonicalDocuments('evidence-reference', evidenceRecords.map(record => {
          const raw = readManagedFile(engagementPath(manifest, record.path), 'finding evidence fragment');
          if (sha256(raw) !== record.sha256) throw new Error('finding evidence fragment digest drift');
          const fragment = JSON.parse(raw);
          for (const ref of fragment.references ?? []) registrars.set(ref.id, record.lane);
          return fragment;
        }))) : readManagedFile(evidencePath, 'finding evidence registry');
        const checked = validateCanonicalFragment('evidence-reference', content);
        if (checked.errors.length) throw new Error(`invalid finding evidence registry: ${checked.errors.join('; ')}`);
        const binaryAudit = binaryAuditVerifier(manifest);
        const { errors, byBug } = reconcileFindings(document, checked.document,
          source => readManagedFile(engagementPath(manifest, source), 'finding evidence'),
          { verifyReference: ref => (registrars.has(ref.id) ? binaryRegistrationErrors(ref, registrars.get(ref.id)) : []).concat(binaryAudit(ref)) });
        if (errors.length) throw new Error(`finding reconciliation failed: ${errors.join('; ')}`);
        quarantined = quarantineLedgerFindings(document, byBug);
      }
      output = `${JSON.stringify(document, null, 2)}\n`;
    } else if (canonical.format === 'json') output = `${JSON.stringify(contents.map((content) => JSON.parse(content)), null, 2)}\n`;
    else if (latest) output = `${contents[records.indexOf(latest)]}\n`;
    else output = `${contents.join('\n\n')}\n`;
    const destination = engagementPath(manifest, canonical.path);
    atomicWrite(destination, output);
    if (canonical.schema === 'final-summary') {
      atomicWrite(engagementPath(manifest, 'solution/FINAL-SUMMARY.md'), renderFinalSummary(JSON.parse(output), { launchAssurance: manifest.launchAssurance }));
    }
    const result = { owner, fragments: records.length, sha256: sha256(output), mergedAt: new Date().toISOString() };
    if (latest) Object.assign(result, { revision: latest.revision, supersededFragments: records.length - 1 });
    if (effective) Object.assign(result, { effectiveFragment: effective.id, supersededFragments: records.length - 1 });
    if (canonical.schema === 'bug-ledger') result.quarantined = quarantined;
    state.merges[canonical.path] = result;
    if (canonical.schema === 'bug-ledger') {
      state.ledgerSnapshots[state.currentPhase] = ledgerSnapshot(manifest, state, JSON.parse(output), records, result.mergedAt);
    }
    return { result: { ...result, path: destination }, changed: true };
  });
}

// Aristarchus's review record binds each round to the test corpus it judged. The corpus is the
// selected template's test and harness roots (or, without a valid selection, the generated test
// directories) plus the runner entry point and scripts/, minus dependency, build, and report
// output and the packaged hunt driver. Each line is `<path>\0<sha256>\n`, and the digest covers
// the sorted lines, so it changes whenever a corpus file is added, removed, or edited.
const REVIEW_CORPUS_EXCLUDED_SEGMENTS = new Set([
  'node_modules', '.git', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'reports', 'test-results', 'playwright-report',
]);
const REVIEW_CORPUS_EXCLUDED_FILES = new Set([
  'scripts/hunt-driver.mjs', 'scripts/driver.config.json', 'scripts/driver.config.example.json', 'scripts/driver-config.schema.json',
]);
const REVIEW_CORPUS_FIXED_ROOTS = ['run-tests.sh', 'scripts'];
const TEMPLATE_SELECTION_RECORD = 'ai_agents_internal/template-selection.json';
const TEMPLATE_SELECTION_SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'template-selection.schema.json');
let templateSelectionValidator = null;

export function reviewCorpusDigest(manifest) {
  const root = resolvePhysical(manifest.artifactRoot, manifest.artifactRoot);
  const selection = reviewTemplateSelection(manifest);
  const candidates = selection
    ? [selection.testRoot, selection.harnessRoot]
    : manifest.writePolicy.generatedTestRoots.map((path) => path.replace(/\/+$/, ''))
      .filter((path) => canonicalCorpusRoot(path) && reviewCorpusEntry(root, path)?.isDirectory());
  const roots = [...new Set([...candidates, ...REVIEW_CORPUS_FIXED_ROOTS])].filter((path) => reviewCorpusEntry(root, path)).sort();
  const files = new Map();
  for (const path of roots) collectReviewCorpus(root, path, files);
  const lines = [...files].map(([path, digest]) => `${path}\0${digest}\n`).sort();
  return { sha256: sha256(lines.join('')), fileCount: files.size, roots };
}

// The canonical review record, verified against its merge record, or null before the first merge.
export function readAutomationReview(manifest, state) {
  const canonical = automationReviewCanonical(manifest);
  const merge = state.merges?.[canonical.path];
  if (!merge) return null;
  const content = readManagedFile(engagementPath(manifest, canonical.path), canonical.path);
  if (sha256(content) !== merge.sha256) throw new Error(`${canonical.path} does not match its merge record`);
  const { errors, document } = validateCanonicalFragment('automation-review', content);
  if (errors.length) throw new Error(`${canonical.path} is invalid: ${errors.join('; ')}`);
  if (document.engagementId !== manifest.engagementId) throw new Error(`${canonical.path} engagementId does not match ${manifest.engagementId}`);
  return { path: canonical.path, document, latest: document.reviews.at(-1) };
}

// approved: the latest round APPROVEs the current corpus. blocked: it BLOCKs. stale: it APPROVEd
// a corpus that has since changed. absent: Aristarchus is dispatchable and nothing is merged yet.
export function automationReviewStatus(manifest, state) {
  const review = readAutomationReview(manifest, state);
  if (!review) {
    const required = (state.dispatchableAgents ?? manifest.selectedAgents).includes('aristarchus');
    return { status: required ? 'absent' : 'not-applicable', reviewId: null, round: null, blockers: 0, warnings: 0 };
  }
  const { latest } = review;
  const status = latest.verdict === 'BLOCK' ? 'blocked'
    : latest.corpus.sha256 !== reviewCorpusDigest(manifest).sha256 ? 'stale' : 'approved';
  return { status, reviewId: latest.reviewId, round: latest.round, blockers: latest.blockers.length, warnings: latest.warnings.length };
}

function automationReviewCanonical(manifest) {
  const canonical = manifest.writePolicy.canonicalArtifacts.find((item) => item.schema === 'automation-review');
  if (!canonical) throw new Error('engagement manifest declares no automation-review canonical artifact');
  return canonical;
}

// A merge publishes only a latest round that judged the corpus as it is now.
function assertCurrentReviewCorpus(manifest, document) {
  const latest = document.reviews.at(-1);
  const current = reviewCorpusDigest(manifest);
  if (latest.corpus.sha256 !== current.sha256) {
    throw new Error(`automation review ${latest.reviewId} judged corpus ${latest.corpus.sha256}, but the current test corpus is ${current.sha256}; re-review required`);
  }
}

// A selection counts only when it is a schema-valid record whose roots are canonical relative
// paths; otherwise the digest falls back to the generated test roots.
function reviewTemplateSelection(manifest) {
  const path = engagementPath(manifest, TEMPLATE_SELECTION_RECORD);
  const entry = reviewCorpusEntry(resolvePhysical(manifest.artifactRoot, manifest.artifactRoot), TEMPLATE_SELECTION_RECORD);
  if (!entry) return null;
  let selection;
  try { selection = JSON.parse(readManagedFile(path, TEMPLATE_SELECTION_RECORD).toString('utf8')); }
  catch { return null; }
  templateSelectionValidator ??= compileJsonSchema(JSON.parse(readFileSync(TEMPLATE_SELECTION_SCHEMA, 'utf8')));
  if (templateSelectionValidator(selection).length || !canonicalCorpusRoot(selection.testRoot) || !canonicalCorpusRoot(selection.harnessRoot)) return null;
  return selection;
}

function canonicalCorpusRoot(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every((part) => part !== '.' && part !== '..');
}

// lstat of a corpus path below the physical artifact root, or null when it does not exist. A
// symbolic link anywhere on the path throws, so the corpus cannot alias files outside it.
function reviewCorpusEntry(root, path) {
  let cursor = root;
  let stats = null;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try { stats = lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`automation review corpus cannot contain a symbolic link: ${relative(root, cursor).split(sep).join('/')}`);
  }
  return stats;
}

function collectReviewCorpus(root, path, files) {
  if (path.split('/').some((part) => REVIEW_CORPUS_EXCLUDED_SEGMENTS.has(part)) || REVIEW_CORPUS_EXCLUDED_FILES.has(path)) return;
  const absolute = join(root, ...path.split('/'));
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) throw new Error(`automation review corpus cannot contain a symbolic link: ${path}`);
  if (stats.isDirectory()) {
    for (const name of readdirSync(absolute).sort()) collectReviewCorpus(root, `${path}/${name}`, files);
    return;
  }
  if (!stats.isFile()) throw new Error(`automation review corpus entry is not a regular file: ${path}`);
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { files.set(path, sha256(readFileSync(fd))); }
  finally { closeSync(fd); }
}

// Kleio writes the final summary's narrative, never its facts. Counts, likely-but-unproven
// findings, the review verdict, the runner outcome, coverage, and source schemas are derived
// from the merge-verified canonical inputs, and every status reason carries a ceiling the
// merged status can never be better than (completed < degraded < blocked).
const FINAL_SUMMARY_DERIVED_FIELDS = Object.freeze(['counts', 'unproven', 'held', 'automationReview', 'runner', 'coverage', 'sourceSchemas', 'statusReasons']);
const FINAL_SUMMARY_STATUS_ORDER = Object.freeze(['completed', 'degraded', 'blocked']);
const FINAL_SUMMARY_TESTED_STATUSES = new Set(['implemented', 'passed', 'failed']);
const FINAL_SUMMARY_DEGRADING_EXIT_CODES = new Set([11, 12, 13, 14, 15]);
const FINAL_SUMMARY_RUNNER_RESULT = 'reports/argus-runner-result.json';
const FINAL_SUMMARY_COVERAGE_RESULT = 'solution/coverage-result.json';

// Without a fragment (`engagement report-facts`) the runner outcome is read whenever the runner
// result exists. With a fragment, a non-null runner requires that file, and a null runner stays
// null so the merge can enforce the Mode B unfunded-automation rule against derived counts.
export function deriveFinalSummaryFacts(manifest, state, fragment = null) {
  const dispatchable = state.dispatchableAgents ?? manifest.selectedAgents;
  const ledger = readMergedCanonical(manifest, state, 'solution/bug-ledger.json', 'bug-ledger');
  if (!ledger && dispatchable.includes('minos')) throw new Error('final summary counts require the canonical bug ledger while minos is dispatchable');
  const evidence = readMergedCanonical(manifest, state, 'solution/evidence-reference.json', 'evidence-reference');
  const automationStatus = readMergedCanonical(manifest, state, 'solution/automation-status.json', 'automation-status');
  const coverageResult = readMergedCanonical(manifest, state, FINAL_SUMMARY_COVERAGE_RESULT, 'coverage-result');
  if (!coverageResult) throw new Error(`final summary coverage requires the merged canonical ${FINAL_SUMMARY_COVERAGE_RESULT}`);
  const review = readAutomationReview(manifest, state);
  const automationReview = automationReviewStatus(manifest, state);

  const bugs = ledger?.bugs ?? [];
  const idsWith = (status) => bugs.filter((bug) => bug.status === status).map((bug) => bug.id).sort();
  const confirmed = idsWith('confirmed');
  const suspected = idsWith('suspected').length;
  const tested = (automationStatus?.tests ?? []).filter((test) => FINAL_SUMMARY_TESTED_STATUSES.has(test.status));
  const regressed = new Set(tested.flatMap((test) => test.coversBugIds));
  const counts = {
    bugs: {
      confirmed: confirmed.length,
      suspected,
      needsOracle: idsWith('needs-oracle').length,
      bounced: idsWith('bounced').length,
      quarantined: idsWith('quarantined').length,
      duplicate: idsWith('duplicate').length,
      rejected: idsWith('rejected').length,
      headline: confirmed.length + suspected,
    },
    regression: {
      wired: confirmed.filter((id) => regressed.has(id)).length,
      uncovered: confirmed.filter((id) => !regressed.has(id)),
    },
    automated: tested.length,
    evidence: evidence?.references.length ?? 0,
  };
  const unproven = bugs.filter((bug) => bug.status === 'suspected' || bug.status === 'needs-oracle')
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((bug) => {
      if (!bug.missingProof) throw new Error(`${bug.id} is ${bug.status} without missingProof`);
      return { id: bug.id, title: bug.title, severity: bug.severity, status: bug.status, missing: [...bug.missingProof.elements], detail: bug.missingProof.detail };
    });
  // A bounced filing still awaits its proof repair and a quarantined one failed evidence
  // reconciliation; neither counts in the headline, but the report names each with its reasons.
  const held = bugs.filter((bug) => bug.status === 'bounced' || bug.status === 'quarantined')
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((bug) => ({
      id: bug.id, title: bug.title, severity: bug.severity, status: bug.status,
      reasons: [...new Set(bug.status === 'bounced' ? bug.repair.missing : bug.quarantine.reasons)],
    }));

  const runnerResult = (fragment ? fragment.runner !== null : Boolean(lstatEntry(engagementPath(manifest, FINAL_SUMMARY_RUNNER_RESULT))))
    ? readRunnerResult(manifest) : null;
  const runner = runnerResult && {
    mode: runnerResult.mode,
    status: runnerResult.status,
    exitCode: runnerResult.exitCode,
    resultPath: FINAL_SUMMARY_RUNNER_RESULT,
    categories: Object.fromEntries(['product', 'automation', 'infrastructure', 'skip', 'policy'].map((category) => [category, runnerResult.categories[category]])),
    deliveryGate: runnerResult.deliveryGate,
  };

  const overall = coverageResult.overall;
  const coverage = {
    resultPath: FINAL_SUMMARY_COVERAGE_RESULT,
    discoveryCompleteness: coverageResult.discovery.completeness,
    executionCoverage: overall.executionCoverage,
    assertionQuality: overall.assertionQuality,
    evidenceQuality: overall.evidenceQuality,
    automatedExecution: overall.automatedExecution,
    scopedOutcomes: coverageResult.scopedOutcomes.length,
    criticalUnexecuted: [...coverageResult.criticalUnexecuted],
    ...(overall.caseDepth ? { caseDepth: structuredClone(overall.caseDepth) } : {}),
  };
  const sourceSchemas = [ledger, evidence, automationStatus, runnerResult, coverageResult, review?.document]
    .filter(Boolean).map((document) => document.$schema);

  const ceilings = new Map();
  if (['blocked', 'stale', 'absent'].includes(automationReview.status)) ceilings.set(`automation-review-${automationReview.status}`, 'blocked');
  if (runner && counts.regression.uncovered.length > 0) ceilings.set('confirmed-bug-without-regression', 'blocked');
  if (counts.bugs.bounced > 0) ceilings.set('bounced-findings', 'degraded');
  if (counts.bugs.quarantined > 0) ceilings.set('quarantined-findings', 'degraded');
  if (coverage.criticalUnexecuted.length > 0) ceilings.set('critical-surface-unexecuted', 'degraded');
  // Required-case depth is unproven unless the coverage result records it complete: a missing
  // depth, an unplanned surface, or any gap counts, so a summary cannot overstate coverage.
  const depth = coverage.caseDepth;
  if (!depth || depth.coverage === null || depth.gaps.length > 0 || depth.unplannedSurfaces.length > 0) ceilings.set('case-depth-gaps', 'degraded');
  if (runner && runner.deliveryGate !== true) ceilings.set('runner-not-delivery-gate', 'degraded');
  if (runner && FINAL_SUMMARY_DEGRADING_EXIT_CODES.has(runner.exitCode)) ceilings.set(`runner-exit-${runner.exitCode}`, 'degraded');
  for (const reason of skippedPhaseStatusReasons(state)) ceilings.set(reason, 'degraded');
  const statusReasons = [...ceilings.keys()].sort();
  const statusCeiling = [...ceilings.values()].reduce(worseFinalSummaryStatus, 'completed');
  return { counts, unproven, held, automationReview, runner, coverage, sourceSchemas, statusCeiling, statusReasons };
}

// The merge overwrites every derived field of Kleio's fragment and never raises its status.
function applyFinalSummaryFacts(manifest, state, document) {
  const facts = deriveFinalSummaryFacts(manifest, state, document);
  if (document.runner === null && (manifest.mode !== 'B' || facts.counts.automated !== 0)) throw new Error('runner=null is only valid for Mode B without automation');
  for (const field of FINAL_SUMMARY_DERIVED_FIELDS) document[field] = facts[field];
  document.status = worseFinalSummaryStatus(document.status, facts.statusCeiling);
  const errors = validateCanonicalDocument('final-summary', document);
  if (errors.length) throw new Error(`derived final summary is invalid: ${errors.join('; ')}`);
}

function worseFinalSummaryStatus(left, right) {
  return FINAL_SUMMARY_STATUS_ORDER.indexOf(left) >= FINAL_SUMMARY_STATUS_ORDER.indexOf(right) ? left : right;
}

// A canonical input counts only once merged, and only while its file still matches the digest
// its merge record published.
function readMergedCanonical(manifest, state, path, schema) {
  const canonical = requireCanonical(manifest, path);
  if (canonical.schema !== schema) throw new Error(`${path} is not declared as the ${schema} canonical`);
  const merge = state.merges?.[canonical.path];
  if (!merge) return null;
  const content = readManagedFile(engagementPath(manifest, canonical.path), canonical.path);
  if (sha256(content) !== merge.sha256) throw new Error(`${canonical.path} does not match its merge record`);
  const { errors, document } = validateCanonicalFragment(schema, content);
  if (errors.length) throw new Error(`${canonical.path} is invalid: ${errors.join('; ')}`);
  if (document.engagementId !== manifest.engagementId) throw new Error(`${canonical.path} engagementId does not match ${manifest.engagementId}`);
  return document;
}

function readRunnerResult(manifest) {
  const path = engagementPath(manifest, FINAL_SUMMARY_RUNNER_RESULT);
  if (!lstatEntry(path)) throw new Error(`final summary runner outcome requires ${FINAL_SUMMARY_RUNNER_RESULT}`);
  const { errors, document } = validateCanonicalFragment('runner-result', readManagedFile(path, FINAL_SUMMARY_RUNNER_RESULT));
  if (errors.length) throw new Error(`${FINAL_SUMMARY_RUNNER_RESULT} is invalid: ${errors.join('; ')}`);
  return document;
}

const LANE_OUTCOMES_SCHEMA_ID = 'argus/lane-outcomes@1';
const LANE_OUTCOMES_SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const LANE_OUTCOMES_DECISION_FILE = /^MDR-[a-f0-9]{24}\.json$/;
const LANE_OUTCOMES_LEDGER = 'solution/bug-ledger.json';
const LANE_OUTCOMES_AUTOMATION = 'solution/automation-status.json';
const LANE_OUTCOMES_LEDGER_STATUSES = Object.freeze({
  confirmed: 'confirmed',
  suspected: 'suspected',
  'needs-oracle': 'needsOracle',
  bounced: 'bounced',
  quarantined: 'quarantined',
  duplicate: 'duplicate',
  rejected: 'rejected',
});
const LANE_OUTCOMES_HEADLINE_STATUSES = new Set(['confirmed', 'suspected']);
const LANE_OUTCOMES_SEVERE = new Set(['Blocker', 'Critical']);
let laneOutcomeValidators = null;

// The count-only per-lane outcome report (argus/lane-outcomes@1) the controller cites at
// closeout. It never writes: it reads the immutable model decisions, the telemetry log, and the
// merged, digest-checked bug ledger and automation status. Only the active Odysseus controller
// token, re-checked against the live lease under the state lock, may compute it. Every decision
// and telemetry event must be schema-valid, bound to this engagement, and name a selected lane,
// so one inconsistent record fails the report instead of undercounting it. A ledger row or test
// attributed to an unselected lane is counted under sources, never dropped.
export function computeLaneOutcomes(manifest, policy, { controllerToken, generatedAt = new Date().toISOString() } = {}) {
  const decisionDirectory = policy?.routing?.decisionDirectory;
  const telemetryPath = policy?.telemetry?.defaultPath;
  if (!safeRelative(decisionDirectory) || !String(decisionDirectory).startsWith('ai_agents_internal/')) {
    throw new Error('lane outcomes require a model policy decision directory under ai_agents_internal/');
  }
  if (!safeRelative(telemetryPath) || !String(telemetryPath).startsWith('ai_agents_internal/')) {
    throw new Error('lane outcomes require a model policy telemetry path under ai_agents_internal/');
  }
  laneOutcomeValidators ??= {
    decision: compileJsonSchema(JSON.parse(readFileSync(join(LANE_OUTCOMES_SCHEMA_DIR, 'model-decision.schema.json'), 'utf8'))),
    telemetry: compileJsonSchema(JSON.parse(readFileSync(join(LANE_OUTCOMES_SCHEMA_DIR, 'model-telemetry-event.schema.json'), 'utf8'))),
  };
  return withStateLock(manifest, () => {
    const state = readState(manifest);
    requireControllerAllocation(manifest, state, 'odysseus', controllerToken);
    const lanes = new Map(manifest.selectedAgents.map((agent) => [agent, emptyLaneOutcome(agent)]));
    const selectedLane = (agent, label) => {
      if (!lanes.has(agent)) throw new Error(`${label} names ${agent}, which is not selected for engagement ${manifest.engagementId}`);
      return lanes.get(agent);
    };

    const decisions = readLaneOutcomeDecisions(manifest, decisionDirectory, laneOutcomeValidators.decision);
    for (const decision of decisions.values()) {
      const counts = selectedLane(decision.agent, `model decision ${decision.decisionId}`).decisions;
      counts.total += 1;
      if (decision.signal === 'normal') counts.normal += 1;
      else counts.escalations += 1;
      if (decision.signal === 'turn-limit') counts.turnLimit += 1;
      if (decision.signal === 'no-artifact') counts.noArtifact += 1;
      if (decision.signal === 'zero-candidates') counts.zeroCandidates += 1;
      if (decision.reasonCode === 'AUTO_CONTINUE_SELECTED') counts.autoContinued += 1;
      if (decision.reasonCode === 'BACKOFF_RETRY_SELECTED') counts.backoffRetries += 1;
      if (decision.status === 'blocked') counts.blocked += 1;
    }

    const events = readLaneOutcomeTelemetry(manifest, telemetryPath, laneOutcomeValidators.telemetry, decisions);
    for (const event of events) {
      const telemetry = selectedLane(event.agent, `model telemetry event ${event.eventId}`).telemetry;
      telemetry.events += 1;
      if (event.success) telemetry.successes += 1;
      else telemetry.failures += 1;
      telemetry.totalTokens += event.totalTokens;
      if (typeof event.reportedCostUsd === 'number') telemetry.reportedCostUsd = (telemetry.reportedCostUsd ?? 0) + event.reportedCostUsd;
    }

    let unattributedLedgerRows = 0;
    const ledger = readMergedCanonical(manifest, state, LANE_OUTCOMES_LEDGER, 'bug-ledger');
    for (const bug of ledger?.bugs ?? []) {
      const counts = lanes.get(bug.lane)?.ledger;
      if (!counts) {
        unattributedLedgerRows += 1;
        continue;
      }
      if (!Object.hasOwn(LANE_OUTCOMES_LEDGER_STATUSES, bug.status)) throw new Error(`${LANE_OUTCOMES_LEDGER} ${bug.id} has unknown status ${bug.status}`);
      counts.reported += 1;
      counts[LANE_OUTCOMES_LEDGER_STATUSES[bug.status]] += 1;
      if (bug.wired === true) counts.wired += 1;
      if (LANE_OUTCOMES_HEADLINE_STATUSES.has(bug.status) && LANE_OUTCOMES_SEVERE.has(bug.severity)) counts.severe += 1;
    }

    let unattributedTests = 0;
    const automationStatus = readMergedCanonical(manifest, state, LANE_OUTCOMES_AUTOMATION, 'automation-status');
    for (const test of automationStatus?.tests ?? []) {
      const counts = lanes.get(test.owner)?.automation;
      if (!counts) {
        unattributedTests += 1;
        continue;
      }
      counts.tests += 1;
      if (test.coversBugIds.length > 0) counts.coveringBugs += 1;
      if (test.status === 'failed') counts.failed += 1;
    }

    const mergedDigest = (path, document) => (document ? state.merges[requireCanonical(manifest, path).path].sha256 : null);
    return {
      schema: LANE_OUTCOMES_SCHEMA_ID,
      schemaVersion: 1,
      engagementId: manifest.engagementId,
      generatedAt,
      sources: {
        bugLedgerSha256: mergedDigest(LANE_OUTCOMES_LEDGER, ledger),
        automationStatusSha256: mergedDigest(LANE_OUTCOMES_AUTOMATION, automationStatus),
        decisions: decisions.size,
        telemetryEvents: events.length,
        unattributedLedgerRows,
        unattributedTests,
      },
      // Costs are summed in micro-dollars so repeated recomputation never drifts in the last digit.
      lanes: [...lanes.values()].map((lane) => ({
        ...lane,
        telemetry: {
          ...lane.telemetry,
          reportedCostUsd: lane.telemetry.reportedCostUsd === null ? null : Math.round(lane.telemetry.reportedCostUsd * 1e6) / 1e6,
        },
      })),
    };
  });
}

function emptyLaneOutcome(agent) {
  return {
    agent,
    decisions: { total: 0, normal: 0, turnLimit: 0, escalations: 0, noArtifact: 0, zeroCandidates: 0, autoContinued: 0, backoffRetries: 0, blocked: 0 },
    telemetry: { events: 0, successes: 0, failures: 0, totalTokens: 0, reportedCostUsd: null },
    ledger: { reported: 0, confirmed: 0, suspected: 0, needsOracle: 0, bounced: 0, quarantined: 0, duplicate: 0, rejected: 0, wired: 0, severe: 0 },
    automation: { tests: 0, coveringBugs: 0, failed: 0 },
  };
}

// Every MDR file directly under the decision directory, keyed by decision ID. Operator records
// and selection locks share the directory and are skipped by name; a decision must be a
// single-link regular file whose identity, path, engagement, and integrity digest all agree.
function readLaneOutcomeDecisions(manifest, decisionDirectory, validate) {
  const directory = engagementPath(manifest, decisionDirectory);
  const entry = lstatEntry(directory);
  const decisions = new Map();
  if (!entry) return decisions;
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${decisionDirectory} must be a real directory`);
  for (const name of readdirSync(directory).filter((item) => LANE_OUTCOMES_DECISION_FILE.test(item)).sort()) {
    const relativePath = `${decisionDirectory}/${name}`;
    let decision;
    try { decision = JSON.parse(readManagedFile(join(directory, name), `model decision ${relativePath}`).toString('utf8')); }
    catch (error) { throw new Error(`model decision ${relativePath} is unreadable: ${error.message}`); }
    const errors = validate(decision);
    if (errors.length) throw new Error(`model decision ${relativePath} is invalid: ${errors.map((item) => `${item.instancePath || '/'} ${item.message}`).join('; ')}`);
    if (`${decision.decisionId}.json` !== name || decision.relativePath !== relativePath) throw new Error(`model decision ${relativePath} does not match its file name`);
    if (decision.engagementId !== manifest.engagementId) throw new Error(`model decision ${relativePath} belongs to another engagement`);
    if (modelDecisionIntegritySha256(decision) !== decision.integritySha256) throw new Error(`model decision ${relativePath} failed its integrity digest`);
    decisions.set(decision.decisionId, decision);
  }
  return decisions;
}

// The append-only telemetry log: one schema-valid event per immutable decision, each bound to
// that decision's integrity digest, lane, dispatch, and attempt.
function readLaneOutcomeTelemetry(manifest, telemetryPath, validate, decisions) {
  const path = engagementPath(manifest, telemetryPath);
  if (!lstatEntry(path)) return [];
  const lines = readManagedFile(path, `model telemetry ${telemetryPath}`).toString('utf8').split('\n').filter((line) => line.trim() !== '');
  const seen = new Set();
  return lines.map((line, index) => {
    const label = `${telemetryPath} line ${index + 1}`;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`${label} is not valid JSON`); }
    const errors = validate(event);
    if (errors.length) throw new Error(`${label} is invalid: ${errors.map((item) => `${item.instancePath || '/'} ${item.message}`).join('; ')}`);
    if (event.engagementId !== manifest.engagementId) throw new Error(`${label} belongs to another engagement`);
    const decision = decisions.get(event.decisionId);
    if (!decision || decision.integritySha256 !== event.decisionIntegritySha256 || decision.agent !== event.agent ||
        decision.dispatchId !== event.dispatchId || decision.attempt !== event.attempt || decision.runtime !== event.runtime) {
      throw new Error(`${label} is not bound to an immutable decision of this engagement`);
    }
    if (seen.has(event.decisionId)) throw new Error(`${label} repeats telemetry for ${event.decisionId}`);
    seen.add(event.decisionId);
    return event;
  });
}

export function allocateId(manifest, lane, token, kind, identity) {
  const allocator = manifest.idAllocators[kind];
  if (!allocator) throw new Error(`unknown ID allocator: ${kind}`);
  if (allocator.owner !== lane) throw new Error(`${kind} IDs are owned by ${allocator.owner}, not ${lane}`);
  const identityHash = stableIdentity(identity);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    state.idKeys ??= {};
    state.idKeys[kind] ??= {};
    const existing = state.idKeys[kind][identityHash];
    if (existing) return { result: existing, changed: false };
    const value = state.nextIds[kind] ?? 1;
    state.nextIds[kind] = value + 1;
    const allocated = `${allocator.prefix}-${String(value).padStart(allocator.width, '0')}`;
    state.idKeys[kind][identityHash] = allocated;
    return { result: allocated, changed: true };
  });
}

export function writeCheckpoint(manifest, lane, token, phase, sequence, dispatchId, attempt, payload) {
  if (!phaseIds(manifest).includes(phase)) throw new Error(`unknown phase: ${phase}`);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error('checkpoint sequence must be a non-negative integer');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dispatchId ?? '')) throw new Error('checkpoint dispatchId is invalid');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('checkpoint attempt must be a positive integer');
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const digest = sha256(serialized);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const allocation = state.allocations[lane];
    if (!hasExecutionBinding(allocation) || allocation.dispatchId !== dispatchId || allocation.attempt !== attempt) {
      throw new Error('checkpoint execution binding must match the active allocation attempt');
    }
    const current = state.checkpoints[lane];
    if (current && sequence < current.sequence) throw new Error(`checkpoint sequence regressed from ${current.sequence} to ${sequence}`);
    if (current && sequence === current.sequence) {
      if (current.sha256 !== digest || current.dispatchId !== dispatchId || current.attempt !== attempt || current.allocationId !== state.allocations[lane].allocationId) {
        throw new Error('checkpoint sequence already exists with different content or execution binding');
      }
      return { result: current, changed: false };
    }
    const path = engagementPath(manifest, join(manifest.writePolicy.checkpointRoot, lane, `${String(sequence).padStart(8, '0')}.json`));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized, { flag: 'wx', mode: 0o600 });
    const record = { phase, sequence, dispatchId, attempt, allocationId: state.allocations[lane].allocationId, bindingOrigin: 'runtime', path: relative(manifest.artifactRoot, path).split(sep).join('/'), sha256: digest, recordedAt: new Date().toISOString() };
    state.checkpoints[lane] = record;
    return { result: record, changed: true };
  });
}

export function appendHeartbeat(manifest, lane, token, phase, completed, total, status, timestamp = new Date().toISOString()) {
  return withStateLock(manifest, () => {
    const state = readState(manifest, { persistMigration: true });
    requireLeaseState(manifest, state, lane, token);
    requireLiveLeaseFile(manifest, state, lane, token, { upgradeMigratedToken: true });
    const allocation = state.allocations[lane];
    if (!hasExecutionBinding(allocation)) throw new Error(`${lane} heartbeat requires an authenticated execution binding`);
    return appendHeartbeatRecord(manifest, lane, phase, completed, total, status, timestamp, {
      executionBinding: {
        allocationId: allocation.allocationId,
        dispatchId: allocation.dispatchId,
        attempt: allocation.attempt,
      },
    });
  });
}

// Preflight runs before Odysseus receives a worker lease. Keep this capability
// separate from the public heartbeat path so it cannot impersonate another lane.
// Re-entry validates the original record without appending.
export function ensurePreflightHeartbeat(manifest, timestamp = new Date().toISOString()) {
  return withStateLock(manifest, () => {
    const state = readState(manifest, { persistMigration: true });
    requireSelected(manifest, 'odysseus');
    if (!validDate(timestamp)) throw new Error('preflight heartbeat timestamp must be an ISO date-time');
    const path = heartbeatPath(manifest, 'odysseus');
    const relativePath = relative(manifest.artifactRoot, path).split(sep).join('/');
    const allocation = state.allocations.odysseus;
    if (existsSync(path)) {
      const records = parseHeartbeatLog(readManagedFile(path, 'Odysseus heartbeat').toString('utf8'), 'odysseus', phaseIds(manifest));
      const initial = records[0];
      if (initial?.phase === 'preflight' && initial.completed === 0 && initial.total === 1 && initial.status === 'running') {
        return { disposition: 'existing', wrote: false, lane: 'odysseus', path: relativePath, record: initial };
      }
      throw new Error('existing Odysseus heartbeat log has no valid initial preflight record');
    }
    if (allocation) {
      throw new Error('Odysseus was allocated before the initial preflight heartbeat record');
    }
    const record = appendHeartbeatRecord(manifest, 'odysseus', 'preflight', 0, 1, 'running', timestamp, { initialOnly: true });
    return { disposition: 'created', wrote: true, lane: 'odysseus', path: record.path, record };
  });
}

function appendHeartbeatRecord(manifest, lane, phase, completed, total, status, timestamp, { initialOnly = false, executionBinding = null } = {}) {
  if (!manifest.selectedAgents.includes(lane)) throw new Error(`heartbeat lane is not selected: ${lane}`);
  const phases = phaseIds(manifest);
  if (!phases.includes(phase)) throw new Error(`heartbeat phase is invalid: ${phase}`);
  if (!Number.isInteger(completed) || completed < 0 || !Number.isInteger(total) || total < 1 || completed > total) {
    throw new Error('heartbeat progress must satisfy 0 <= completed <= total');
  }
  if (!HEARTBEAT_STATUSES.includes(status)) throw new Error(`heartbeat status is invalid: ${status}`);
  if (!validDate(timestamp)) throw new Error('heartbeat timestamp must be an ISO date-time');
  const path = heartbeatPath(manifest, lane, { createRoot: true });
  if (initialOnly && existsSync(path)) throw new Error('initial preflight heartbeat already exists');
  const fd = openManagedAppendFile(path, `${lane} heartbeat`);
  try {
    const existing = readFileSync(fd, 'utf8');
    const records = parseHeartbeatLog(existing, lane, phases);
    const candidate = { lane, phase, completed, total, status, recordedAt: timestamp, ...(executionBinding ?? {}) };
    if (records.length > 0) validateHeartbeatTransition(records.at(-1), candidate, phases);
    const generation = executionBinding ? `\t${executionBinding.allocationId}\t${executionBinding.dispatchId}\t${executionBinding.attempt}` : '';
    writeFileSync(fd, `${timestamp}\t${lane}\t${phase}\t${completed}/${total}\t${status}${generation}\n`);
    fsyncSync(fd);
    assertManagedDescriptorPath(fd, path, `${lane} heartbeat`);
  } finally {
    closeSync(fd);
  }
  return { lane, phase, completed, total, status, ...(executionBinding ?? {}), path: relative(manifest.artifactRoot, path).split(sep).join('/'), recordedAt: timestamp };
}

function heartbeatPath(manifest, lane, { createRoot = false } = {}) {
  const heartbeatRoot = resolve(manifest.artifactRoot, 'ai_agents_internal', 'heartbeat');
  if (createRoot) mkdirSync(heartbeatRoot, { recursive: true });
  const expectedPhysicalRoot = resolve(resolvePhysical(manifest.artifactRoot, manifest.artifactRoot), 'ai_agents_internal', 'heartbeat');
  if (resolvePhysical(heartbeatRoot, manifest.artifactRoot) !== expectedPhysicalRoot) throw new Error('heartbeat root crosses a symbolic link');
  return join(heartbeatRoot, `${lane}.log`);
}

function parseHeartbeatLog(content, expectedLane, phases) {
  if (content === '') return [];
  if (!content.endsWith('\n')) throw new Error(`heartbeat log for ${expectedLane} has an incomplete record`);
  const records = content.trimEnd().split('\n').map((line, index) => {
    const match = line.match(/^([^\t]+)\t([a-z][a-z0-9-]*)\t([a-z][a-z0-9-]*)\t(\d+)\/(\d+)\t(started|running|blocked|degraded|complete|failed)(?:\t([a-f0-9]{24})\t([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\t([1-9][0-9]*))?$/);
    if (!match || match[2] !== expectedLane || !phases.includes(match[3]) || !validDate(match[1])) throw new Error(`heartbeat log for ${expectedLane} has an invalid record at line ${index + 1}`);
    const completed = Number(match[4]);
    const total = Number(match[5]);
    if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1 || completed < 0 || completed > total) {
      throw new Error(`heartbeat log for ${expectedLane} has invalid progress at line ${index + 1}`);
    }
    return {
      recordedAt: match[1], lane: match[2], phase: match[3], completed, total, status: match[6],
      ...(match[7] ? { allocationId: match[7], dispatchId: match[8], attempt: Number(match[9]) } : {}),
    };
  });
  for (let index = 1; index < records.length; index += 1) validateHeartbeatTransition(records[index - 1], records[index], phases);
  return records;
}

function validateHeartbeatTransition(previous, candidate, phases) {
  if (Date.parse(candidate.recordedAt) < Date.parse(previous.recordedAt)) throw new Error('heartbeat timestamp regressed');
  const previousPhase = phases.indexOf(previous.phase);
  const candidatePhase = phases.indexOf(candidate.phase);
  if (candidatePhase < previousPhase) throw new Error(`heartbeat phase regressed from ${previous.phase} to ${candidate.phase}`);
  const previousGeneration = previous.allocationId !== undefined;
  const candidateGeneration = candidate.allocationId !== undefined;
  if (previousGeneration !== candidateGeneration || (previousGeneration &&
      (previous.allocationId !== candidate.allocationId || previous.dispatchId !== candidate.dispatchId || previous.attempt !== candidate.attempt))) {
    if (!candidateGeneration) throw new Error('heartbeat execution generation disappeared');
    if (previousGeneration && previous.allocationId === candidate.allocationId &&
        (previous.dispatchId !== candidate.dispatchId || candidate.attempt !== previous.attempt + 1)) {
      throw new Error('heartbeat retry generation does not advance the same dispatch by one attempt');
    }
    return;
  }
  if (candidatePhase > previousPhase) return;
  if (candidate.total !== previous.total) throw new Error(`heartbeat total changed within ${candidate.phase}`);
  if (candidate.completed < previous.completed) throw new Error(`heartbeat progress regressed from ${previous.completed} to ${candidate.completed}`);
  const allowed = {
    started: ['started', 'running', 'blocked', 'degraded', 'complete', 'failed'],
    running: ['running', 'blocked', 'degraded', 'complete', 'failed'],
    degraded: ['running', 'blocked', 'degraded', 'complete', 'failed'],
    blocked: ['running', 'blocked', 'degraded', 'complete', 'failed'],
    complete: ['complete'],
    failed: ['failed'],
  };
  if (!allowed[previous.status].includes(candidate.status)) throw new Error(`heartbeat status regressed from ${previous.status} to ${candidate.status}`);
}

export function arriveBarrier(manifest, lane, token, phase, { controllerToken } = {}) {
  return mutateState(manifest, (state) => {
    const authority = requireLaneOrControllerAuthority(manifest, state, lane, { token, controllerToken });
    if (Object.hasOwn(state.skippedPhases, phase)) throw new Error(`phase ${phase} was skipped (${state.skippedPhases[phase].reason})`);
    if (state.currentPhase !== phase) throw new Error(`current phase is ${state.currentPhase}, not ${phase}`);
    const participants = barrierParticipants(manifest, state, phase);
    if (!participants.includes(lane)) throw new Error(`${lane} is not a participant in ${phase}`);
    const arrivals = new Set(state.barriers[phase] ?? []);
    arrivals.add(lane);
    state.barriers[phase] = [...arrivals].sort();
    return { result: { ...barrierStatus(manifest, state, phase), authority }, changed: true };
  });
}

export function advanceBarrier(manifest, lane, token) {
  if (lane !== 'odysseus') throw new Error('only odysseus may advance phase barriers');
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const phase = state.currentPhase;
    const status = barrierStatus(manifest, state, phase);
    if (!status.complete) throw new Error(`phase ${phase} is waiting for: ${status.missing.join(', ')}`);
    // Conditional lanes are verdict-bound in discovery: leaving it unresolved would strand
    // them, because gate resolution runs only while discovery is the current phase.
    if (phase === GATE_RESOLUTION_PHASE && hasConditionalLanes(state) && state.gateResolution === null) {
      throw new Error('discovery cannot advance before engagement resolve-gates records the conditional lane verdicts');
    }
    // A proof phase ends with the validator's ledger merge: its snapshot is the convergence
    // evidence a later deep-hunt skip is checked against.
    if (phaseDefinition(manifest, phase).kind === 'proof' && status.participants.includes(PROOF_VALIDATOR) &&
        !Object.hasOwn(state.ledgerSnapshots, phase)) {
      throw new Error(`proof phase ${phase} requires a Minos bug-ledger merge before it can advance`);
    }
    const phases = phaseIds(manifest);
    const index = phases.indexOf(phase);
    const next = index < 0 ? undefined : nextUnskippedPhase(phases, state, index);
    if (!next) throw new Error(`phase ${phase} cannot advance`);
    if (!state.completedPhases.includes(phase)) state.completedPhases.push(phase);
    state.currentPhase = next;
    return { result: { completed: phase, currentPhase: state.currentPhase }, changed: true };
  });
}

// Skips the remaining deep-hunt passes. Only Odysseus may skip, only from the untouched
// start of a skippable deep-hunt pass, and a converged skip must be backed by the previous
// proof phase's ledger snapshot recording zero new confirmed defects. Every skip is recorded
// with its reason; a controller-budget skip later degrades a completed final summary.
export function skipPhases(manifest, lane, token, reason) {
  if (lane !== 'odysseus') throw new Error('only odysseus may skip phases');
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const current = state.currentPhase;
    const definition = phaseDefinition(manifest, current);
    if (definition.skippable !== true) throw new Error(`phase ${current} is not skippable`);
    if (definition.kind !== 'deep-hunt') throw new Error('only a deep-hunt pass can start a skip');
    if ((state.barriers[current] ?? []).length > 0) throw new Error(`phase ${current} already has arrivals`);
    if (!SKIP_REASONS.includes(reason)) throw new Error('skip reason must be converged or controller-budget');
    let basis = null;
    if (reason === 'converged') {
      const previous = manifest.phasePlan.find((phase) => phase.kind === 'proof' && phase.pass === definition.pass - 1);
      const snapshot = previous ? state.ledgerSnapshots[previous.id] : undefined;
      if (!snapshot || snapshot.newConfirmed.length > 0) {
        throw new Error(`converged skip requires ${previous?.id ?? `the pass ${definition.pass - 1} proof phase`} to record zero new confirmed defects`);
      }
      basis = previous.id;
    }
    const phases = phaseIds(manifest);
    const start = phases.indexOf(current);
    const skippedAt = new Date().toISOString();
    const skipped = [];
    for (const phase of manifest.phasePlan.slice(start)) {
      if (!PASS_PHASE_KINDS.includes(phase.kind) || phase.pass < definition.pass) break;
      state.skippedPhases[phase.id] = { reason, skippedAt, basis };
      skipped.push(phase.id);
    }
    const next = nextUnskippedPhase(phases, state, start);
    if (!next) throw new Error(`phase ${current} has no later phase to continue with`);
    state.currentPhase = next;
    return { result: { skipped, currentPhase: state.currentPhase, reason }, changed: true };
  });
}

// Read-only precondition check for gate resolution. The CLI runs it before interpreting any
// evidence, so a call that resolveConditionalGates would refuse never probes a browser or
// rewrites the browser runtime record. It returns the gates the resolution must cover.
export function conditionalGateRequest(manifest, controllerToken) {
  return withStateLock(manifest, () => {
    const state = readState(manifest);
    requireGateResolutionPreconditions(manifest, state, controllerToken);
    return { conditionalAgents: structuredClone(state.conditionalAgents), capabilities: conditionalGateUnion(state.conditionalAgents) };
  });
}

// Records the one-shot verdict for every conditional gate. Only the controller may resolve,
// only in discovery after Kalchas has arrived, and only once. The caller supplies a verdict
// per capability; the lane outcomes are always computed here: a lane is released exactly
// when every one of its gates is proven, and otherwise it is omitted as gate-unmet.
export function resolveConditionalGates(manifest, controllerToken, resolution = {}) {
  if (!plainObject(resolution) || Object.keys(resolution).some((key) => !['evidenceSha256', 'capabilities'].includes(key))) {
    throw new Error('gate resolution accepts only evidenceSha256 and capabilities; lane verdicts are computed by the runtime');
  }
  const { evidenceSha256 = null, capabilities } = resolution;
  if (!(evidenceSha256 === null || /^[a-f0-9]{64}$/.test(evidenceSha256))) throw new Error('gate resolution evidenceSha256 must be null or a SHA-256 hex digest');
  return mutateState(manifest, (state) => {
    requireGateResolutionPreconditions(manifest, state, controllerToken);
    const required = conditionalGateUnion(state.conditionalAgents);
    if (!plainObject(capabilities) || JSON.stringify(Object.keys(capabilities).sort()) !== JSON.stringify(required)) {
      throw new Error(`gate resolution must cover exactly the conditional gates: ${required.join(', ')}`);
    }
    const verdicts = {};
    for (const id of required) {
      if (!validGateVerdict(capabilities[id])) throw new Error(`gate verdict for ${id} must be exactly status (proven or unmet), basis, and reason`);
      verdicts[id] = { status: capabilities[id].status, basis: capabilities[id].basis, reason: capabilities[id].reason };
    }
    state.gateResolution = {
      resolvedAt: new Date().toISOString(),
      evidenceSha256,
      capabilities: verdicts,
      lanes: conditionalLaneVerdicts(state.conditionalAgents, verdicts),
    };
    return { result: structuredClone(state.gateResolution), changed: true };
  });
}

export function getBarrierStatus(manifest, phase) {
  return barrierStatus(manifest, readState(manifest), phase ?? readState(manifest).currentPhase);
}

export function cleanupWorker(manifest, lane, token, outcome, { controllerToken } = {}) {
  if (!['success', 'failure', 'interrupted'].includes(outcome)) throw new Error('cleanup outcome must be success, failure, or interrupted');
  return mutateState(manifest, (state) => {
    const allocation = state.allocations[lane];
    if (!allocation) throw new Error(`no allocation exists for ${lane}`);
    const authority = cleanupAuthority(manifest, state, lane, allocation, { token, controllerToken });
    if (allocation.status === 'released') {
      if (allocation.outcome !== outcome) throw new Error(`${lane} was already cleaned with outcome ${allocation.outcome}`);
      return { result: { lane, outcome, released: true, idempotent: true, authority }, changed: false };
    }
    if (lane === 'odysseus') {
      const activePeers = Object.values(state.allocations).filter((candidate) => candidate.lane !== lane && candidate.status === 'active');
      const foreignLocks = Object.values(state.exclusiveLocks).filter((lock) => lock.lane !== lane);
      if (activePeers.length > 0 || foreignLocks.length > 0) {
        throw new Error('Odysseus cannot be cleaned while a worker allocation or foreign exclusive lock remains active');
      }
      const finalBarrier = barrierStatus(manifest, state, 'complete');
      if (outcome === 'success' && (state.currentPhase !== 'complete' || !finalBarrier.complete ||
          !finalBarrier.participants.includes('odysseus') || !finalBarrier.arrived.includes('odysseus'))) {
        throw new Error('Odysseus success cleanup requires the terminal complete phase and its completed final barrier');
      }
    } else if (outcome === 'success') {
      // A lane keeps one allocation while any later phase may still need it: as a participant
      // until it has arrived everywhere, and on standby (proof repair, oracle desk) until the
      // standby phase has passed. Skipped phases need nobody.
      const phases = phaseIds(manifest);
      const currentIndex = phases.indexOf(state.currentPhase);
      const pending = phases.filter((phase, index) => {
        if (Object.hasOwn(state.skippedPhases, phase)) return false;
        if (barrierParticipants(manifest, state, phase).includes(lane) &&
            (index > currentIndex || !(state.barriers[phase] ?? []).includes(lane))) return true;
        return index >= currentIndex && standbyLanes(manifest, state, phase).includes(lane);
      });
      if (pending.length > 0) {
        throw new Error(`${lane} success cleanup is not yet available: pending ${pending.join(', ')}; the lease stays active and Odysseus performs terminal cleanup`);
      }
    }
    const checkpointPlan = prepareCheckpointArchive(manifest, state, lane, allocation);
    const coordinates = allocationCoordinates(manifest, lane);
    const { workerRoot } = coordinates;
    const shared = coordinates.public.browserSessionMode === 'shared-authorized';
    const activeSharedPeers = shared && Object.values(state.allocations).some((item) => item.lane !== lane && item.status === 'active' && item.browserProfile === allocation.browserProfile);
    const targets = {
      'browser-profile': coordinates.public.browserProfile,
      'browser-artifacts': coordinates.public.browserArtifactsDirectory,
      auth: coordinates.public.authDirectory,
      tmp: coordinates.public.temporaryDirectory,
      locks: join(workerRoot, 'locks'),
    };
    if (checkpointPlan?.sourceExists) {
      mkdirSync(dirname(checkpointPlan.destination), { recursive: true });
      renameSync(checkpointPlan.source, checkpointPlan.destination);
    }
    if (checkpointPlan) {
      if (!existsSync(checkpointPlan.archivedFile) ||
          sha256(readManagedFile(checkpointPlan.archivedFile, `${lane} archived checkpoint`)) !== checkpointPlan.checkpoint.sha256) {
        throw new Error(`checkpoint archive verification failed for ${lane}/${allocation.allocationId}`);
      }
      checkpointPlan.checkpoint.path = relative(manifest.artifactRoot, checkpointPlan.archivedFile).split(sep).join('/');
    }
    for (const key of manifest.cleanup.removeOnRelease) {
      if (activeSharedPeers && ['browser-profile', 'auth'].includes(key)) continue;
      rmSync(targets[key], { recursive: true, force: true });
    }
    const leasePath = join(workerRoot, '.lease');
    const leaseEntry = lstatEntry(leasePath);
    if (leaseEntry) assertManagedFile(leasePath, `${lane} lease`);
    rmSync(leasePath, { force: true });
    for (const [resource, held] of Object.entries(state.exclusiveLocks)) if (held.lane === lane) delete state.exclusiveLocks[resource];
    allocation.status = 'released';
    allocation.releasedAt = new Date().toISOString();
    allocation.outcome = outcome;
    return { result: { lane, outcome, released: true, authority }, changed: true };
  });
}

// Cleanup accepts the lane's own token on an active or an already released allocation,
// exactly as before, and a missing lease file does not block it. A worker may instead be
// cleaned on controller authority: while active through the full authority check (live lease
// marker included), and once released only as an idempotent replay, where no lease file is
// left to check and the active controller allocation alone is required.
function cleanupAuthority(manifest, state, lane, allocation, { token, controllerToken }) {
  if (nonEmpty(token)) {
    if (allocation.leaseTokenSha256 !== sha256(token)) throw new Error(`invalid lease for ${lane}`);
    return 'lane';
  }
  if (allocation.status === 'released' && lane !== 'odysseus' && nonEmpty(controllerToken)) {
    requireControllerAuthority(manifest, state, lane, controllerToken);
    return 'controller';
  }
  if (allocation.status === 'released') throw new Error(`invalid lease for ${lane}`);
  return requireLaneOrControllerAuthority(manifest, state, lane, { controllerToken });
}

function prepareCheckpointArchive(manifest, state, lane, allocation) {
  const checkpoint = state.checkpoints[lane];
  if (!checkpoint) return null;
  const source = engagementPath(manifest, join(manifest.writePolicy.checkpointRoot, lane));
  const destination = engagementPath(manifest, join(manifest.writePolicy.checkpointRoot, '.released', lane, allocation.allocationId));
  const checkpointName = checkpoint.path.split('/').at(-1);
  const sourceFile = engagementPath(manifest, checkpoint.path);
  const archivedFile = join(destination, checkpointName);
  const sourceEntry = lstatEntry(source);
  const destinationEntry = lstatEntry(destination);
  if (sourceEntry?.isSymbolicLink() || (sourceEntry && !sourceEntry.isDirectory()) ||
      destinationEntry?.isSymbolicLink() || (destinationEntry && !destinationEntry.isDirectory())) {
    throw new Error(`checkpoint archive path is unsafe for ${lane}/${allocation.allocationId}`);
  }
  if (sourceEntry && destinationEntry) throw new Error(`checkpoint source and archive both exist for ${lane}/${allocation.allocationId}`);
  if (!sourceEntry && !destinationEntry) throw new Error(`checkpoint source and archive are both missing for ${lane}/${allocation.allocationId}`);
  const verifiedFile = sourceEntry ? sourceFile : archivedFile;
  if ((sourceEntry && dirname(sourceFile) !== source) || basename(sourceFile) !== checkpointName) {
    throw new Error(`checkpoint state path differs from its lane archive plan for ${lane}/${allocation.allocationId}`);
  }
  assertManagedFile(verifiedFile, `${lane} checkpoint archive source`);
  if (sha256(readManagedFile(verifiedFile, `${lane} checkpoint archive source`)) !== checkpoint.sha256) {
    throw new Error(`checkpoint archive digest differs for ${lane}/${allocation.allocationId}`);
  }
  return { checkpoint, source, destination, archivedFile, sourceExists: Boolean(sourceEntry) };
}

export function locateEngagementManifest(cwd, explicit) {
  if (explicit) return existsSync(resolve(explicit)) ? resolve(explicit) : null;
  let cursor = resolve(cwd);
  while (true) {
    const candidate = join(cursor, 'ai_agents_internal', 'engagement.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function evaluateWriteGuard({ manifest, manifestPath, payload, cwd, bypassToken, now = new Date().toISOString() }) {
  const tool = String(payload.tool_name ?? payload.tool ?? '');
  const toolInput = payload.tool_input ?? payload.input ?? {};
  const command = tool === 'Bash' ? String(toolInput.command ?? '') : '';
  const commandSha256 = command ? sha256(command) : null;
  const artifactPhysical = resolvePhysical(manifest.artifactRoot, manifest.artifactRoot);
  let paths = [];
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(tool)) paths = collectDirectPaths(toolInput);
  else if (tool === 'Bash') {
    const packaged = classifyPackagedCommand(command, manifest, manifestPath, cwd, commandSha256);
    if (packaged?.decision) return packaged.decision;
    if (packaged?.paths) paths = packaged.paths;
    else {
      if (referencesPackagedCommand(command)) {
        return guardDecision('deny', 'GUARD-SHELL-AMBIGUOUS', 'packaged command must be one exact standalone invocation', [], commandSha256);
      }
      if (shellMayCreateLink(command)) {
        return guardDecision('deny', 'GUARD-LINK-ALIAS', 'shell command may create a filesystem link before a guarded write', [], commandSha256);
      }
      if (!shellMayWrite(command)) return guardDecision('allow', 'GUARD-ALLOW', 'shell command has no detected filesystem mutation', [], commandSha256);
      paths = collectShellWritePaths(command);
      if (paths.length === 0) return guardDecision('deny', 'GUARD-SHELL-AMBIGUOUS', 'write-capable shell command has no safely bounded destination', [], commandSha256);
    }
  } else return guardDecision('allow', 'GUARD-ALLOW', 'tool is outside the filesystem-write matcher', [], commandSha256);
  if (paths.length === 0) return guardDecision('deny', 'GUARD-PATH-UNRESOLVED', 'write tool has no recognized destination', [], commandSha256);
  const lane = guardLaneIdentity(payload);
  const selectedRoots = selectedTemplateWriteRoots(manifest);

  const evaluated = [];
  for (const rawPath of [...new Set(paths)]) {
    let physical;
    try {
      physical = resolvePhysical(rawPath, cwd);
    } catch {
      return guardDecision('deny', 'GUARD-PATH-UNRESOLVED', 'destination could not be normalized', evaluated, commandSha256);
    }
    const rel = relative(artifactPhysical, physical).split(sep).join('/') || '.';
    evaluated.push(rel);
    const heartbeatRoot = resolvePhysical('ai_agents_internal/heartbeat', manifest.artifactRoot);
    if (within(heartbeatRoot, physical)) {
      return guardDecision('deny', 'GUARD-HEARTBEAT-CONTROLLER', 'heartbeat artifacts require the packaged lease-authenticated controller', evaluated, commandSha256);
    }
    if (existsSync(physical)) {
      let destination;
      try { destination = lstatSync(physical); }
      catch {
        return guardDecision('deny', 'GUARD-PATH-UNRESOLVED', 'existing destination metadata could not be inspected', evaluated, commandSha256);
      }
      if (destination.isFile() && destination.nlink > 1) {
        return guardDecision('deny', 'GUARD-HARDLINK-ALIAS', 'existing destination has multiple hard links and may alias protected data', evaluated, commandSha256);
      }
    }
    if (canonicalForPhysical(manifest, physical)) {
      return guardDecision('deny', 'GUARD-CANONICAL-SINGLE-WRITER', 'canonical artifacts require immutable fragments and owner merge', evaluated, commandSha256);
    }
    if (isBypassed(manifest, physical, bypassToken, now)) continue;
    const owned = ownedWriteRootFor(manifest, physical, selectedRoots);
    if (owned) {
      const denial = ownedWriteDenial(owned, lane);
      if (denial) return guardDecision('deny', 'GUARD-OWNED-ARTIFACT', denial, evaluated, commandSha256);
      continue;
    }
    const allowedRoots = [
      ...manifest.writePolicy.allowedArtifactRoots,
      ...manifest.writePolicy.generatedTestRoots,
      ...selectedRoots.generated,
      manifest.writePolicy.workerRoot,
      manifest.writePolicy.fragmentRoot,
      manifest.writePolicy.checkpointRoot,
    ];
    if (!allowedRoots.some((root) => within(resolvePhysical(root, manifest.artifactRoot), physical))) {
      return guardDecision('deny', 'GUARD-TARGET-IMMUTABLE', 'destination is outside explicit artifact and generated-test roots', evaluated, commandSha256);
    }
  }
  const bypassed = evaluated.some((path) => isBypassed(manifest, resolvePhysical(path, manifest.artifactRoot), bypassToken, now));
  return guardDecision('allow', bypassed ? 'GUARD-EXPLICIT-BYPASS' : 'GUARD-ALLOW', bypassed ? 'exact operator bypass authorized the destination' : 'destinations are inside explicit write roots', evaluated, commandSha256);
}

export function buildGuardAudit({ manifest, payload, decision, timestamp }) {
  return {
    $schema: 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/immutability-audit.schema.json',
    schemaVersion: 1,
    timestamp,
    engagementId: manifest.engagementId,
    tool: String(payload.tool_name ?? payload.tool ?? 'unknown'),
    decision: decision.decision,
    ruleId: decision.ruleId,
    reason: decision.reason,
    paths: decision.paths,
    commandSha256: decision.commandSha256,
  };
}

// Lane-owned write roots: every writePolicy.ownedArtifactRoots entry, plus the harness root of
// the operator's template selection, is writable only by its listed owners. Ownership outranks
// every ordinary write root, except that a selected test root nested inside the selected
// harness root stays open to every lane.
function validateOwnedWritePolicy(policy, errors) {
  if (policy.ownedArtifactRoots !== undefined) {
    if (!Array.isArray(policy.ownedArtifactRoots)) errors.push('writePolicy.ownedArtifactRoots must be an array');
    else {
      const canonical = new Set(Array.isArray(policy.canonicalArtifacts) ? policy.canonicalArtifacts.map((item) => item?.path) : []);
      const declared = [];
      for (const item of policy.ownedArtifactRoots) {
        if (!plainObject(item) || Object.keys(item).some((key) => !['path', 'owners'].includes(key)) || !canonicalCorpusRoot(item.path) ||
            item.path.split('/')[0] === 'ai_agents_internal' || !stringList(item.owners, true) || !item.owners.every(validSlug)) {
          errors.push('owned artifact root path or owners are invalid');
        } else if (canonical.has(item.path)) errors.push(`owned artifact root is a canonical artifact: ${item.path}`);
        else if (declared.some((path) => overlappingPaths(path, item.path))) errors.push(`owned artifact roots overlap: ${item.path}`);
        else declared.push(item.path);
      }
    }
  }
  const selected = policy.selectedTemplateRoots;
  if (selected !== undefined && (!plainObject(selected) || Object.keys(selected).some((key) => key !== 'harnessRootOwners') ||
      !stringList(selected.harnessRootOwners, true) || !selected.harnessRootOwners.every(validSlug))) {
    errors.push('writePolicy.selectedTemplateRoots must name unique harnessRootOwners');
  }
}

// Claude Code, not the model, writes the PreToolUse payload: a subagent carries agent_id and its
// agent_type (`argus:<slug>`), while the main thread, which is the controller, carries no
// agent_id. A payload without the PreToolUse event name (such as the packaged CLI's own write
// check) or with any other agent shape identifies no lane.
function guardLaneIdentity(payload) {
  if (payload?.hook_event_name !== 'PreToolUse') return null;
  const agentType = payload.agent_type ?? null;
  if (agentType === null) return (payload.agent_id ?? null) === null ? 'odysseus' : null;
  const match = typeof agentType === 'string' ? /^(?:argus:)?([a-z][a-z0-9-]*)$/.exec(agentType) : null;
  return match ? match[1] : null;
}

// The owned root that physically contains the destination, or null; declared and selected owned
// roots never overlap. A root whose path crosses a symbolic link, or that cannot be resolved,
// is returned as unsafe, so the write is denied.
function ownedWriteRootFor(manifest, physical, selectedRoots) {
  for (const root of [...(manifest.writePolicy.ownedArtifactRoots ?? []), ...selectedRoots.owned]) {
    try {
      const artifactPhysical = resolvePhysical(manifest.artifactRoot, manifest.artifactRoot);
      const rootPhysical = resolvePhysical(root.path, artifactPhysical);
      if (!within(rootPhysical, physical)) continue;
      if ((root.open ?? []).some((path) => within(resolvePhysical(path, artifactPhysical), physical))) return null;
      return { ...root, safe: rootPhysical === join(artifactPhysical, ...root.path.split('/')) };
    } catch {
      return { ...root, safe: false };
    }
  }
  return null;
}

function ownedWriteDenial(owned, lane) {
  const owners = owned.owners.join(', ');
  if (!owned.safe) return `lane-owned ${owned.path} crosses a symbolic link`;
  if (!lane) return `lane-owned ${owned.path} is written only by ${owners}; the writing lane is not identified`;
  if (!owned.owners.includes(lane)) return `lane-owned ${owned.path} is written only by ${owners}, not ${lane}`;
  return null;
}

// Roots granted by the operator's explicit template selection. The record sits in the control
// plane, which no worker can write, and counts only when it is schema-valid and names this
// artifact or target root. The test root joins the generated test roots; the harness root is
// owned by selectedTemplateRoots.harnessRootOwners. A root is granted only below the artifact
// root through real directories, outside ai_agents_internal, clear of every canonical, owned,
// and control path (and, for the harness root, of every shared artifact root), and physically
// disjoint from the target root. Anything else grants nothing, so a doubtful record fails closed.
function selectedTemplateWriteRoots(manifest) {
  const none = { generated: [], owned: [] };
  const policy = manifest.writePolicy.selectedTemplateRoots;
  if (!plainObject(policy)) return none;
  try {
    const selection = reviewTemplateSelection(manifest);
    if (!selection || !selectionNamesEngagementRoot(manifest, selection.targetRoot)) return none;
    const testRoot = grantableTemplateRoot(manifest, selection.testRoot, { owned: false }) ? selection.testRoot : null;
    const harnessRoot = grantableTemplateRoot(manifest, selection.harnessRoot, { owned: true }) ? selection.harnessRoot : null;
    return {
      generated: testRoot ? [testRoot] : [],
      owned: harnessRoot
        ? [{ path: harnessRoot, owners: [...policy.harnessRootOwners], open: testRoot && testRoot.startsWith(`${harnessRoot}/`) ? [testRoot] : [] }]
        : [],
    };
  } catch {
    return none;
  }
}

function selectionNamesEngagementRoot(manifest, targetRoot) {
  if (!nonEmpty(targetRoot) || !isAbsolute(targetRoot) || !existsSync(targetRoot)) return false;
  const named = realpathSync(targetRoot);
  return [manifest.artifactRoot, manifest.target?.root].some((root) => nonEmpty(root) && existsSync(root) && realpathSync(root) === named);
}

function grantableTemplateRoot(manifest, root, { owned }) {
  if (!canonicalCorpusRoot(root) || root.split('/')[0] === 'ai_agents_internal') return false;
  const policy = manifest.writePolicy;
  const reserved = [
    ...policy.canonicalArtifacts.map((item) => item.path),
    ...(policy.ownedArtifactRoots ?? []).map((item) => item.path),
    policy.auditPath, policy.fragmentRoot, policy.checkpointRoot, policy.workerRoot, manifest.statePath,
    ...(owned ? policy.allowedArtifactRoots : []),
  ].map((path) => path.replace(/\/+$/, ''));
  if (reserved.some((path) => overlappingPaths(path, root))) return false;
  const artifactPhysical = resolvePhysical(manifest.artifactRoot, manifest.artifactRoot);
  let cursor = artifactPhysical;
  for (const part of root.split('/')) {
    cursor = join(cursor, part);
    let stats;
    try { stats = lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  }
  if (!nonEmpty(manifest.target?.root)) return true;
  const rootPhysical = resolvePhysical(root, artifactPhysical);
  const targetPhysical = resolvePhysical(manifest.target.root, artifactPhysical);
  return !within(targetPhysical, rootPhysical) && !within(rootPhysical, targetPhysical);
}

function overlappingPaths(left, right) {
  return left === right || right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

export function engagementPath(manifest, relativePath) {
  const path = resolve(manifest.artifactRoot, relativePath);
  if (!within(resolvePhysical(manifest.artifactRoot, manifest.artifactRoot), resolvePhysical(path, manifest.artifactRoot))) throw new Error(`engagement path escapes artifactRoot: ${relativePath}`);
  return path;
}

function readState(manifest, { persistMigration = false } = {}) {
  const path = engagementPath(manifest, manifest.statePath);
  const raw = readManagedFile(path, 'engagement state');
  const source = JSON.parse(raw.toString('utf8'));
  if (source.engagementId !== manifest.engagementId) throw new Error('engagement state does not match the manifest');
  const state = source;
  if (state.schemaVersion !== ENGAGEMENT_STATE_VERSION) throw new Error(`unsupported engagement state schemaVersion: ${state.schemaVersion}`);
  const errors = validateCurrentState(manifest, state);
  if (errors.length > 0) throw new Error(`engagement state integrity failed: ${errors.join('; ')}`);
  return state;
}

function mutateState(manifest, mutate) {
  return withStateLock(manifest, () => {
    const state = readState(manifest, { persistMigration: true });
    const { result, changed } = mutate(state);
    if (changed) {
      state.revision += 1;
      const errors = validateCurrentState(manifest, state);
      if (errors.length > 0) throw new Error(`engagement state mutation failed integrity validation: ${errors.join('; ')}`);
      atomicWriteJson(engagementPath(manifest, manifest.statePath), state);
    }
    return result;
  });
}

function lstatEntry(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function withStateLock(manifest, operation) {
  const statePath = engagementPath(manifest, manifest.statePath);
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 6000; attempt += 1) {
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        reclaimAbandonedStateLock(lockPath);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try {
      createManagedFile(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'engagement state lock owner');
      acquired = true;
      break;
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
  if (!acquired) throw new Error('timed out waiting for engagement state lock');
  try { return operation(); }
  finally { rmSync(lockPath, { recursive: true, force: true }); }
}

function reclaimAbandonedStateLock(lockPath) {
  const lockEntry = lstatEntry(lockPath);
  if (!lockEntry) return true;
  if (lockEntry.isSymbolicLink() || !lockEntry.isDirectory()) throw new Error('engagement state lock path is unsafe');
  if (!stateLockIsAbandoned(lockPath)) return false;
  const ownerEntry = lstatEntry(join(lockPath, 'owner.json'));
  const claimPath = join(lockPath, '.reclaim');
  try {
    mkdirSync(claimPath);
    createManagedFile(join(claimPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'state lock reclaim owner');
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  let quarantine = null;
  try {
    if (!sameDirectoryIdentity(lockEntry, lstatEntry(lockPath)) ||
        !sameFilesystemEntry(ownerEntry, lstatEntry(join(lockPath, 'owner.json')))) return false;
    quarantine = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
    renameSync(lockPath, quarantine);
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  } finally {
    if (!quarantine && sameDirectoryIdentity(lockEntry, lstatEntry(lockPath))) rmSync(claimPath, { recursive: true, force: true });
  }
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameFilesystemEntry(left, right) {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function stateLockIsAbandoned(lockPath) {
  const ownerPath = join(lockPath, 'owner.json');
  if (existsSync(ownerPath)) {
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1) return false;
    let owner;
    try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
    catch { return Date.now() - statSync(lockPath).mtimeMs > 30_000; }
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if (error.code === 'EPERM') return false;
        if (error.code === 'ESRCH') return true;
        return false;
      }
    }
  }
  return Date.now() - statSync(lockPath).mtimeMs > 30_000;
}

function requireLeaseState(manifest, state, lane, token) {
  requireSelected(manifest, lane);
  if (!nonEmpty(token)) throw new Error(`lease token is required for ${lane}`);
  const allocation = state.allocations[lane];
  if (!allocation || allocation.status !== 'active' || allocation.leaseTokenSha256 !== sha256(token)) throw new Error(`invalid or inactive lease for ${lane}`);
}

function requireControllerAllocation(manifest, state, lane, token, { bootstrap = false, selfRecovery = false } = {}) {
  const active = Object.values(state.allocations).filter((allocation) => allocation.status === 'active');
  if (lane === 'odysseus' && bootstrap && !state.allocations.odysseus && active.length === 0) return;
  const controller = state.allocations.odysseus;
  if (!controller || controller.status !== 'active' || !nonEmpty(token) || controller.leaseTokenSha256 !== sha256(token)) {
    throw new Error(`${lane} allocation requires the active Odysseus controller token`);
  }
  if (!hasExecutionBinding(controller)) throw new Error('Odysseus controller allocation has no authenticated model decision');
  if (!(selfRecovery && lane === 'odysseus')) requireLiveLeaseFile(manifest, state, 'odysseus', token, { allowMigratedToken: true });
}

function validateExecutionBinding(binding, { exact = true } = {}) {
  if (!plainObject(binding)
    || (exact && (Object.keys(binding).length !== EXECUTION_BINDING_FIELDS.length || !EXECUTION_BINDING_FIELDS.every((field) => Object.hasOwn(binding, field))))
    || !/^MDR-[a-f0-9]{24}$/.test(binding.modelDecisionId ?? '')
    || !/^[a-f0-9]{64}$/.test(binding.modelDecisionIntegritySha256 ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.dispatchId ?? '')
    || !Number.isInteger(binding.attempt) || binding.attempt < 1
    || !['claude', 'codex'].includes(binding.runtime)) {
    throw new Error('allocation requires an exact authenticated selected model decision binding');
  }
  return {
    modelDecisionId: binding.modelDecisionId,
    modelDecisionIntegritySha256: binding.modelDecisionIntegritySha256,
    dispatchId: binding.dispatchId,
    attempt: binding.attempt,
    runtime: binding.runtime,
  };
}

function validateDispatchAuthorization(manifest, lane, binding, document, expectedAllocationId) {
  if (binding.runtime !== 'codex') {
    if (document !== undefined && document !== null) throw new Error('dispatch authorization is valid only for Codex allocations');
    return null;
  }
  if (!plainObject(document)) throw new Error(`${lane} Codex allocation requires a fresh signed dispatch authorization`);
  const required = [
    'schema', 'kind', 'engagementId', 'decisionId', 'decisionIntegritySha256', 'allocationId',
    'agent', 'runtime', 'parentRuntime', 'parentSessionId', 'selectedConfigSha256', 'issuedBy',
    'issuedAt', 'expiresAt', 'nonce', 'reason', 'authentication',
  ];
  if (Object.keys(document).length !== required.length || required.some((field) => !Object.hasOwn(document, field))) {
    throw new Error('Codex dispatch authorization must use the exact v1 document shape');
  }
  const expected = {
    schema: 'argus/model-dispatch-authorization@1',
    kind: 'MODEL_DISPATCH_AUTHORIZATION',
    engagementId: manifest.engagementId,
    decisionId: binding.modelDecisionId,
    decisionIntegritySha256: binding.modelDecisionIntegritySha256,
    agent: lane,
    runtime: 'codex',
    parentRuntime: 'codex',
  };
  for (const [field, value] of Object.entries(expected)) if (document[field] !== value) throw new Error(`Codex dispatch authorization ${field} differs from the allocation`);
  if (!/^[a-f0-9]{24}$/.test(document.allocationId ?? '') || (expectedAllocationId && document.allocationId !== expectedAllocationId)) {
    throw new Error('Codex dispatch authorization allocationId differs from the allocation lifecycle');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(document.parentSessionId ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(document.nonce ?? '') ||
      typeof document.reason !== 'string' || !document.reason.trim()) {
    throw new Error('Codex dispatch authorization parent session, nonce, or reason is invalid');
  }
  verifyModelDocumentAuthentication(document, manifest.modelTrust);
  const issuedAt = Date.parse(document.issuedAt);
  const expiresAt = Date.parse(document.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 900_000 ||
      issuedAt > now + 300_000 || now >= expiresAt) {
    throw new Error('Codex dispatch authorization is expired, future-dated, or exceeds the 15-minute JIT window');
  }
  const decision = loadImmutableSelectedDecision(manifest, lane, binding);
  if (decision.runtime !== 'codex' || modelConfigSha256(decision.selectedConfig) !== document.selectedConfigSha256) {
    throw new Error('Codex dispatch authorization differs from the immutable selected decision');
  }
  return {
    allocationId: document.allocationId,
    dispatchAuthorizationSha256: modelAuthenticatedDocumentSha256(document),
    dispatchAuthorizationNonce: document.nonce,
    dispatchAuthorizedAt: document.issuedAt,
    dispatchAuthorizationExpiresAt: document.expiresAt,
    dispatchParentSessionId: document.parentSessionId,
  };
}

function loadImmutableSelectedDecision(manifest, lane, binding) {
  const decisionPath = engagementPath(manifest, join('ai_agents_internal/model-decisions', `${binding.modelDecisionId}.json`));
  assertManagedFile(decisionPath, `${lane} model decision`);
  let decision;
  try { decision = JSON.parse(readManagedFile(decisionPath, `${lane} model decision`).toString('utf8')); }
  catch { throw new Error(`${lane} model decision is not valid JSON`); }
  if (decision.decisionId !== binding.modelDecisionId || decision.integritySha256 !== binding.modelDecisionIntegritySha256 ||
      modelDecisionIntegritySha256(decision) !== binding.modelDecisionIntegritySha256 || decision.agent !== lane ||
      decision.runtime !== binding.runtime || decision.dispatchId !== binding.dispatchId || decision.attempt !== binding.attempt ||
      decision.status !== 'selected') {
    throw new Error(`${lane} execution binding differs from the immutable selected decision`);
  }
  return decision;
}

function validateDispatchAuthorizationUse(manifest, state, lane, allocation, dispatchBinding, { operation }) {
  if (!dispatchBinding) throw new Error(`${lane} Codex ${operation} requires a fresh JIT dispatch authorization`);
  const history = dispatchAuthorizationHistory(allocation);
  if (allocation && !allocation.dispatchAuthorizationSha256) {
    throw new Error(`${lane} Codex ${operation} cannot introduce a first dispatch authorization after allocation`);
  }
  if (history.some((entry) => entry.sha256 === dispatchBinding.dispatchAuthorizationSha256)) {
    throw new Error(`${lane} Codex ${operation} cannot replay a consumed dispatch authorization`);
  }
  if (history.some((entry) => entry.nonce === dispatchBinding.dispatchAuthorizationNonce)) {
    throw new Error(`${lane} Codex ${operation} dispatch authorization nonce was already consumed`);
  }
  if (operation === 'allocation' && history.some((entry) => entry.allocationId === dispatchBinding.allocationId)) {
    throw new Error(`${lane} Codex allocation cannot reuse a consumed allocation identity`);
  }
  if (allocation?.dispatchAuthorizedAt && Date.parse(dispatchBinding.dispatchAuthorizedAt) <= Date.parse(allocation.dispatchAuthorizedAt)) {
    throw new Error(`${lane} Codex ${operation} dispatch authorization must be newer than the active binding`);
  }
  for (const candidate of Object.values(state.allocations)) {
    if (candidate.lane === lane) continue;
    const otherHistory = dispatchAuthorizationHistory(candidate);
    if (otherHistory.some((entry) => entry.sha256 === dispatchBinding.dispatchAuthorizationSha256 ||
        entry.nonce === dispatchBinding.dispatchAuthorizationNonce || entry.allocationId === dispatchBinding.allocationId)) {
      throw new Error(`${lane} Codex ${operation} dispatch authorization identity is already bound to another allocation`);
    }
  }
  if (history.length >= 256) throw new Error(`${lane} Codex dispatch authorization history reached its bounded limit`);
}

function dispatchAuthorizationHistory(allocation) {
  if (!allocation) return [];
  const history = Array.isArray(allocation.dispatchAuthorizationHistory)
    ? allocation.dispatchAuthorizationHistory.map((entry) => ({ ...entry }))
    : [];
  if (allocation.dispatchAuthorizationSha256 && !history.some((entry) => entry.sha256 === allocation.dispatchAuthorizationSha256)) {
    history.push({
      allocationId: allocation.allocationId,
      sha256: allocation.dispatchAuthorizationSha256,
      nonce: allocation.dispatchAuthorizationNonce,
      issuedAt: allocation.dispatchAuthorizedAt,
    });
  }
  return history;
}

function dispatchBindingWithHistory(allocation, dispatchBinding) {
  return {
    ...dispatchBinding,
    dispatchAuthorizationHistory: [
      ...dispatchAuthorizationHistory(allocation),
      {
        allocationId: dispatchBinding.allocationId,
        sha256: dispatchBinding.dispatchAuthorizationSha256,
        nonce: dispatchBinding.dispatchAuthorizationNonce,
        issuedAt: dispatchBinding.dispatchAuthorizedAt,
      },
    ],
  };
}

// A retry carries exactly one immutable lineage. A worker escalation resumes from its
// current checkpoint. A pre-spawn model-unavailable retry and a controller-observed
// outcome restart (no-artifact, zero-candidates, uncheckpointed turn-limit) bind the prior
// selected decision and the exact active allocation instead, because no checkpoint exists.
function validateRetryLineage(manifest, state, allocation, decision) {
  if (decision.signal === 'normal') throw new Error(`${allocation.lane} retry cannot use a normal baseline decision`);
  const escalation = decision.escalationBinding;
  const availability = decision.availabilityBinding;
  const outcome = decision.outcomeBinding;
  if ([escalation, availability, outcome].filter(Boolean).length !== 1) {
    throw new Error(`${allocation.lane} retry requires exactly one immutable escalation, availability, or outcome lineage`);
  }
  if (escalation) {
    const checkpoint = state.checkpoints[allocation.lane];
    if (escalation.previousDecisionId !== allocation.modelDecisionId || !checkpoint ||
        escalation.checkpointRef !== checkpoint.path || escalation.checkpointSha256 !== checkpoint.sha256 ||
        checkpoint.allocationId !== allocation.allocationId || checkpoint.dispatchId !== allocation.dispatchId ||
        checkpoint.attempt !== allocation.attempt) {
      throw new Error(`${allocation.lane} retry escalation lineage is stale or belongs to another active attempt`);
    }
    const checkpointPath = engagementPath(manifest, checkpoint.path);
    assertManagedFile(checkpointPath, `${allocation.lane} retry checkpoint`);
    if (sha256(readManagedFile(checkpointPath, `${allocation.lane} retry checkpoint`)) !== checkpoint.sha256) {
      throw new Error(`${allocation.lane} retry checkpoint bytes differ from the immutable lineage`);
    }
  } else {
    const lineage = availability ?? outcome;
    const kind = availability ? 'availability' : 'outcome';
    const expectedAllocationSha256 = sha256(JSON.stringify(allocation));
    if (lineage.previousDecisionId !== allocation.modelDecisionId ||
        lineage.previousDecisionIntegritySha256 !== allocation.modelDecisionIntegritySha256 ||
        lineage.allocationId !== allocation.allocationId || lineage.allocationSha256 !== expectedAllocationSha256) {
      throw new Error(`${allocation.lane} retry ${kind} lineage is stale or belongs to another allocation`);
    }
  }
}

// A backoff retry may not rebind the allocation before its decision's backoff has elapsed,
// measured from the immutable decision creation time. The CLI waits or refuses first; this
// is the runtime's own fail-closed check for every other caller.
function requireRetryBackoffElapsed(lane, decision, now = Date.now()) {
  const backoffSeconds = decision.continuation?.backoffSeconds ?? 0;
  if (backoffSeconds === 0) return;
  if (!Number.isInteger(backoffSeconds) || backoffSeconds < 0) throw new Error(`${lane} retry backoff is malformed`);
  const createdAt = Date.parse(decision.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error(`${lane} retry decision has no valid creation time for its backoff`);
  if (now < createdAt + backoffSeconds * 1000) throw new Error(`${lane} retry backoff has not elapsed`);
}

function hasExecutionBinding(allocation) {
  try { validateExecutionBinding(allocation, { exact: false }); return true; }
  catch { return false; }
}

function sameExecutionBinding(allocation, binding) {
  try {
    const expected = validateExecutionBinding(binding);
    return Object.entries(expected).every(([field, value]) => allocation[field] === value);
  } catch {
    return false;
  }
}

function leaseMarker(allocation) {
  return `allocation:${allocation.allocationId}`;
}

function requireLiveLeaseFile(manifest, state, lane, token) {
  const allocation = state.allocations[lane];
  if (!allocation || allocation.status !== 'active' || !nonEmpty(token) || allocation.leaseTokenSha256 !== sha256(token)) {
    throw new Error(`invalid or inactive lease for ${lane}`);
  }
  requireLiveLeaseMarker(manifest, state, lane);
}

// The lane's allocation is active and its managed `.lease` file still carries the exact
// allocation marker. No token is involved: this proves the lease is live, not who holds it.
function requireLiveLeaseMarker(manifest, state, lane) {
  const allocation = state.allocations[lane];
  if (!allocation || allocation.status !== 'active') throw new Error(`no active allocation exists for ${lane}`);
  const leasePath = engagementPath(manifest, join(manifest.writePolicy.workerRoot, lane, '.lease'));
  if (!existsSync(leasePath)) throw new Error(`active lease file is missing for ${lane}`);
  const content = readManagedFile(leasePath, `${lane} lease`).toString('utf8').trim();
  if (content === leaseMarker(allocation)) return;
  throw new Error(`active lease marker does not match the allocation for ${lane}`);
}

// A worker-lane operation is authorized either by the lane's own active lease token or by
// the active Odysseus controller token. A supplied lane token is always judged on its own
// and never falls back to controller authority. Controller authority exists only for worker
// lanes (Odysseus's lane token is the controller token) and only while the worker's
// allocation is active with a live lease marker, so it can neither act on a lane that was
// never allocated nor revive a released one. The controller already receives every lane
// token at allocation and workers never receive the controller token, so this grants the
// controller nothing it could not already do and grants a worker nothing at all.
function requireLaneOrControllerAuthority(manifest, state, lane, { token, controllerToken } = {}) {
  if (nonEmpty(token)) {
    requireLeaseState(manifest, state, lane, token);
    return 'lane';
  }
  if (lane !== 'odysseus' && nonEmpty(controllerToken)) {
    requireSelected(manifest, lane);
    requireControllerAuthority(manifest, state, lane, controllerToken);
    requireLiveLeaseMarker(manifest, state, lane);
    return 'controller';
  }
  throw new Error(`lease token is required for ${lane}`);
}

function requireControllerAuthority(manifest, state, lane, controllerToken) {
  const controller = state.allocations.odysseus;
  if (!controller || controller.status !== 'active' || controller.leaseTokenSha256 !== sha256(controllerToken)) {
    throw new Error(`${lane} controller authority requires the active Odysseus controller token`);
  }
  requireControllerAllocation(manifest, state, lane, controllerToken);
}

function requireSelected(manifest, lane) {
  if (!manifest.selectedAgents.includes(lane)) throw new Error(`${lane} is not selected for this engagement`);
}

function requireDispatchableState(state, lane) {
  if (Array.isArray(state.dispatchableAgents) && !state.dispatchableAgents.includes(lane)) {
    throw new Error(`${lane} is outside the immutable dispatchable agent projection`);
  }
}

function requireConditionalRelease(state, lane) {
  if (!plainObject(state.conditionalAgents) || !Object.hasOwn(state.conditionalAgents, lane)) return;
  const gates = state.conditionalAgents[lane];
  const verdict = state.gateResolution?.lanes?.[lane];
  if (!verdict) throw new Error(`${lane} is conditional on ${gates.join(', ')}; run engagement resolve-gates first`);
  if (verdict !== 'released') {
    const unmet = gates.filter((gate) => state.gateResolution.capabilities[gate]?.status !== 'proven');
    throw new Error(`${lane} was omitted: gate unmet (${unmet.join(', ')})`);
  }
}

function requireGateResolutionPreconditions(manifest, state, controllerToken) {
  requireLeaseState(manifest, state, 'odysseus', controllerToken);
  if (state.gateResolution !== null) throw new Error('gate resolution is immutable once recorded');
  if (!hasConditionalLanes(state)) throw new Error('no conditional lanes await gate resolution');
  if (state.currentPhase !== GATE_RESOLUTION_PHASE) {
    throw new Error(`resolve-gates runs only in ${GATE_RESOLUTION_PHASE}; the current phase is ${state.currentPhase}`);
  }
  if (state.dispatchableAgents.includes('kalchas') && !(state.barriers[GATE_RESOLUTION_PHASE] ?? []).includes('kalchas')) {
    throw new Error('resolve-gates requires the Kalchas discovery arrival');
  }
}

function hasConditionalLanes(state) {
  return plainObject(state.conditionalAgents) && Object.keys(state.conditionalAgents).length > 0;
}

function conditionalGateUnion(conditionalAgents) {
  return [...new Set(Object.values(conditionalAgents ?? {}).flat())].sort();
}

function conditionalLaneVerdicts(conditionalAgents, verdicts) {
  return Object.fromEntries(Object.entries(conditionalAgents).map(([lane, gates]) =>
    [lane, gates.every((gate) => verdicts[gate]?.status === 'proven') ? 'released' : 'gate-unmet']));
}

// Lanes omitted by gate resolution leave every phase's participants and standby lanes, like
// a role that was never dispatchable, so no barrier or success cleanup waits for them.
function omittedConditionalLanes(state) {
  const lanes = plainObject(state.gateResolution?.lanes) ? state.gateResolution.lanes : {};
  return new Set(Object.keys(lanes).filter((lane) => lanes[lane] === 'gate-unmet'));
}

function validGateVerdict(verdict) {
  return plainObject(verdict) && Object.keys(verdict).length === GATE_VERDICT_KEYS.length &&
    GATE_VERDICT_KEYS.every((key) => Object.hasOwn(verdict, key)) && ['proven', 'unmet'].includes(verdict.status) &&
    typeof verdict.basis === 'string' && /^[a-z][a-z0-9+-]{0,63}$/.test(verdict.basis) &&
    nonEmpty(verdict.reason) && verdict.reason.length <= 240;
}

function requireCanonical(manifest, path) {
  const normalized = String(path).replace(/^\.\//, '');
  const canonical = manifest.writePolicy.canonicalArtifacts.find((item) => item.path === normalized);
  if (!canonical) throw new Error(`unknown canonical artifact: ${path}`);
  return canonical;
}

function canonicalForPhysical(manifest, physical) {
  return manifest.writePolicy.canonicalArtifacts.find((item) => resolvePhysical(item.path, manifest.artifactRoot) === physical);
}

function barrierStatus(manifest, state, phase) {
  const participants = barrierParticipants(manifest, state, phase);
  const arrived = state.barriers[phase] ?? [];
  const missing = participants.filter((lane) => !arrived.includes(lane));
  return { phase, participants, arrived: [...arrived].sort(), missing, complete: missing.length === 0 };
}

function barrierParticipants(manifest, state, phase) {
  return projectedPhaseLanes(state, phase, phaseDefinition(manifest, phase).participants);
}

// Standby lanes do not arrive at a barrier; they stay allocated so the phase can re-dispatch
// them on their active lease.
function standbyLanes(manifest, state, phase) {
  return projectedPhaseLanes(state, phase, phaseDefinition(manifest, phase).standby);
}

function projectedPhaseLanes(state, phase, lanes) {
  if (Object.hasOwn(state.skippedPhases, phase)) return [];
  if (!Array.isArray(state.dispatchableAgents)) return lanes;
  const dispatchable = new Set(state.dispatchableAgents);
  const omitted = omittedConditionalLanes(state);
  return lanes.filter((lane) => dispatchable.has(lane) && !omitted.has(lane));
}

function phaseDefinition(manifest, phase) {
  const definition = manifest.phasePlan.find((item) => item.id === phase);
  if (!definition) throw new Error(`unknown phase: ${phase}`);
  return definition;
}

function phaseIds(manifest) {
  return manifest.phasePlan.map((phase) => phase.id);
}

function nextUnskippedPhase(phases, state, index) {
  return phases.slice(index + 1).find((phase) => !Object.hasOwn(state.skippedPhases, phase));
}

function ledgerSnapshot(manifest, state, ledger, records, mergedAt) {
  const phases = phaseIds(manifest);
  const currentIndex = phases.indexOf(state.currentPhase);
  const byStatus = (status) => [...new Set(ledger.bugs.filter((bug) => bug.status === status).map((bug) => bug.id))].sort();
  const snapshot = { fragmentIds: records.map((record) => record.id) };
  for (const [field, status] of LEDGER_SNAPSHOT_STATUSES) snapshot[field] = byStatus(status);
  // Convergence counts only defects no earlier phase had already confirmed.
  const earlier = new Set(Object.entries(state.ledgerSnapshots)
    .filter(([phase]) => phases.indexOf(phase) < currentIndex)
    .flatMap(([, previous]) => previous.confirmed));
  snapshot.newConfirmed = snapshot.confirmed.filter((id) => !earlier.has(id));
  snapshot.mergedAt = mergedAt;
  return snapshot;
}

// Recorded skips that left planned work undone. The final summary cannot claim completion
// while any exists; a converged skip is evidence-backed and does not count.
function skippedPhaseStatusReasons(state) {
  return [...new Set(Object.values(state.skippedPhases)
    .filter((skip) => skip.reason !== 'converged')
    .map((skip) => `deep-hunt-skipped:${skip.reason}`))].sort();
}

function publicAllocation(allocation) {
  const { leaseTokenSha256, ...safe } = allocation;
  return safe;
}

function sharedSessionForLane(manifest, lane) {
  const shared = manifest.browserPolicy?.sessionMode === 'shared-authorized'
    ? manifest.browserPolicy.sharedSessionAuthorization
    : null;
  return shared?.lanes?.includes(lane) ? shared : null;
}

function allocationCoordinates(manifest, lane) {
  const workerRoot = engagementPath(manifest, join(manifest.writePolicy.workerRoot, lane));
  const shared = sharedSessionForLane(manifest, lane);
  const sharedRoot = shared ? engagementPath(manifest, join(manifest.writePolicy.workerRoot, 'shared-sessions', shared.id)) : null;
  return {
    workerRoot,
    public: {
      browserSessionMode: shared ? 'shared-authorized' : 'isolated-managed',
      browserProfileOwner: shared ? `shared-session:${shared.id}` : lane,
      browserProfile: join(sharedRoot ?? workerRoot, 'browser-profile'),
      browserArtifactsDirectory: join(workerRoot, 'browser-artifacts'),
      authDirectory: join(sharedRoot ?? workerRoot, 'auth'),
      temporaryDirectory: join(workerRoot, 'tmp'),
      outputDirectory: join(workerRoot, 'output'),
      accountAlias: shared ? shared.accountAlias : `argus-${lane}`,
      dataNamespace: `argus_${lane.replace(/-/g, '_')}`,
      port: manifest.resourcePolicy.portRange.start + [...manifest.selectedAgents].sort().indexOf(lane),
    },
  };
}

function validateStateAllocations(manifest, state) {
  if (!plainObject(state.allocations)) return ['allocations must be an object'];
  const errors = [];
  for (const [lane, allocation] of Object.entries(state.allocations)) {
    if (!manifest.selectedAgents.includes(lane) || !plainObject(allocation) || allocation.lane !== lane) {
      errors.push(`${lane}: unknown or malformed allocation`);
      continue;
    }
    const expected = allocationCoordinates(manifest, lane).public;
    for (const [field, value] of Object.entries(expected)) {
      if (allocation[field] !== value) errors.push(`${lane}: allocation ${field} differs from its manifest-derived value`);
    }
    if (!['active', 'released'].includes(allocation.status) || !/^[a-f0-9]{64}$/.test(allocation.leaseTokenSha256 ?? '') || !/^[a-f0-9]{24}$/.test(allocation.allocationId ?? '')) {
      errors.push(`${lane}: allocation status or lease digest is invalid`);
    }
    const presentBindingFields = EXECUTION_BINDING_FIELDS.filter((field) => Object.hasOwn(allocation, field));
    if (presentBindingFields.length > 0 && (presentBindingFields.length !== EXECUTION_BINDING_FIELDS.length || !hasExecutionBinding(allocation))) {
      errors.push(`${lane}: allocation model decision binding is partial or invalid`);
    } else if (presentBindingFields.length === 0) {
      errors.push(`${lane}: allocation has no authenticated model decision binding`);
    }
    const presentDispatchFields = DISPATCH_AUTHORIZATION_FIELDS.filter((field) => Object.hasOwn(allocation, field));
    const dispatchHistory = allocation.dispatchAuthorizationHistory;
    if (dispatchHistory !== undefined && (!Array.isArray(dispatchHistory) || dispatchHistory.length > 256 ||
        dispatchHistory.some((entry) => !plainObject(entry) || Object.keys(entry).length !== 4 ||
          !/^[a-f0-9]{24}$/.test(entry.allocationId ?? '') ||
          !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(entry.nonce ?? '') || !validDate(entry.issuedAt)) ||
        new Set(dispatchHistory.map((entry) => entry.sha256)).size !== dispatchHistory.length ||
        new Set(dispatchHistory.map((entry) => entry.nonce)).size !== dispatchHistory.length)) {
      errors.push(`${lane}: dispatch authorization history is invalid or contains replayed identities`);
    }
    if (allocation.runtime === 'codex') {
      if (presentDispatchFields.length !== DISPATCH_AUTHORIZATION_FIELDS.length ||
          !/^[a-f0-9]{64}$/.test(allocation.dispatchAuthorizationSha256 ?? '') ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(allocation.dispatchAuthorizationNonce ?? '') ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(allocation.dispatchParentSessionId ?? '') ||
          !Number.isFinite(Date.parse(allocation.dispatchAuthorizedAt ?? '')) ||
          !Number.isFinite(Date.parse(allocation.dispatchAuthorizationExpiresAt ?? '')) ||
          Date.parse(allocation.dispatchAuthorizationExpiresAt) <= Date.parse(allocation.dispatchAuthorizedAt)) {
        errors.push(`${lane}: Codex allocation has no valid JIT dispatch authorization binding`);
      }
      if (Array.isArray(dispatchHistory) && !dispatchHistory.some((entry) => entry.allocationId === allocation.allocationId && entry.sha256 === allocation.dispatchAuthorizationSha256 &&
          entry.nonce === allocation.dispatchAuthorizationNonce && entry.issuedAt === allocation.dispatchAuthorizedAt)) {
        errors.push(`${lane}: active Codex dispatch authorization is absent from its history`);
      }
    } else if (presentDispatchFields.length > 0 && allocation.runtime !== 'codex') {
      errors.push(`${lane}: non-Codex allocation carries a dispatch authorization binding`);
    }
  }
  const allDispatchHistory = Object.values(state.allocations).flatMap((allocation) =>
    plainObject(allocation) ? dispatchAuthorizationHistory(allocation).map((entry) => ({ lane: allocation.lane, ...entry })) : []);
  for (const field of ['allocationId', 'sha256', 'nonce']) {
    const owners = new Map();
    for (const entry of allDispatchHistory) {
      const prior = owners.get(entry[field]);
      if (prior && prior !== entry.lane) errors.push(`dispatch authorization ${field} is reused across ${prior} and ${entry.lane}`);
      else owners.set(entry[field], entry.lane);
    }
  }
  return errors;
}

function validateCurrentState(manifest, state) {
  const errors = validateStateAllocations(manifest, state);
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('revision must be a non-negative integer');
  const phases = phaseIds(manifest);
  if (!phases.includes(state.currentPhase)) errors.push('currentPhase is invalid');
  if (!Array.isArray(state.completedPhases) || state.completedPhases.some((phase) => !phases.includes(phase))) errors.push('completedPhases are invalid');
  validateSkippedPhases(manifest, state, errors);
  validateLedgerSnapshots(phases, state.ledgerSnapshots, errors);
  if (!(state.dispatchableAgents === null || (stringList(state.dispatchableAgents, true) &&
      state.dispatchableAgents.includes('odysseus') && state.dispatchableAgents.every((lane) => manifest.selectedAgents.includes(lane))))) {
    errors.push('dispatchableAgents must be null or an immutable selected projection containing odysseus');
  }
  validateConditionalLanes(state, errors);
  if (!plainObject(state.checkpoints)) errors.push('checkpoints must be an object');
  else for (const [lane, checkpoint] of Object.entries(state.checkpoints)) {
    const allocation = state.allocations?.[lane];
    if (!manifest.selectedAgents.includes(lane) || !plainObject(checkpoint) || !allocation) {
      errors.push(`${lane}: checkpoint is not bound to a selected allocation`);
      continue;
    }
    if (!phases.includes(checkpoint.phase)
      || !Number.isInteger(checkpoint.sequence) || checkpoint.sequence < 0
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checkpoint.dispatchId ?? '')
      || !Number.isInteger(checkpoint.attempt) || checkpoint.attempt < 1
      || checkpoint.allocationId !== allocation.allocationId
      || checkpoint.bindingOrigin !== 'runtime'
      || !safeRelative(checkpoint.path)
      || !/^[a-f0-9]{64}$/.test(checkpoint.sha256 ?? '')
      || !validDate(checkpoint.recordedAt)) {
      errors.push(`${lane}: checkpoint execution binding is invalid`);
    }
  }
  return errors;
}

function validateSkippedPhases(manifest, state, errors) {
  const skipped = state.skippedPhases;
  if (!plainObject(skipped)) {
    errors.push('skippedPhases must be an object');
    return;
  }
  const phases = phaseIds(manifest);
  for (const [phase, skip] of Object.entries(skipped)) {
    const definition = manifest.phasePlan.find((item) => item.id === phase);
    if (definition?.skippable !== true) errors.push(`skippedPhases.${phase}: phase is not skippable`);
    if (Array.isArray(state.completedPhases) && state.completedPhases.includes(phase)) errors.push(`skippedPhases.${phase}: a skipped phase cannot be completed`);
    if (!plainObject(skip) || Object.keys(skip).length !== 3 || !SKIP_REASONS.includes(skip.reason) || !validDate(skip.skippedAt) ||
        !(skip.basis === null || phases.includes(skip.basis))) {
      errors.push(`skippedPhases.${phase}: skip record must be exactly reason, skippedAt, and basis`);
    }
  }
  if (Object.hasOwn(skipped, state.currentPhase)) errors.push('currentPhase must not be a skipped phase');
}

// conditionalAgents and gateResolution are bound with the dispatchable projection: both stay
// null until it exists, then conditionalAgents is the sealed (possibly empty) lane map and
// gateResolution is null until the one-shot resolution, whose lane verdicts must be exactly
// the ones its capability verdicts imply.
function validateConditionalLanes(state, errors) {
  const conditional = state.conditionalAgents;
  const resolution = state.gateResolution;
  if (!Array.isArray(state.dispatchableAgents)) {
    if (conditional !== null) errors.push('conditionalAgents must be null until the dispatchable projection is bound');
    if (resolution !== null) errors.push('gateResolution must be null until the dispatchable projection is bound');
    return;
  }
  if (!plainObject(conditional)) {
    errors.push('conditionalAgents must be an object once the dispatchable projection is bound');
    return;
  }
  const lanes = Object.keys(conditional);
  let lanesValid = JSON.stringify(lanes) === JSON.stringify([...lanes].sort());
  if (!lanesValid) errors.push('conditionalAgents lanes must be sorted');
  for (const lane of lanes) {
    const gates = conditional[lane];
    if (!state.dispatchableAgents.includes(lane) || UNCONDITIONAL_LANES.includes(lane)) {
      errors.push(`conditionalAgents.${lane}: lane must be a dispatchable worker other than ${UNCONDITIONAL_LANES.join(' and ')}`);
      lanesValid = false;
    }
    if (!Array.isArray(gates) || gates.length === 0 || !gates.every(validCapabilityId) ||
        JSON.stringify(gates) !== JSON.stringify([...new Set(gates)].sort())) {
      errors.push(`conditionalAgents.${lane}: gates must be a sorted, unique, non-empty capability id list`);
      lanesValid = false;
    }
  }
  if (resolution === null) return;
  if (!plainObject(resolution) || Object.keys(resolution).length !== GATE_RESOLUTION_KEYS.length ||
      !GATE_RESOLUTION_KEYS.every((key) => Object.hasOwn(resolution, key)) || !validDate(resolution.resolvedAt) ||
      !(resolution.evidenceSha256 === null || /^[a-f0-9]{64}$/.test(resolution.evidenceSha256 ?? '')) ||
      !plainObject(resolution.capabilities) || !plainObject(resolution.lanes)) {
    errors.push(`gateResolution must be exactly ${GATE_RESOLUTION_KEYS.join(', ')}`);
    return;
  }
  if (!lanesValid) return;
  if (lanes.length === 0) {
    errors.push('gateResolution requires at least one conditional lane');
    return;
  }
  const required = conditionalGateUnion(conditional);
  if (JSON.stringify(Object.keys(resolution.capabilities).sort()) !== JSON.stringify(required)) {
    errors.push('gateResolution.capabilities must cover exactly the conditional gates');
    return;
  }
  for (const [id, verdict] of Object.entries(resolution.capabilities)) {
    if (!validGateVerdict(verdict)) errors.push(`gateResolution.capabilities.${id}: verdict must be exactly status, basis, and reason`);
  }
  if (JSON.stringify(Object.keys(resolution.lanes).sort()) !== JSON.stringify(lanes)) {
    errors.push('gateResolution.lanes must cover exactly the conditional lanes');
    return;
  }
  const expected = conditionalLaneVerdicts(conditional, resolution.capabilities);
  for (const lane of lanes) {
    if (resolution.lanes[lane] !== expected[lane]) errors.push(`gateResolution.lanes.${lane} must be ${expected[lane]}`);
  }
}

function validateLedgerSnapshots(phases, snapshots, errors) {
  if (!plainObject(snapshots)) {
    errors.push('ledgerSnapshots must be an object');
    return;
  }
  for (const [phase, snapshot] of Object.entries(snapshots)) {
    if (!phases.includes(phase)) errors.push(`ledgerSnapshots.${phase}: unknown phase`);
    if (!plainObject(snapshot) || Object.keys(snapshot).length !== LEDGER_SNAPSHOT_KEYS.length ||
        !LEDGER_SNAPSHOT_KEYS.every((key) => Object.hasOwn(snapshot, key)) ||
        !Array.isArray(snapshot.fragmentIds) || !snapshot.fragmentIds.every(nonEmpty) ||
        ![...LEDGER_SNAPSHOT_STATUSES.map(([field]) => field), 'newConfirmed'].every((field) => stringList(snapshot[field], false)) ||
        !validDate(snapshot.mergedAt)) {
      errors.push(`ledgerSnapshots.${phase}: snapshot must be exactly ${LEDGER_SNAPSHOT_KEYS.join(', ')}`);
    }
  }
}

function recoverInterruptedAllocation(manifest, state, lane, allocation) {
  const coordinates = allocationCoordinates(manifest, lane);
  const { workerRoot } = coordinates;
  const shared = coordinates.public.browserSessionMode === 'shared-authorized';
  const activeSharedPeers = shared && Object.values(state.allocations).some((item) => item.lane !== lane && item.status === 'active' && item.browserProfile === allocation.browserProfile);
  if (!activeSharedPeers) {
    rmSync(coordinates.public.browserProfile, { recursive: true, force: true });
    rmSync(coordinates.public.authDirectory, { recursive: true, force: true });
  }
  rmSync(coordinates.public.browserArtifactsDirectory, { recursive: true, force: true });
  rmSync(coordinates.public.temporaryDirectory, { recursive: true, force: true });
  rmSync(join(workerRoot, 'locks'), { recursive: true, force: true });
  for (const [resource, held] of Object.entries(state.exclusiveLocks)) if (held.lane === lane) delete state.exclusiveLocks[resource];
}

function collectDirectPaths(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /^(?:file_path|path|notebook_path|target_path)$/i.test(key)) output.push(child);
    else if (child && typeof child === 'object') collectDirectPaths(child, output);
  }
  return output;
}

function shellMayWrite(command) {
  return /(?:^|[;&|\s])(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|patch)(?:\s|$)|(?:^|\s)(?:sed\s+[^\n]*-[A-Za-z]*i|perl\s+[^\n]*-[A-Za-z]*[pi][A-Za-z]*)|(?:^|[^<])>{1,2}\s*[^&]|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|chmod(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|rmtree|remove|write_text|write_bytes|open|allocateWorker|startWorkerAttempt|resolveConditionalGates)\s*\(|\.write_(?:text|bytes)\s*\(/i.test(command);
}

function shellMayCreateLink(command) {
  return /(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:ln|link)(?:\s|$)|\b(?:linkSync|symlinkSync|link|symlink)\s*\(|\.(?:hardlink_to|symlink_to)\s*\(/i.test(command);
}

function classifyPackagedCommand(command, manifest, manifestPath, cwd, commandSha256) {
  const value = command.trim();
  if (/[;&|>\n\r`]|\$\(/.test(value)) return null;
  const tokens = shellTokens(value);
  const index = tokens.findIndex((token) => token === 'argus-assets' || token.endsWith('/argus-assets'));
  if (index !== 0) return null;
  const primary = tokens[index + 1];
  const operation = tokens[index + 2];
  const allow = (reason) => ({ decision: guardDecision('allow', 'GUARD-ALLOW', reason, [], commandSha256) });
  const deny = (reason) => ({ decision: guardDecision('deny', 'GUARD-SHELL-AMBIGUOUS', reason, [], commandSha256) });
  const optionNames = tokens.filter((token) => token.startsWith('--'));
  if (new Set(optionNames).size !== optionNames.length) return deny('duplicate command options are forbidden');
  if (['help', '--help', '-h', 'list', 'path', 'inventory', 'verify'].includes(primary)) return allow('packaged read-only command');
  if (primary === 'engagement') {
    if (operation === 'init') return deny('engagement init cannot run inside an active engagement');
    if (operation === 'report-facts') return classifyReportFactsCommand(tokens.slice(index + 3), manifest, manifestPath, cwd, allow, deny);
    if (operation === 'lane-outcomes') return classifyLaneOutcomesCommand(tokens.slice(index + 3), manifest, manifestPath, cwd, allow, deny);
    if (['validate', 'allocate', 'start-attempt', 'status', 'claim', 'release', 'fragment', 'merge', 'id', 'checkpoint', 'heartbeat', 'barrier', 'cleanup', 'resolve-gates'].includes(operation)) {
      const requestedManifest = optionValue(tokens, '--manifest');
      const activeManifest = manifestPath ?? join(manifest.artifactRoot, 'ai_agents_internal', 'engagement.json');
      if (requestedManifest && resolvePhysical(requestedManifest, cwd) !== resolvePhysical(activeManifest, cwd)) {
        return deny('engagement operation targets a manifest other than the active engagement');
      }
      const batchInput = inlineBatchInputDenial(tokens, optionNames);
      if (batchInput) return deny(batchInput);
      return allow('packaged engagement controller owns the bounded mutation');
    }
    return deny('unknown engagement controller operation');
  }
  if (primary === 'authorization') {
    if (operation === 'check' && optionNames.includes('--at')) return deny('authorization check --at is a test-only clock override and is refused inside an active engagement');
    if (operation === 'check') return allow('packaged authorization audit owns the bounded mutation');
    return deny('authorization init cannot run inside an active engagement');
  }
  if (primary === 'browser') return deny('browser provisioning is host/operator-only and cannot run inside an active engagement');
  if (primary === 'schema') {
    if (['list', 'validate'].includes(operation)) return allow('packaged schema command is read-only');
    return deny('unknown schema operation');
  }
  if (primary === 'model') {
    if (['list', 'benchmark', 'payload'].includes(operation)) return allow('packaged model policy inspection or canonical payload rendering is read-only');
    if (operation === 'trust') return deny('model trust pinning is host/operator-only and cannot run through an active-engagement worker tool');
    if (!['request', 'route', 'telemetry'].includes(operation)) return deny('unknown model policy operation');
    const requestedManifest = optionValue(tokens, '--manifest');
    const activeManifest = manifestPath ?? join(manifest.artifactRoot, 'ai_agents_internal', 'engagement.json');
    if (!requestedManifest || resolvePhysical(requestedManifest, cwd) !== resolvePhysical(activeManifest, cwd)) {
      return deny('model operation must bind to the active engagement manifest');
    }
    if (operation === 'telemetry' && optionNames.filter((name) => name === '--decision' || name === '--json').length !== 1) {
      return deny('model telemetry requires exactly one of an immutable --decision file or an inline --json batch');
    }
    const batchInput = inlineBatchInputDenial(tokens, optionNames);
    if (batchInput) return deny(batchInput);
    return allow('packaged model controller owns the bounded trust, request, decision, or telemetry mutation');
  }
  if (primary === 'orchestration') {
    if (operation !== 'plan') return deny('unknown orchestration operation');
    const output = optionValue(tokens, '--output') ?? '-';
    if (output === '-') return allow('orchestration projection is read-only');
    const root = optionValue(tokens, '--artifact-root') ?? cwd;
    const expected = join(manifest.artifactRoot, 'ai_agents_internal', 'orchestration-plan.json');
    try {
      if (resolvePhysical(root, cwd) !== resolvePhysical(manifest.artifactRoot, manifest.artifactRoot) ||
          resolvePhysical(output, resolve(cwd, root)) !== resolvePhysical(expected, manifest.artifactRoot)) {
        return deny('orchestration plan output must be the active engagement control artifact');
      }
    } catch {
      return deny('orchestration plan output cannot be resolved safely');
    }
    return allow('packaged orchestration controller owns the idempotent plan artifact');
  }
  if (primary === 'template') {
    if (operation === 'detect') {
      const output = optionValue(tokens, '--output') ?? '-';
      return output === '-' ? allow('template capability detection is read-only') : { paths: [output] };
    }
    if (operation === 'select') {
      const output = optionValue(tokens, '--output');
      return output ? { paths: [output] } : deny('template selection output is missing');
    }
    if (operation === 'scaffold') {
      const destination = optionValue(tokens, '--destination');
      return destination ? { paths: [destination] } : deny('template scaffold destination is missing');
    }
    return deny('unknown template operation');
  }
  if (primary === 'preflight') {
    const root = optionValue(tokens, '--artifact-root') ?? manifest.artifactRoot;
    const output = optionValue(tokens, '--output') ?? 'ai_agents_internal/preflight.json';
    if (resolvePhysical(root, cwd) !== resolvePhysical(manifest.artifactRoot, manifest.artifactRoot)) return { paths: [root] };
    if (!String(output).replace(/^\.\//, '').startsWith('ai_agents_internal/')) return { paths: [output] };
    return allow('packaged preflight writes only dedicated engagement control artifacts');
  }
  if (primary === 'redact') {
    const output = optionValue(tokens, '--output') ?? '-';
    return output === '-' ? allow('redactor writes only to stdout') : { paths: [output] };
  }
  if (primary === 'copy-template') {
    const destination = tokens[index + 3];
    return destination ? { paths: [destination] } : deny('copy-template destination is missing');
  }
  if (primary === 'copy-runner-kit') {
    const destination = tokens[index + 3];
    return destination ? { paths: [destination] } : deny('copy-runner-kit destination is missing');
  }
  if (primary === 'copy-browser-driver') {
    const destination = tokens[index + 2];
    return destination ? { paths: [
      join(destination, 'scripts', 'hunt-driver.mjs'),
      join(destination, 'scripts', 'driver.config.example.json'),
      join(destination, 'scripts', 'driver-config.schema.json'),
    ] } : deny('copy-browser-driver destination is missing');
  }
  if (primary === 'automation-review') {
    return classifyAutomationReviewCommand(operation, tokens.slice(index + 3), manifest, manifestPath, cwd, allow, deny);
  }
  if (Object.hasOwn(PACKAGED_QUERY_OPTIONS, primary)) {
    return classifyPackagedQuery(primary, operation, tokens.slice(index + 3), allow, deny);
  }
  return deny('unknown packaged command operation');
}

// `engagement report-facts` only reads the merge-verified canonical inputs. It must name the
// active manifest and accepts only --manifest and --output; stdout is read-only, and a file
// output goes through the ordinary write-root and canonical-owner checks.
function classifyReportFactsCommand(args, manifest, manifestPath, cwd, allow, deny) {
  for (let cursor = 0; cursor < args.length; cursor += 2) {
    const value = args[cursor + 1];
    if (!['--manifest', '--output'].includes(args[cursor]) || !value || value.startsWith('--')) {
      return deny('engagement report-facts accepts only --manifest <path> and --output <json|->');
    }
  }
  const requestedManifest = optionValue(args, '--manifest');
  const activeManifest = manifestPath ?? join(manifest.artifactRoot, 'ai_agents_internal', 'engagement.json');
  try {
    if (!requestedManifest || resolvePhysical(requestedManifest, cwd) !== resolvePhysical(activeManifest, cwd)) {
      return deny('engagement report-facts must bind to the active engagement manifest');
    }
  } catch {
    return deny('engagement report-facts manifest cannot be resolved safely');
  }
  const output = optionValue(args, '--output') ?? '-';
  return output === '-' ? allow('engagement report-facts to stdout is read-only') : { paths: [output] };
}

// `engagement lane-outcomes` writes only its fixed control artifact,
// ai_agents_internal/lane-outcomes.json, and has no output option. It must name the active
// manifest and carry the controller token, and accepts exactly those two options, so a
// smuggled --output or lease token fails closed here.
function classifyLaneOutcomesCommand(args, manifest, manifestPath, cwd, allow, deny) {
  for (let cursor = 0; cursor < args.length; cursor += 2) {
    const value = args[cursor + 1];
    if (!['--manifest', '--controller-token'].includes(args[cursor]) || !value || value.startsWith('--')) {
      return deny('engagement lane-outcomes accepts only --manifest <path> and --controller-token <odysseus-token>');
    }
  }
  if (!optionValue(args, '--controller-token')) return deny('engagement lane-outcomes requires --controller-token');
  const requestedManifest = optionValue(args, '--manifest');
  const activeManifest = manifestPath ?? join(manifest.artifactRoot, 'ai_agents_internal', 'engagement.json');
  try {
    if (!requestedManifest || resolvePhysical(requestedManifest, cwd) !== resolvePhysical(activeManifest, cwd)) {
      return deny('engagement lane-outcomes must bind to the active engagement manifest');
    }
  } catch {
    return deny('engagement lane-outcomes manifest cannot be resolved safely');
  }
  return allow('packaged engagement controller owns the idempotent lane-outcomes control artifact');
}

// Automation review commands only read the engagement and the test corpus. They must name the
// active manifest, accept exactly their declared options, and only `check --emit-gate <path>`
// writes: that destination goes through the ordinary write-root and canonical-owner checks.
const AUTOMATION_REVIEW_OPTIONS = Object.freeze({
  digest: Object.freeze({ values: ['--manifest'], flags: [] }),
  check: Object.freeze({ values: ['--manifest', '--emit-gate'], flags: ['--json'] }),
});

function classifyAutomationReviewCommand(operation, args, manifest, manifestPath, cwd, allow, deny) {
  if (!Object.hasOwn(AUTOMATION_REVIEW_OPTIONS, operation ?? '')) return deny('unknown automation-review operation');
  const accepted = AUTOMATION_REVIEW_OPTIONS[operation];
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    if (accepted.flags.includes(args[cursor])) continue;
    const value = args[cursor + 1];
    if (!accepted.values.includes(args[cursor]) || !value || value.startsWith('--')) {
      return deny(`automation-review ${operation} accepts only its declared options`);
    }
    cursor += 1;
  }
  const requestedManifest = optionValue(args, '--manifest');
  const activeManifest = manifestPath ?? join(manifest.artifactRoot, 'ai_agents_internal', 'engagement.json');
  try {
    if (!requestedManifest || resolvePhysical(requestedManifest, cwd) !== resolvePhysical(activeManifest, cwd)) {
      return deny('automation review must bind to the active engagement manifest');
    }
  } catch {
    return deny('automation review manifest cannot be resolved safely');
  }
  const gate = optionValue(args, '--emit-gate');
  return gate ? { paths: [gate] } : allow(`automation-review ${operation} is read-only`);
}

// Packaged queries print to stdout only. Each operation lists exactly the options its CLI
// parser accepts, so an unexpected option (for example a smuggled --output) fails closed here
// instead of depending on the CLI to reject it. `coverage calculate --output <path>` is the one
// write-capable form; its destination goes through the ordinary write-root and owner checks.
const PACKAGED_QUERY_OPTIONS = Object.freeze({
  technique: Object.freeze({ scopes: ['--role'], select: ['--role', '--inventory'] }),
  raci: Object.freeze({ list: [], route: ['--surface', '--activity', '--artifact', '--transition'] }),
  coverage: Object.freeze({
    validate: ['--inventory', '--observations', '--evidence', '--ledger', '--automation-status', '--root'],
    calculate: ['--inventory', '--observations', '--evidence', '--ledger', '--automation-status', '--root', '--output'],
  }),
});

function classifyPackagedQuery(primary, operation, args, allow, deny) {
  const operations = PACKAGED_QUERY_OPTIONS[primary];
  if (!Object.hasOwn(operations, operation ?? '')) return deny(`unknown ${primary} operation`);
  const accepted = operations[operation];
  for (let cursor = 0; cursor < args.length; cursor += 2) {
    const value = args[cursor + 1];
    if (!accepted.includes(args[cursor]) || !value || value.startsWith('--')) {
      return deny(`${primary} ${operation} accepts only its declared options, each with a value`);
    }
  }
  if (primary === 'coverage' && operation === 'calculate') {
    const output = optionValue(args, '--output') ?? '-';
    return output === '-' ? allow('coverage calculation writes only to stdout') : { paths: [output] };
  }
  return allow(`packaged ${primary} ${operation} query is read-only`);
}

function referencesPackagedCommand(command) {
  const shellResolved = command.replace(/\\([\s\S])/g, '$1').replace(/["']/g, '');
  return /argus-assets/i.test(shellResolved);
}

function optionValue(tokens, name) {
  const index = tokens.indexOf(name);
  return index >= 0 ? tokens[index + 1] : undefined;
}

// Controller batch input is inline only: exactly one single-line JSON object as the `--json`
// argv value. A batch file would have to live in the artifact root, which every worker can
// read, so `--json -`, `--json @file`, or a path is refused here, and so is stdin fed by a
// redirection or here-string (a heredoc or pipe never reaches this point: newlines and `|`
// are already refused for every packaged command).
function inlineBatchInputDenial(tokens, optionNames) {
  if (!optionNames.includes('--json')) return null;
  const value = optionValue(tokens, '--json');
  if (typeof value !== 'string' || !/^\{[^\n\r]*\}$/.test(value)) return 'batch --json input must be one inline single-line JSON object';
  if (tokens.some((token) => token.startsWith('<'))) return 'batch input is inline only; redirected, heredoc, and here-string stdin are refused';
  return null;
}

function collectShellWritePaths(command) {
  const paths = [];
  for (const match of command.matchAll(/(?:^|\s)(?:[0-9]*>>?|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) paths.push(match[1] ?? match[2] ?? match[3]);
  for (const match of command.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|renameSync|rename|chmodSync|chmod|rmSync|rm|rmdirSync|rmdir|rmtree|remove|open)\s*\(\s*[rbuf]*["']([^"']+)["']/gi)) paths.push(match[1]);
  for (const match of command.matchAll(/\bPath\s*\(\s*[rbuf]*["']([^"']+)["']\s*\)\s*\.write_(?:text|bytes)/gi)) paths.push(match[1]);
  const segments = command.split(/&&|\|\||;|\n/);
  for (const segment of segments) {
    const tokens = shellTokens(segment);
    const index = tokens.findIndex((token) => /^(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|patch|sed|perl)$/.test(token));
    if (index < 0) continue;
    const name = tokens[index];
    const operands = tokens.slice(index + 1).filter((token) => !token.startsWith('-') && !/^[0-7]{3,4}$/.test(token));
    if (['cp', 'install'].includes(name) && operands.length) paths.push(operands.at(-1));
    else if (['chmod', 'chown'].includes(name) && operands.length > 1) paths.push(...operands.slice(1));
    else if (['sed', 'perl', 'patch'].includes(name)) paths.push(...operands.filter(looksLikePath));
    else paths.push(...operands.filter(looksLikePath));
  }
  return [...new Set(paths.filter((path) => path && path !== '/dev/null' && !path.startsWith('/dev/fd/')))].map(stripShellPunctuation);
}

function shellTokens(value) {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function looksLikePath(value) {
  return value === '.' || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.includes('/') || /\.[A-Za-z0-9_-]{1,12}$/.test(value);
}

function stripShellPunctuation(value) {
  return value.replace(/^[({]+/, '').replace(/[)},]+$/, '');
}

function resolvePhysical(path, cwd) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  let cursor = absolute;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`no existing ancestor for ${path}`);
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function isBypassed(manifest, physical, token, now) {
  const bypass = manifest.writePolicy.bypass;
  if (!bypass.enabled || !nonEmpty(token) || sha256(token) !== bypass.tokenSha256 || !validDate(bypass.expiresAt) || Date.parse(bypass.expiresAt) <= Date.parse(now)) return false;
  return bypass.allowedPaths.some((path) => resolvePhysical(path, manifest.artifactRoot) === physical);
}

function guardDecision(decision, ruleId, reason, paths, commandSha256) {
  return { decision, ruleId, reason, paths, commandSha256 };
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fragmentOrder(a, b) {
  return a.id.localeCompare(b.id) || a.lane.localeCompare(b.lane) || a.path.localeCompare(b.path);
}

// A canonical artifact concatenates its fragments unless it declares latest-revision: then its
// owner alone writes numbered revisions and a merge publishes only the highest one. Structured
// documents keep their contract merge, so latest-revision is limited to markdown.
function canonicalMergeErrors(item) {
  if (!plainObject(item) || item.merge === undefined) return [];
  if (!CANONICAL_MERGE_MODES.includes(item.merge)) return [`canonical artifact merge must be ${CANONICAL_MERGE_MODES.join(' or ')}`];
  if (item.merge === 'latest-revision' && item.format !== 'markdown') return ['latest-revision merge is valid only for markdown artifacts'];
  return [];
}

function nextFragmentRevision(records) {
  return 1 + Math.max(0, ...records.map((record) => (Number.isInteger(record.revision) ? record.revision : 0)));
}

// Every revision must be an owner record with its own positive number; the highest one wins.
function latestFragmentRevision(canonical, records) {
  const seen = new Set();
  let latest = null;
  for (const record of records) {
    if (!Number.isInteger(record.revision) || record.revision < 1) throw new Error(`${canonical.path} fragment ${record.id} has no revision`);
    if (record.lane !== canonical.owner) throw new Error(`${canonical.path} revisions are written only by ${canonical.owner}`);
    if (seen.has(record.revision)) throw new Error(`${canonical.path} has more than one fragment at revision ${record.revision}`);
    seen.add(record.revision);
    if (!latest || record.revision > latest.revision) latest = record;
  }
  return latest;
}

// Fragments of every canonical share one write sequence, so an owner's successive documents
// are totally ordered. Records written before sequences existed count as 0.
function nextFragmentSequence(fragments) {
  let highest = 0;
  for (const list of Object.values(fragments)) {
    for (const record of list) if (Number.isInteger(record?.sequence) && record.sequence > highest) highest = record.sequence;
  }
  return highest + 1;
}

function fragmentSequence(canonical, record) {
  if (record.sequence === undefined) return 0;
  if (!Number.isInteger(record.sequence) || record.sequence < 1) throw new Error(`${canonical.path} fragment ${record.id} has an invalid sequence`);
  return record.sequence;
}

// A json-document canonical that is not a collection contract publishes one complete document.
function isSingleDocumentCanonical(canonical) {
  return canonical.format === 'json-document' && !isCollectionContract(canonical.schema);
}

// Only the owner supersedes a single-document canonical. Every fragment must still be a valid
// document of this engagement; in write-sequence order (a tie is ambiguous) each one keeps the
// contract's stability invariants relative to its predecessor, and the latest one is effective.
function supersedingFragment(manifest, canonical, records, contents) {
  const ordered = records.map((record, index) => {
    if (record.lane !== canonical.owner) throw new Error(`${canonical.path} is a single-document contract; only ${canonical.owner} may submit fragments`);
    const { errors, document } = validateCanonicalFragment(canonical.schema, contents[index]);
    if (errors.length) throw new Error(`${canonical.path} fragment ${record.id} is invalid: ${errors.join('; ')}`);
    if (document.engagementId !== manifest.engagementId) throw new Error(`${canonical.path} fragment ${record.id} engagementId does not match ${manifest.engagementId}`);
    return { record, document, sequence: fragmentSequence(canonical, record) };
  }).sort((left, right) => left.sequence - right.sequence);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const next = ordered[index];
    if (previous.sequence === next.sequence) {
      throw new Error(`${canonical.path} fragments ${previous.record.id} and ${next.record.id} share sequence ${next.sequence}`);
    }
    assertSupersession(canonical.schema, previous.document, next.document);
  }
  return ordered.at(-1).record;
}

// Kleio's evidence registry merge re-verifies every reference before publishing it: binary
// references must come from their reviewer's own fragment, retained bytes must still match
// their digest and content rules, and binary captures must be bound to the audited grant.
function verifyEvidenceRegistry(manifest, records, fragments, merged) {
  const errors = [];
  fragments.forEach((fragment, index) => {
    for (const ref of fragment.references) errors.push(...binaryRegistrationErrors(ref, records[index].lane));
  });
  const binaryAudit = binaryAuditVerifier(manifest);
  let patterns = null;
  for (const ref of merged.references) {
    let bytes;
    try { bytes = readManagedFile(engagementPath(manifest, ref.source), `evidence ${ref.id}`); }
    catch (error) { errors.push(`evidence ${ref.id} is missing or unsafe: ${error.message}`); continue; }
    if (sha256(bytes) !== ref.sha256) { errors.push(`evidence digest drift ${ref.id}`); continue; }
    errors.push(...validateEvidenceContent(ref, bytes, { patterns: patterns ??= loadRedactionPatterns() }));
    errors.push(...binaryAudit(ref));
  }
  if (errors.length) throw new Error(`evidence registry verification failed: ${errors.join('; ')}`);
}

// Returns the audit-binding check for binary references, reading the authorization audit at
// most once per merge and only when a binary reference needs it.
function binaryAuditVerifier(manifest) {
  let events = null;
  return (ref) => {
    if (!isBinaryReference(ref)) return [];
    try {
      events ??= loadAuthorizationAudit(manifest);
    } catch (error) {
      return [`binary evidence ${ref.id} audit binding cannot be verified: ${error.message}`];
    }
    return verifyBinaryReviewAudit(manifest, ref, events);
  };
}

// A binary reference needs one allow decision for binary-evidence, recorded for its
// collecting lane in this engagement at exactly review.auditTimestamp.
function verifyBinaryReviewAudit(manifest, ref, events = loadAuthorizationAudit(manifest)) {
  return binaryReviewAuditErrors(ref, events, manifest.engagementId);
}

// The audit log is the plain file named by authorization.json audit.path, beside it under
// ai_agents_internal/; a missing log holds no decisions.
function loadAuthorizationAudit(manifest) {
  const authorization = JSON.parse(readManagedFile(engagementPath(manifest, 'ai_agents_internal/authorization.json'), 'authorization manifest').toString('utf8'));
  const configured = authorization?.audit?.path;
  const name = typeof configured === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(configured) ? configured : 'authorization-audit.jsonl';
  const path = engagementPath(manifest, join('ai_agents_internal', name));
  if (!existsSync(path)) return [];
  return parseAuditLog(readManagedFile(path, 'authorization audit').toString('utf8'));
}

// A per-bug reconciliation failure quarantines that row instead of failing the merge. The
// demoted document must still satisfy the ledger contract, or the merge fails closed.
function quarantineLedgerFindings(document, byBug) {
  const quarantined = quarantineFindings(document, byBug);
  const errors = validateCanonicalDocument('bug-ledger', document);
  if (errors.length) throw new Error(`quarantined bug ledger is invalid: ${errors.join('; ')}`);
  return quarantined;
}

function atomicWriteJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) assertManagedFile(path, 'atomic write destination');
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    createManagedFile(temporary, content, 'atomic write temporary');
    assertManagedFile(temporary, 'atomic write temporary');
    if (existsSync(path)) assertManagedFile(path, 'atomic write destination');
    renameSync(temporary, path);
    assertManagedFile(path, 'atomic write result');
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function createManagedFile(path, content, label) {
  mkdirSync(dirname(path), { recursive: true });
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(path, flags, 0o600);
    assertManagedDescriptorPath(fd, path, label);
    writeFileSync(fd, content);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    assertManagedDescriptorPath(fd, path, label);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(path)) {
      try {
        const stats = lstatSync(path);
        if (stats.isFile() && stats.nlink === 1) rmSync(path, { force: true });
      } catch {}
    }
    throw error;
  }
  closeSync(fd);
}

function openManagedAppendFile(path, label) {
  mkdirSync(dirname(path), { recursive: true });
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try {
    assertManagedDescriptorPath(fd, path, label);
    fchmodSync(fd, 0o600);
    assertManagedDescriptorPath(fd, path, label);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertManagedFile(path, label) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stats.nlink !== 1) throw new Error(`${label} must have exactly one hard link`);
  return stats;
}

function readManagedFile(path, label) {
  const before = assertManagedFile(path, label);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    assertManagedDescriptorPath(fd, path, label);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed during secure open`);
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    assertManagedDescriptorPath(fd, path, label);
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed during secure read`);
    }
    return content;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertManagedDescriptorPath(fd, path, label) {
  const descriptor = fstatSync(fd);
  const linked = lstatSync(path);
  if (!descriptor.isFile() || !linked.isFile() || linked.isSymbolicLink() || descriptor.dev !== linked.dev || descriptor.ino !== linked.ino) {
    throw new Error(`${label} path does not identify the opened regular file`);
  }
  if (descriptor.nlink !== 1 || linked.nlink !== 1) throw new Error(`${label} must have exactly one hard link`);
}

function accessibilityPolicy(fallback, requirement) {
  const policy = structuredClone(fallback);
  if (!plainObject(requirement)) return policy;
  policy.version = requirement.version;
  policy.level = requirement.level;
  policy.exception = {
    requiredVersion: requirement.version,
    requiredLevel: requirement.level,
    reason: requirement.reason,
    requirementSource: requirement.requirementSource,
    approvedBy: requirement.approvedBy,
  };
  return policy;
}

function validateAccessibilityPolicy(policy, errors) {
  if (!plainObject(policy) || policy.standard !== 'WCAG' || !['2.0', '2.1', '2.2'].includes(policy.version) || !['A', 'AA', 'AAA'].includes(policy.level)) {
    errors.push('accessibilityPolicy must name a supported WCAG version and level');
    return;
  }
  if (policy.version === '2.2' && policy.level === 'AA') {
    if (policy.exception !== null) errors.push('WCAG 2.2 AA default must not carry an exception');
    return;
  }
  const exception = policy.exception;
  if (!plainObject(exception) || exception.requiredVersion !== policy.version || exception.requiredLevel !== policy.level || !['2.0', '2.1'].includes(exception.requiredVersion) || !nonEmpty(exception.reason) || !nonEmpty(exception.requirementSource) || !nonEmpty(exception.approvedBy)) {
    errors.push('older accessibility targets require an explicit project requirement exception');
  }
}

function validateBrowserPolicy(policy, selectedAgents, errors) {
  if (!plainObject(policy) || !['isolated-managed', 'shared-authorized'].includes(policy.sessionMode) || policy.profileReuse !== 'same-lane-within-engagement' || policy.profileStorage !== 'engagement-worker-root') {
    errors.push('browserPolicy session, reuse, or storage policy is invalid');
    return;
  }
  const mandatoryArtifacts = ['auth', 'cookies', 'downloads', 'traces', 'videos', 'screenshots'];
  if (!stringList(policy.sensitiveArtifacts, true) || !mandatoryArtifacts.every((item) => policy.sensitiveArtifacts.includes(item))) errors.push('browserPolicy.sensitiveArtifacts is incomplete');
  const shared = policy.sharedSessionAuthorization;
  if (policy.sessionMode === 'isolated-managed' && shared !== null) errors.push('isolated-managed sessions cannot carry shared authorization');
  if (policy.sessionMode === 'shared-authorized') {
    if (!plainObject(shared) || !validSlug(shared.id) || !stringList(shared.lanes, true) || shared.lanes.length < 2 || !shared.lanes.every((lane) => selectedAgents.includes(lane)) || !nonEmpty(shared.accountAlias) || !nonEmpty(shared.approvedBy) || !nonEmpty(shared.reason) || !nonEmpty(shared.authorizationRuleId) || !validDate(shared.expiresAt) || Date.parse(shared.expiresAt) <= Date.now()) {
      errors.push('shared-authorized sessions require an explicit, bounded authorization for selected lanes');
    }
  }
  const coverage = policy.coverage;
  if (!plainObject(coverage) || coverage.derivation !== 'target-support-and-risk' || !nonEmpty(coverage.supportSource) || !stringList(coverage.riskSignals, true) || !nonEmpty(coverage.rationale) || !Array.isArray(coverage.matrix) || coverage.matrix.length === 0) {
    errors.push('browserPolicy.coverage must be derived from target support and risk');
    return;
  }
  const keys = new Set();
  for (const item of coverage.matrix) {
    const valid = plainObject(item) && ['chromium', 'firefox', 'webkit'].includes(item.browser) && nonEmpty(item.device) && plainObject(item.viewport) && Number.isInteger(item.viewport.width) && item.viewport.width >= 240 && Number.isInteger(item.viewport.height) && item.viewport.height >= 240 && stringList(item.reasons, true);
    if (!valid) errors.push('browserPolicy.coverage matrix entry is invalid');
    else {
      const key = `${item.browser}:${item.device}:${item.viewport.width}x${item.viewport.height}`;
      if (keys.has(key)) errors.push(`duplicate browser coverage entry: ${key}`);
      keys.add(key);
    }
  }
}

// A manifest carries exactly the phase plan derivePhasePlan produced for its mode and
// selection. The runtime re-checks every property it relies on instead of trusting the file.
function validatePhasePlan(plan, selectedAgents, errors) {
  if (!Array.isArray(plan) || plan.length < 2) {
    errors.push('phasePlan must contain at least the preflight and complete phases');
    return;
  }
  const ids = plan.map((phase) => phase?.id);
  if (!ids.every(validSlug) || new Set(ids).size !== ids.length) errors.push('phasePlan ids must be unique slugs');
  if (ids[0] !== 'preflight' || ids.at(-1) !== 'complete') errors.push('phasePlan must start with preflight and end with complete');
  let highestWave = 0;
  plan.forEach((phase, index) => {
    const id = validSlug(phase?.id) ? phase.id : `#${index}`;
    if (!plainObject(phase)) {
      errors.push(`phase ${id} must be an object`);
      return;
    }
    const passKind = PASS_PHASE_KINDS.includes(phase.kind);
    const unknown = Object.keys(phase).filter((key) => !PHASE_KEYS.includes(key));
    const missing = PHASE_KEYS.filter((key) => key !== 'pass' && !Object.hasOwn(phase, key));
    if (unknown.length > 0 || missing.length > 0) errors.push(`phase ${id} must contain exactly id, wave, kind, pass (proof and deep-hunt only), skippable, participants, and standby`);
    if (!PHASE_KINDS.includes(phase.kind)) errors.push(`phase ${id} kind must be control, work, proof, or deep-hunt`);
    if (passKind !== (Object.hasOwn(phase, 'pass') && Number.isInteger(phase.pass) && phase.pass >= 0 && phase.pass <= 3)) {
      errors.push(`phase ${id} pass must be an integer 0-3 exactly when kind is proof or deep-hunt`);
    }
    if (typeof phase.skippable !== 'boolean' || (phase.skippable && !(passKind && phase.pass >= 2))) {
      errors.push(`phase ${id} skippable must be boolean and true only for a proof or deep-hunt pass of 2 or more`);
    }
    const waveIndex = PHASE_WAVES.indexOf(phase.wave);
    if (waveIndex < 0) errors.push(`phase ${id} wave must be controller or W0-W4`);
    else if (waveIndex > 0) {
      if (waveIndex < highestWave) errors.push(`phase ${id} regresses wave ${phase.wave}`);
      highestWave = Math.max(highestWave, waveIndex);
    }
    const participants = phase.participants;
    const standby = phase.standby;
    if (!stringList(participants, false) || !stringList(standby, false) ||
        ![...participants, ...standby].every((slug) => validSlug(slug) && selectedAgents.includes(slug))) {
      errors.push(`phase ${id} participants and standby must be unique selected agent slugs`);
      return;
    }
    for (const slug of participants) if (standby.includes(slug)) errors.push(`phase ${id} lists ${slug} as both participant and standby`);
    const control = index === 0 || index === plan.length - 1;
    if (control && (phase.kind !== 'control' || phase.wave !== 'controller' || standby.length > 0 || participants.some((slug) => slug !== 'odysseus'))) {
      errors.push(`phase ${id} must be a controller control phase with at most odysseus participating and no standby`);
    }
    if (!control && (phase.kind === 'control' || phase.wave === 'controller')) errors.push(`phase ${id}: only preflight and complete may be controller control phases`);
    if (phase.kind === 'proof' && participants.some((slug) => slug !== PROOF_VALIDATOR)) errors.push(`proof phase ${id} participants must be a subset of ${PROOF_VALIDATOR}`);
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRelative(value) {
  return nonEmpty(value) && !isAbsolute(value) && !String(value).split(/[\\/]/).includes('..');
}

function stringList(value, requireNonEmpty) {
  return Array.isArray(value) && (!requireNonEmpty || value.length > 0) && value.every(nonEmpty) && new Set(value).size === value.length;
}

function validSlug(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

function validCapabilityId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validModelTrustKey(key, purpose) {
  return plainObject(key) && key.algorithm === 'Ed25519' && key.purpose === purpose &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key.keyId ?? '') && nonEmpty(key.subjectId) &&
    nonEmpty(key.publicKeyPem) && /^[a-f0-9]{64}$/.test(key.keyFingerprintSha256 ?? '');
}

function validDate(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}
