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
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mergeCanonicalDocuments, migrateCanonicalDocument, renderFinalSummary, schemaId, stableIdentity, validateCanonicalFragment } from './contracts.mjs';
import {
  modelAuthenticatedDocumentSha256,
  modelConfigSha256,
  modelDecisionIntegritySha256,
  verifyModelDocumentAuthentication,
} from './model-policy.mjs';

const PHASES = ['preflight', 'discovery', 'hunting', 'automation', 'verification', 'reporting', 'complete'];
const HUNTERS = new Set(['antigone', 'ariadne', 'atalanta', 'charon', 'hermes', 'lynceus', 'orion', 'perseus', 'proteus', 'tiresias', 'tyche']);
const AUTOMATION = new Set(['aegis', 'asklepios', 'atlas', 'daidalos', 'mnemosyne', 'nike', 'penelope', 'pistis', 'talos', 'theseus']);
const VERIFIERS = new Set(['aristarchus', 'minos']);
const REPORTERS = new Set(['kleio', 'metis', 'minos']);
const ENGAGEMENT_STATE_VERSION = 2;
const HEARTBEAT_STATUSES = ['started', 'running', 'blocked', 'degraded', 'complete', 'failed'];
const EXECUTION_BINDING_FIELDS = ['modelDecisionId', 'modelDecisionIntegritySha256', 'dispatchId', 'attempt', 'runtime'];
const DISPATCH_AUTHORIZATION_FIELDS = [
  'dispatchAuthorizationSha256', 'dispatchAuthorizationNonce', 'dispatchAuthorizedAt',
  'dispatchAuthorizationExpiresAt', 'dispatchParentSessionId',
];

export function createDefaultEngagement({ template, target, targetRoot, artifactRoot, mode, engagementId, selectedAgents, browserSupport, accessibilityRequirement }) {
  const manifest = structuredClone(template);
  const agents = [...new Set(selectedAgents)].sort();
  manifest.$schema = 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/engagement-manifest.schema.json';
  manifest.engagementId = engagementId;
  manifest.mode = mode;
  manifest.target = { identifier: target, root: targetRoot };
  manifest.artifactRoot = artifactRoot;
  manifest.selectedAgents = agents;
  manifest.accessibilityPolicy = accessibilityPolicy(manifest.accessibilityPolicy, accessibilityRequirement);
  manifest.browserPolicy.coverage = deriveBrowserCoverage(manifest.browserPolicy.coverage, browserSupport);
  manifest.phasePlan = PHASES.map((id) => ({ id, participants: phaseParticipants(id, agents) }));
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
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!nonEmpty(manifest.engagementId)) errors.push('engagementId is required');
  if (!['A', 'B', 'C', 'D'].includes(manifest.mode)) errors.push('mode must be A, B, C, or D');
  if (!plainObject(manifest.target) || !nonEmpty(manifest.target.identifier) || !(manifest.target.root === null || nonEmpty(manifest.target.root))) {
    errors.push('target identifier/root are invalid');
  }
  if (!nonEmpty(manifest.artifactRoot) || !isAbsolute(manifest.artifactRoot)) errors.push('artifactRoot must be absolute');
  if (!stringList(manifest.selectedAgents, true) || !manifest.selectedAgents.every(validSlug)) errors.push('selectedAgents must contain unique slugs');
  const modelTrust = manifest.modelTrust ?? null;
  const legacyBootstrap = modelTrust?.legacyBootstrap ?? null;
  const runtimeTrust = modelTrust?.keys?.runtimeAttestation;
  const operatorTrust = modelTrust?.keys?.operatorApproval;
  if (modelTrust !== null && (!plainObject(modelTrust) || modelTrust.schema !== 'argus/model-trust-bundle@1' || modelTrust.source !== 'host-trust-store' ||
      !/^[a-f0-9]{64}$/.test(modelTrust.trustStoreSha256 ?? '') || !validDate(modelTrust.pinnedAt) ||
      !validModelTrustKey(runtimeTrust, 'runtime-attestation') || !validModelTrustKey(operatorTrust, 'operator-approval') ||
      runtimeTrust.keyId === operatorTrust.keyId || runtimeTrust.keyFingerprintSha256 === operatorTrust.keyFingerprintSha256 ||
      !(legacyBootstrap === null || (plainObject(legacyBootstrap) && legacyBootstrap.kind === 'legacy-v1-active-allocation' &&
        validSlug(legacyBootstrap.authenticatedLane) && /^[a-f0-9]{24}$/.test(legacyBootstrap.allocationId ?? '') &&
        /^state-v1-[a-f0-9]{24}$/.test(legacyBootstrap.migrationId ?? '') && /^[a-f0-9]{64}$/.test(legacyBootstrap.migrationSourceSha256 ?? ''))))) {
    errors.push('modelTrust must be null or a complete purpose-separated host-trust-store Ed25519 bundle');
  }
  validateAccessibilityPolicy(manifest.accessibilityPolicy, errors);
  validateBrowserPolicy(manifest.browserPolicy, manifest.selectedAgents, errors);
  if (!Array.isArray(manifest.phasePlan) || manifest.phasePlan.length !== PHASES.length) {
    errors.push(`phasePlan must contain ${PHASES.join(', ')}`);
  } else {
    const ids = manifest.phasePlan.map((phase) => phase?.id);
    if (JSON.stringify(ids) !== JSON.stringify(PHASES)) errors.push(`phasePlan order must be ${PHASES.join(', ')}`);
    for (const phase of manifest.phasePlan) {
      if (!stringList(phase?.participants, false) || !phase.participants.every((slug) => manifest.selectedAgents.includes(slug))) {
        errors.push(`phase ${phase?.id ?? '(missing)'} participants must be selected agent slugs`);
      }
    }
  }
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
      if (!safeRelative(item?.path) || !validSlug(item?.owner) || !['markdown', 'text', 'json', 'json-document'].includes(item?.format) || (item.schema !== undefined && ![null, 'bug-ledger', 'lane-plan', 'evidence-reference', 'automation-status', 'surface-inventory', 'coverage-observations', 'coverage-result', 'final-summary'].includes(item.schema)) || (item.schema && item.format !== 'json-document')) {
        errors.push('canonical artifact path, owner, or format is invalid');
      } else if (paths.has(item.path)) errors.push(`duplicate canonical artifact: ${item.path}`);
      else paths.add(item.path);
    }
  }
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
  return {
    $schema: 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/engagement-state.schema.json',
    schemaVersion: ENGAGEMENT_STATE_VERSION,
    engagementId: manifest.engagementId,
    revision: 0,
    currentPhase: 'discovery',
    completedPhases: ['preflight'],
    dispatchableAgents: null,
    allocations: {},
    barriers: Object.fromEntries(PHASES.map((phase) => [phase, []])),
    exclusiveLocks: {},
    nextIds: Object.fromEntries(Object.keys(manifest.idAllocators).map((kind) => [kind, 1])),
    idKeys: Object.fromEntries(Object.keys(manifest.idAllocators).map((kind) => [kind, {}])),
    checkpoints: {},
    fragments: {},
    merges: {},
    migrations: [],
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

export function bindDispatchableAgents(manifest, agents) {
  const normalized = [...new Set(agents ?? [])].sort();
  if (!normalized.includes('odysseus') || normalized.some((lane) => !manifest.selectedAgents.includes(lane))) {
    throw new Error('dispatchable agent projection must include Odysseus and remain within selectedAgents');
  }
  return mutateState(manifest, (state) => {
    if (Object.values(state.allocations).some((allocation) => allocation.status === 'active')) {
      throw new Error('dispatchable agent projection must be sealed before allocation');
    }
    if (Array.isArray(state.dispatchableAgents)) {
      if (JSON.stringify(state.dispatchableAgents) !== JSON.stringify(normalized)) {
        throw new Error('dispatchable agent projection is immutable once bound');
      }
      return { result: normalized, changed: false };
    }
    state.dispatchableAgents = normalized;
    return { result: normalized, changed: true };
  });
}

export function allocateWorker(manifest, lane, { resumeToken, controllerToken, executionBinding, dispatchAuthorization } = {}) {
  requireSelected(manifest, lane);
  return mutateState(manifest, (state) => {
    requireDispatchableState(state, lane);
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
      if (!hasExecutionBinding(existing)) throw new Error(`${lane} migrated allocation must bind its authenticated model decision before resume`);
      if (executionBinding && !sameExecutionBinding(existing, executionBinding)) throw new Error(`${lane} resume decision differs from its active allocation`);
      const dispatchBinding = validateDispatchAuthorization(manifest, lane, existing, dispatchAuthorization, existing.allocationId);
      if (existing.runtime === 'codex') {
        validateDispatchAuthorizationUse(manifest, state, lane, existing, dispatchBinding, { operation: 'resume', allowFirstLegacy: true });
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
      if (!hasExecutionBinding(existing)) throw new Error(`${lane} migrated allocation must bind its authenticated model decision before recovery`);
      if (!sameExecutionBinding(existing, binding)) throw new Error(`${lane} recovery decision differs from its active allocation`);
      dispatchBinding = validateDispatchAuthorization(manifest, lane, binding, dispatchAuthorization, existing.allocationId);
      if (binding.runtime === 'codex') validateDispatchAuthorizationUse(manifest, state, lane, existing, dispatchBinding, { operation: 'recovery', allowFirstLegacy: true });
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
    requireLeaseState(manifest, state, lane, token);
    requireLiveLeaseFile(manifest, state, lane, token);
    requireControllerAllocation(manifest, state, lane, controllerToken ?? (lane === 'odysseus' ? token : null));
    if (!hasExecutionBinding(allocation)) throw new Error(`${lane} retry requires an authenticated active attempt`);
    if (binding.runtime !== allocation.runtime || binding.dispatchId !== allocation.dispatchId || binding.attempt !== allocation.attempt + 1) {
      throw new Error(`${lane} retry must advance exactly one attempt on the same runtime and dispatch`);
    }
    const decision = loadImmutableSelectedDecision(manifest, lane, binding);
    validateRetryLineage(manifest, state, allocation, decision);
    const dispatchBinding = validateDispatchAuthorization(manifest, lane, binding, dispatchAuthorization, allocation.allocationId);
    if (binding.runtime === 'codex') validateDispatchAuthorizationUse(manifest, state, lane, allocation, dispatchBinding, { operation: 'retry' });
    const nextToken = randomBytes(32).toString('hex');
    Object.assign(allocation, binding);
    if (dispatchBinding) Object.assign(allocation, dispatchBindingWithHistory(allocation, dispatchBinding));
    allocation.leaseTokenSha256 = sha256(nextToken);
    return {
      result: { ...publicAllocation(allocation), token: nextToken, attemptStarted: true, previousAttempt: binding.attempt - 1 },
      changed: true,
    };
  });
}

export function bindLegacyAllocationDecision(manifest, lane, token, executionBinding) {
  requireSelected(manifest, lane);
  const binding = validateExecutionBinding(executionBinding);
  const result = mutateState(manifest, (state) => {
    const allocation = state.allocations[lane];
    requireLeaseState(manifest, state, lane, token);
    const migratedId = state.migrations.find((item) => item.fromVersion === 1 && item.toVersion === ENGAGEMENT_STATE_VERSION)
      ?.activeAllocationIdsAtMigration?.[lane];
    if (!migratedId || allocation.allocationId !== migratedId) throw new Error(`${lane} is not the exact active allocation preserved from v1`);
    requireLiveLeaseFile(manifest, state, lane, token, { allowMigratedToken: true });
    if (hasExecutionBinding(allocation)) {
      if (!sameExecutionBinding(allocation, binding)) throw new Error(`${lane} legacy allocation already has a different model decision`);
      return { result: publicAllocation(allocation), changed: false };
    }
    Object.assign(allocation, binding);
    return { result: publicAllocation(allocation), changed: true };
  });
  const state = getEngagementStatus(manifest);
  requireLiveLeaseFile(manifest, state, lane, token, { upgradeMigratedToken: true });
  return result;
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
  let persistedContent = String(content);
  if (canonical.schema) {
    const { errors, document } = validateCanonicalFragment(canonical.schema, content);
    if (errors.length) throw new Error(`fragment does not satisfy a compatible ${canonical.schema} contract: ${errors.join('; ')}`);
    if (document.engagementId !== manifest.engagementId) throw new Error(`fragment engagementId does not match ${manifest.engagementId}`);
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
    const record = { id: fragmentId, lane, path: relative(manifest.artifactRoot, path).split(sep).join('/'), sha256: digest };
    if (!list.some((item) => item.id === fragmentId && item.lane === lane)) list.push(record);
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
    let output;
    if (canonical.format === 'json-document') {
      const documents = contents.map((content) => JSON.parse(content));
      const document = mergeCanonicalDocuments(canonical.schema, documents);
      output = `${JSON.stringify(document, null, 2)}\n`;
    } else if (canonical.format === 'json') output = `${JSON.stringify(contents.map((content) => JSON.parse(content)), null, 2)}\n`;
    else output = `${contents.join('\n\n')}\n`;
    const destination = engagementPath(manifest, canonical.path);
    atomicWrite(destination, output);
    if (canonical.schema === 'final-summary') {
      atomicWrite(engagementPath(manifest, 'solution/FINAL-SUMMARY.md'), renderFinalSummary(JSON.parse(output)));
    }
    const result = { owner, fragments: records.length, sha256: sha256(output), mergedAt: new Date().toISOString() };
    state.merges[canonical.path] = result;
    return { result: { ...result, path: destination }, changed: true };
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
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`);
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
// Re-entry validates the original record without appending; a migrated v1 active
// allocation is the only case that may truthfully resume without a historical log.
export function ensurePreflightHeartbeat(manifest, timestamp = new Date().toISOString()) {
  return withStateLock(manifest, () => {
    const state = readState(manifest, { persistMigration: true });
    requireSelected(manifest, 'odysseus');
    if (!validDate(timestamp)) throw new Error('preflight heartbeat timestamp must be an ISO date-time');
    const path = heartbeatPath(manifest, 'odysseus');
    const relativePath = relative(manifest.artifactRoot, path).split(sep).join('/');
    const allocation = state.allocations.odysseus;
    const migration = state.migrations.find((item) => item.fromVersion === 1 && item.toVersion === ENGAGEMENT_STATE_VERSION);
    const resumedLegacyAllocation = allocation?.status === 'active'
      && migration?.activeAllocationIdsAtMigration?.odysseus === allocation.allocationId;
    if (existsSync(path)) {
      const records = parseHeartbeatLog(readManagedFile(path, 'Odysseus heartbeat').toString('utf8'), 'odysseus');
      const initial = records[0];
      if (initial?.phase === 'preflight' && initial.completed === 0 && initial.total === 1 && initial.status === 'running') {
        return { disposition: 'existing', wrote: false, lane: 'odysseus', path: relativePath, record: initial };
      }
      if (resumedLegacyAllocation && initial && PHASES.indexOf(initial.phase) > PHASES.indexOf('preflight')) {
        return { disposition: 'legacy-migrated-existing', wrote: false, lane: 'odysseus', path: relativePath, record: initial };
      }
      throw new Error('existing Odysseus heartbeat log has no valid initial preflight record');
    }
    if (allocation) {
      if (resumedLegacyAllocation) {
        return { disposition: 'legacy-migrated-no-record', wrote: false, lane: 'odysseus', path: relativePath, record: null };
      }
      throw new Error('Odysseus was allocated before the initial preflight heartbeat record');
    }
    const record = appendHeartbeatRecord(manifest, 'odysseus', 'preflight', 0, 1, 'running', timestamp, { initialOnly: true });
    return { disposition: 'created', wrote: true, lane: 'odysseus', path: record.path, record };
  });
}

function appendHeartbeatRecord(manifest, lane, phase, completed, total, status, timestamp, { initialOnly = false, executionBinding = null } = {}) {
  if (!manifest.selectedAgents.includes(lane)) throw new Error(`heartbeat lane is not selected: ${lane}`);
  if (!PHASES.includes(phase)) throw new Error(`heartbeat phase is invalid: ${phase}`);
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
    const records = parseHeartbeatLog(existing, lane);
    const candidate = { lane, phase, completed, total, status, recordedAt: timestamp, ...(executionBinding ?? {}) };
    if (records.length > 0) validateHeartbeatTransition(records.at(-1), candidate);
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

function parseHeartbeatLog(content, expectedLane) {
  if (content === '') return [];
  if (!content.endsWith('\n')) throw new Error(`heartbeat log for ${expectedLane} has an incomplete record`);
  const records = content.trimEnd().split('\n').map((line, index) => {
    const match = line.match(/^([^\t]+)\t([a-z][a-z0-9-]*)\t(preflight|discovery|hunting|automation|verification|reporting|complete)\t(\d+)\/(\d+)\t(started|running|blocked|degraded|complete|failed)(?:\t([a-f0-9]{24})\t([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\t([1-9][0-9]*))?$/);
    if (!match || match[2] !== expectedLane || !validDate(match[1])) throw new Error(`heartbeat log for ${expectedLane} has an invalid record at line ${index + 1}`);
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
  for (let index = 1; index < records.length; index += 1) validateHeartbeatTransition(records[index - 1], records[index]);
  return records;
}

function validateHeartbeatTransition(previous, candidate) {
  if (Date.parse(candidate.recordedAt) < Date.parse(previous.recordedAt)) throw new Error('heartbeat timestamp regressed');
  const previousPhase = PHASES.indexOf(previous.phase);
  const candidatePhase = PHASES.indexOf(candidate.phase);
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

export function arriveBarrier(manifest, lane, token, phase) {
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    if (state.currentPhase !== phase) throw new Error(`current phase is ${state.currentPhase}, not ${phase}`);
    const participants = barrierParticipants(manifest, state, phase);
    if (!participants.includes(lane)) throw new Error(`${lane} is not a participant in ${phase}`);
    const arrivals = new Set(state.barriers[phase] ?? []);
    arrivals.add(lane);
    state.barriers[phase] = [...arrivals].sort();
    return { result: barrierStatus(manifest, state, phase), changed: true };
  });
}

export function advanceBarrier(manifest, lane, token) {
  if (lane !== 'odysseus') throw new Error('only odysseus may advance phase barriers');
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const phase = state.currentPhase;
    const status = barrierStatus(manifest, state, phase);
    if (!status.complete) throw new Error(`phase ${phase} is waiting for: ${status.missing.join(', ')}`);
    const index = PHASES.indexOf(phase);
    if (index < 0 || index === PHASES.length - 1) throw new Error(`phase ${phase} cannot advance`);
    if (!state.completedPhases.includes(phase)) state.completedPhases.push(phase);
    state.currentPhase = PHASES[index + 1];
    return { result: { completed: phase, currentPhase: state.currentPhase }, changed: true };
  });
}

export function getBarrierStatus(manifest, phase) {
  return barrierStatus(manifest, readState(manifest), phase ?? readState(manifest).currentPhase);
}

export function cleanupWorker(manifest, lane, token, outcome) {
  if (!['success', 'failure', 'interrupted'].includes(outcome)) throw new Error('cleanup outcome must be success, failure, or interrupted');
  return mutateState(manifest, (state) => {
    const allocation = state.allocations[lane];
    if (!allocation) throw new Error(`no allocation exists for ${lane}`);
    if (!nonEmpty(token) || allocation.leaseTokenSha256 !== sha256(token)) throw new Error(`invalid lease for ${lane}`);
    if (allocation.status === 'released') {
      if (allocation.outcome !== outcome) throw new Error(`${lane} was already cleaned with outcome ${allocation.outcome}`);
      return { result: { lane, outcome, released: true, idempotent: true }, changed: false };
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
      const requiredPhases = PHASES.filter((phase) => barrierParticipants(manifest, state, phase).includes(lane));
      const missingArrivals = requiredPhases.filter((phase) => !(state.barriers[phase] ?? []).includes(lane));
      const lastPhaseIndex = Math.max(-1, ...requiredPhases.map((phase) => PHASES.indexOf(phase)));
      if (missingArrivals.length > 0 || PHASES.indexOf(state.currentPhase) < lastPhaseIndex) {
        throw new Error(`${lane} success cleanup requires all declared barrier arrivals; missing: ${missingArrivals.join(', ') || 'phase not reached'}`);
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
    return { result: { lane, outcome, released: true }, changed: true };
  });
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
    const allowedRoots = [
      ...manifest.writePolicy.allowedArtifactRoots,
      ...manifest.writePolicy.generatedTestRoots,
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
  const migrated = source.schemaVersion === 1 ? migrateEngagementStateV1(manifest, source, sha256(raw)) : null;
  const state = migrated ?? source;
  if (state.schemaVersion !== ENGAGEMENT_STATE_VERSION) throw new Error(`unsupported engagement state schemaVersion: ${state.schemaVersion}`);
  const errors = validateCurrentState(manifest, state);
  if (errors.length > 0) throw new Error(`engagement state integrity failed: ${errors.join('; ')}`);
  if (migrated && persistMigration) atomicWriteJson(path, state);
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

function migrateEngagementStateV1(manifest, source, sourceDigest) {
  if (!plainObject(source) || source.engagementId !== manifest.engagementId) throw new Error('engagement state does not match the manifest');
  const state = structuredClone(source);
  const allocationIdsSynthesized = [];
  const activeAllocationIdsAtMigration = {};
  const checkpointBindingsSynthesized = [];
  const runtimeV1BindingsPreserved = [];
  if (!plainObject(state.allocations) || !plainObject(state.checkpoints)) throw new Error('legacy engagement state allocations/checkpoints are malformed');

  for (const [lane, allocation] of Object.entries(state.allocations)) {
    if (!plainObject(allocation) || !/^[a-f0-9]{64}$/.test(allocation.leaseTokenSha256 ?? '')) {
      throw new Error(`legacy allocation ${lane} has no valid lease digest`);
    }
    if (!/^[a-f0-9]{24}$/.test(allocation.allocationId ?? '')) {
      allocation.allocationId = deterministicLegacyAllocationId(state.engagementId, lane, allocation);
      allocationIdsSynthesized.push(lane);
    }
    if (allocation.status === 'active') activeAllocationIdsAtMigration[lane] = allocation.allocationId;
  }

  for (const [lane, checkpoint] of Object.entries(state.checkpoints)) {
    const allocation = state.allocations[lane];
    if (!plainObject(checkpoint) || !allocation) throw new Error(`legacy checkpoint ${lane} cannot be bound to an allocation`);
    const completeRuntimeBinding = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checkpoint.dispatchId ?? '')
      && Number.isInteger(checkpoint.attempt) && checkpoint.attempt >= 1
      && checkpoint.allocationId === allocation.allocationId;
    if (completeRuntimeBinding) {
      checkpoint.bindingOrigin = 'runtime-v1';
      runtimeV1BindingsPreserved.push(lane);
      continue;
    }
    checkpoint.dispatchId = deterministicLegacyDispatchId(state.engagementId, lane, checkpoint);
    checkpoint.attempt = 1;
    checkpoint.allocationId = allocation.allocationId;
    checkpoint.bindingOrigin = 'migrated-v1';
    checkpointBindingsSynthesized.push(lane);
  }

  state.dispatchableAgents = null;
  state.schemaVersion = ENGAGEMENT_STATE_VERSION;
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision + 1 : 1;
  state.migrations = [{
    fromVersion: 1,
    toVersion: ENGAGEMENT_STATE_VERSION,
    migrationId: `state-v1-${sourceDigest.slice(0, 24)}`,
    sourceSha256: sourceDigest,
    strategy: 'deterministic-lease-bound-execution-bindings',
    allocationIdsSynthesized: allocationIdsSynthesized.sort(),
    activeAllocationIdsAtMigration: Object.fromEntries(Object.entries(activeAllocationIdsAtMigration).sort(([left], [right]) => left.localeCompare(right))),
    checkpointBindingsSynthesized: checkpointBindingsSynthesized.sort(),
    runtimeV1BindingsPreserved: runtimeV1BindingsPreserved.sort(),
  }];
  return state;
}

function deterministicLegacyAllocationId(engagementId, lane, allocation) {
  return sha256(JSON.stringify([
    'argus/engagement-state@2',
    'migrated-allocation',
    engagementId,
    lane,
    allocation.leaseTokenSha256,
    allocation.allocatedAt ?? null,
  ])).slice(0, 24);
}

function deterministicLegacyDispatchId(engagementId, lane, checkpoint) {
  return `legacy-v1:${sha256(JSON.stringify([
    'argus/engagement-state@2',
    'migrated-checkpoint',
    engagementId,
    lane,
    checkpoint.phase ?? null,
    checkpoint.sequence ?? null,
    checkpoint.path ?? null,
    checkpoint.sha256 ?? null,
    checkpoint.recordedAt ?? null,
  ])).slice(0, 24)}`;
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
  if (decision.runtimeAttestation?.parentSessionId !== document.parentSessionId) {
    throw new Error('Codex dispatch authorization parentSessionId differs from the selected route attestation');
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

function validateDispatchAuthorizationUse(manifest, state, lane, allocation, dispatchBinding, { operation, allowFirstLegacy = false }) {
  if (!dispatchBinding) throw new Error(`${lane} Codex ${operation} requires a fresh JIT dispatch authorization`);
  const history = dispatchAuthorizationHistory(allocation);
  const legacyId = state.migrations?.find((item) => item.fromVersion === 1 && item.toVersion === ENGAGEMENT_STATE_VERSION)
    ?.activeAllocationIdsAtMigration?.[lane];
  if (allocation && !allocation.dispatchAuthorizationSha256 && !(allowFirstLegacy && allocation.allocationId === legacyId)) {
    throw new Error(`${lane} Codex ${operation} cannot introduce a first dispatch authorization outside an exact v1 migration`);
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

function validateRetryLineage(manifest, state, allocation, decision) {
  if (decision.signal === 'normal') throw new Error(`${allocation.lane} retry cannot use a normal baseline decision`);
  const escalation = decision.escalationBinding;
  const availability = decision.availabilityBinding;
  if (Boolean(escalation) === Boolean(availability)) {
    throw new Error(`${allocation.lane} retry requires exactly one immutable escalation or availability lineage`);
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
    const expectedAllocationSha256 = sha256(JSON.stringify(allocation));
    if (availability.previousDecisionId !== allocation.modelDecisionId ||
        availability.previousDecisionIntegritySha256 !== allocation.modelDecisionIntegritySha256 ||
        availability.allocationId !== allocation.allocationId || availability.allocationSha256 !== expectedAllocationSha256) {
      throw new Error(`${allocation.lane} retry availability lineage is stale or belongs to another allocation`);
    }
  }
  if (decision.runtime === 'codex' && !decision.runtimeAttestation) {
    throw new Error(`${allocation.lane} Codex retry requires an authenticated route attestation`);
  }
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

function requireLiveLeaseFile(manifest, state, lane, token, { allowMigratedToken = false, upgradeMigratedToken = false } = {}) {
  const allocation = state.allocations[lane];
  if (!allocation || allocation.status !== 'active' || !nonEmpty(token) || allocation.leaseTokenSha256 !== sha256(token)) {
    throw new Error(`invalid or inactive lease for ${lane}`);
  }
  const leasePath = engagementPath(manifest, join(manifest.writePolicy.workerRoot, lane, '.lease'));
  if (!existsSync(leasePath)) throw new Error(`active lease file is missing for ${lane}`);
  const content = readManagedFile(leasePath, `${lane} lease`).toString('utf8').trim();
  if (content === leaseMarker(allocation)) return;
  const migratedId = state.migrations.find((item) => item.fromVersion === 1 && item.toVersion === ENGAGEMENT_STATE_VERSION)
    ?.activeAllocationIdsAtMigration?.[lane];
  if ((allowMigratedToken || upgradeMigratedToken) && allocation.allocationId === migratedId && content === token) {
    if (upgradeMigratedToken) atomicWrite(leasePath, `${leaseMarker(allocation)}\n`);
    return;
  }
  throw new Error(`active lease marker does not match the allocation for ${lane}`);
}

function requireSelected(manifest, lane) {
  if (!manifest.selectedAgents.includes(lane)) throw new Error(`${lane} is not selected for this engagement`);
}

function requireDispatchableState(state, lane) {
  if (Array.isArray(state.dispatchableAgents) && !state.dispatchableAgents.includes(lane)) {
    throw new Error(`${lane} is outside the immutable dispatchable agent projection`);
  }
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
  const participants = phaseDefinition(manifest, phase).participants;
  if (!Array.isArray(state.dispatchableAgents)) return participants;
  const dispatchable = new Set(state.dispatchableAgents);
  return participants.filter((lane) => dispatchable.has(lane));
}

function phaseDefinition(manifest, phase) {
  const definition = manifest.phasePlan.find((item) => item.id === phase);
  if (!definition) throw new Error(`unknown phase: ${phase}`);
  return definition;
}

function phaseParticipants(phase, agents) {
  if (phase === 'preflight' || phase === 'complete') return agents.filter((agent) => agent === 'odysseus');
  if (phase === 'discovery') return agents.filter((agent) => agent === 'kalchas');
  if (phase === 'hunting') return agents.filter((agent) => HUNTERS.has(agent));
  if (phase === 'automation') return agents.filter((agent) => AUTOMATION.has(agent));
  if (phase === 'verification') return agents.filter((agent) => VERIFIERS.has(agent));
  if (phase === 'reporting') return agents.filter((agent) => REPORTERS.has(agent));
  return [];
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
    const legacyId = state.migrations?.find((item) => item.fromVersion === 1 && item.toVersion === ENGAGEMENT_STATE_VERSION)
      ?.activeAllocationIdsAtMigration?.[lane];
    const presentBindingFields = EXECUTION_BINDING_FIELDS.filter((field) => Object.hasOwn(allocation, field));
    if (presentBindingFields.length > 0 && (presentBindingFields.length !== EXECUTION_BINDING_FIELDS.length || !hasExecutionBinding(allocation))) {
      errors.push(`${lane}: allocation model decision binding is partial or invalid`);
    } else if (presentBindingFields.length === 0 && allocation.allocationId !== legacyId) {
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
    if (allocation.runtime === 'codex' && allocation.allocationId !== legacyId) {
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
  if (!PHASES.includes(state.currentPhase)) errors.push('currentPhase is invalid');
  if (!Array.isArray(state.completedPhases) || state.completedPhases.some((phase) => !PHASES.includes(phase))) errors.push('completedPhases are invalid');
  if (!(state.dispatchableAgents === null || (stringList(state.dispatchableAgents, true) &&
      state.dispatchableAgents.includes('odysseus') && state.dispatchableAgents.every((lane) => manifest.selectedAgents.includes(lane))))) {
    errors.push('dispatchableAgents must be null or an immutable selected projection containing odysseus');
  }
  if (!plainObject(state.checkpoints)) errors.push('checkpoints must be an object');
  else for (const [lane, checkpoint] of Object.entries(state.checkpoints)) {
    const allocation = state.allocations?.[lane];
    if (!manifest.selectedAgents.includes(lane) || !plainObject(checkpoint) || !allocation) {
      errors.push(`${lane}: checkpoint is not bound to a selected allocation`);
      continue;
    }
    if (!PHASES.includes(checkpoint.phase)
      || !Number.isInteger(checkpoint.sequence) || checkpoint.sequence < 0
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checkpoint.dispatchId ?? '')
      || !Number.isInteger(checkpoint.attempt) || checkpoint.attempt < 1
      || checkpoint.allocationId !== allocation.allocationId
      || !['runtime', 'runtime-v1', 'migrated-v1'].includes(checkpoint.bindingOrigin)
      || !safeRelative(checkpoint.path)
      || !/^[a-f0-9]{64}$/.test(checkpoint.sha256 ?? '')
      || !validDate(checkpoint.recordedAt)) {
      errors.push(`${lane}: checkpoint execution binding is invalid`);
    }
  }
  if (!Array.isArray(state.migrations)) errors.push('migrations must be an array');
  else for (const migration of state.migrations) {
    if (!plainObject(migration)
      || migration.fromVersion !== 1
      || migration.toVersion !== ENGAGEMENT_STATE_VERSION
      || !/^state-v1-[a-f0-9]{24}$/.test(migration.migrationId ?? '')
      || !/^[a-f0-9]{64}$/.test(migration.sourceSha256 ?? '')
      || migration.strategy !== 'deterministic-lease-bound-execution-bindings'
      || !stringList(migration.allocationIdsSynthesized, false)
      || !plainObject(migration.activeAllocationIdsAtMigration)
      || !Object.entries(migration.activeAllocationIdsAtMigration).every(([lane, allocationId]) => validSlug(lane) && /^[a-f0-9]{24}$/.test(allocationId))
      || !stringList(migration.checkpointBindingsSynthesized, false)
      || !stringList(migration.runtimeV1BindingsPreserved, false)) {
      errors.push('migration audit record is invalid');
    }
  }
  return errors;
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
  return /(?:^|[;&|\s])(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|patch)(?:\s|$)|(?:^|\s)(?:sed\s+[^\n]*-[A-Za-z]*i|perl\s+[^\n]*-[A-Za-z]*[pi][A-Za-z]*)|(?:^|[^<])>{1,2}\s*[^&]|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|chmod(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|rmtree|remove|write_text|write_bytes|open|allocateWorker|startWorkerAttempt|bindLegacyAllocationDecision)\s*\(|\.write_(?:text|bytes)\s*\(/i.test(command);
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
    if (['validate', 'allocate', 'start-attempt', 'status', 'claim', 'release', 'fragment', 'merge', 'id', 'checkpoint', 'heartbeat', 'barrier', 'cleanup'].includes(operation)) {
      const requestedManifest = optionValue(tokens, '--manifest');
      const activeManifest = manifestPath ?? join(manifest.artifactRoot, 'ai_agents_internal', 'engagement.json');
      if (requestedManifest && resolvePhysical(requestedManifest, cwd) !== resolvePhysical(activeManifest, cwd)) {
        return deny('engagement operation targets a manifest other than the active engagement');
      }
      return allow('packaged engagement controller owns the bounded mutation');
    }
    return deny('unknown engagement controller operation');
  }
  if (primary === 'authorization') {
    if (operation === 'check') return allow('packaged authorization audit owns the bounded mutation');
    return deny('authorization init cannot run inside an active engagement');
  }
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
    if (operation === 'telemetry' && !optionValue(tokens, '--decision')) return deny('model telemetry requires an immutable decision file');
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
  if (primary === 'copy-browser-driver') {
    const destination = tokens[index + 2];
    return destination ? { paths: [
      join(destination, 'scripts', 'hunt-driver.mjs'),
      join(destination, 'scripts', 'driver.config.example.json'),
      join(destination, 'scripts', 'driver-config.schema.json'),
    ] } : deny('copy-browser-driver destination is missing');
  }
  return deny('unknown packaged command operation');
}

function referencesPackagedCommand(command) {
  const shellResolved = command.replace(/\\([\s\S])/g, '$1').replace(/["']/g, '');
  return /argus-assets/i.test(shellResolved);
}

function optionValue(tokens, name) {
  const index = tokens.indexOf(name);
  return index >= 0 ? tokens[index + 1] : undefined;
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
