import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PHASES = ['preflight', 'discovery', 'hunting', 'automation', 'verification', 'reporting', 'complete'];
const HUNTERS = new Set(['antigone', 'ariadne', 'atalanta', 'charon', 'hermes', 'lynceus', 'orion', 'perseus', 'proteus', 'tiresias', 'tyche']);
const AUTOMATION = new Set(['aegis', 'asklepios', 'atlas', 'daidalos', 'mnemosyne', 'nike', 'penelope', 'pistis', 'talos', 'theseus']);
const VERIFIERS = new Set(['aristarchus', 'minos']);
const REPORTERS = new Set(['kleio', 'metis', 'minos']);

export function createDefaultEngagement({ template, target, targetRoot, artifactRoot, mode, engagementId, selectedAgents }) {
  const manifest = structuredClone(template);
  const agents = [...new Set(selectedAgents)].sort();
  manifest.$schema = 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/engagement-manifest.schema.json';
  manifest.engagementId = engagementId;
  manifest.mode = mode;
  manifest.target = { identifier: target, root: targetRoot };
  manifest.artifactRoot = artifactRoot;
  manifest.selectedAgents = agents;
  manifest.phasePlan = PHASES.map((id) => ({ id, participants: phaseParticipants(id, agents) }));
  return manifest;
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
      if (!safeRelative(item?.path) || !validSlug(item?.owner) || !['markdown', 'text', 'json', 'json-document'].includes(item?.format)) {
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
  if (!safeRelative(manifest.statePath)) errors.push('statePath must be a safe relative path');
  return [...new Set(errors)];
}

export function createInitialEngagementState(manifest) {
  return {
    $schema: 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/engagement-state.schema.json',
    schemaVersion: 1,
    engagementId: manifest.engagementId,
    revision: 0,
    currentPhase: 'discovery',
    completedPhases: ['preflight'],
    allocations: {},
    barriers: Object.fromEntries(PHASES.map((phase) => [phase, []])),
    exclusiveLocks: {},
    nextIds: Object.fromEntries(Object.keys(manifest.idAllocators).map((kind) => [kind, 1])),
    checkpoints: {},
    fragments: {},
    merges: {},
  };
}

export function initializeEngagementState(manifest) {
  const statePath = engagementPath(manifest, manifest.statePath);
  if (existsSync(statePath)) {
    const state = readState(manifest);
    return { state, created: false, path: statePath };
  }
  mkdirSync(dirname(statePath), { recursive: true });
  atomicWriteJson(statePath, createInitialEngagementState(manifest));
  chmodSync(statePath, 0o600);
  return { state: readState(manifest), created: true, path: statePath };
}

export function allocateWorker(manifest, lane) {
  requireSelected(manifest, lane);
  return mutateState(manifest, (state) => {
    const workerRoot = engagementPath(manifest, join(manifest.writePolicy.workerRoot, lane));
    const leasePath = join(workerRoot, '.lease');
    const existing = state.allocations[lane];
    if (existing?.status === 'active' && existsSync(leasePath)) {
      return { result: { ...publicAllocation(existing), token: readFileSync(leasePath, 'utf8').trim(), resumed: true }, changed: false };
    }
    const token = randomBytes(32).toString('hex');
    const index = [...manifest.selectedAgents].sort().indexOf(lane);
    const allocation = {
      lane,
      status: 'active',
      browserProfile: join(workerRoot, 'browser-profile'),
      authDirectory: join(workerRoot, 'auth'),
      temporaryDirectory: join(workerRoot, 'tmp'),
      outputDirectory: join(workerRoot, 'output'),
      accountAlias: `argus-${lane}`,
      dataNamespace: `argus_${lane.replace(/-/g, '_')}`,
      port: manifest.resourcePolicy.portRange.start + index,
      leaseTokenSha256: sha256(token),
      allocatedAt: new Date().toISOString(),
      releasedAt: null,
      outcome: null,
    };
    for (const path of [allocation.browserProfile, allocation.authDirectory, allocation.temporaryDirectory, allocation.outputDirectory]) mkdirSync(path, { recursive: true });
    writeFileSync(leasePath, `${token}\n`, { mode: 0o600 });
    chmodSync(leasePath, 0o600);
    state.allocations[lane] = allocation;
    return { result: { ...publicAllocation(allocation), token, resumed: false }, changed: true };
  });
}

export function getEngagementStatus(manifest) {
  return readState(manifest);
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
  const digest = sha256(content);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const key = sha256(canonical.path).slice(0, 16);
    const dir = engagementPath(manifest, join(manifest.writePolicy.fragmentRoot, key));
    const path = join(dir, `${fragmentId}--${lane}.${canonical.format.startsWith('json') ? 'json' : canonical.format === 'markdown' ? 'md' : 'txt'}`);
    mkdirSync(dir, { recursive: true });
    if (existsSync(path)) {
      if (sha256(readFileSync(path)) !== digest) throw new Error(`immutable fragment already exists with different content: ${fragmentId}`);
    } else {
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
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
      const content = readFileSync(path);
      if (sha256(content) !== record.sha256) throw new Error(`fragment digest drift: ${record.path}`);
      return content.toString('utf8').trimEnd();
    });
    let output;
    if (canonical.format === 'json-document') {
      if (contents.length !== 1) throw new Error(`${canonical.path} requires exactly one complete JSON document fragment`);
      output = `${JSON.stringify(JSON.parse(contents[0]), null, 2)}\n`;
    } else if (canonical.format === 'json') output = `${JSON.stringify(contents.map((content) => JSON.parse(content)), null, 2)}\n`;
    else output = `${contents.join('\n\n')}\n`;
    const destination = engagementPath(manifest, canonical.path);
    atomicWrite(destination, output);
    const result = { owner, fragments: records.length, sha256: sha256(output), mergedAt: new Date().toISOString() };
    state.merges[canonical.path] = result;
    return { result: { ...result, path: destination }, changed: true };
  });
}

export function allocateId(manifest, lane, token, kind) {
  const allocator = manifest.idAllocators[kind];
  if (!allocator) throw new Error(`unknown ID allocator: ${kind}`);
  if (allocator.owner !== lane) throw new Error(`${kind} IDs are owned by ${allocator.owner}, not ${lane}`);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const value = state.nextIds[kind] ?? 1;
    state.nextIds[kind] = value + 1;
    return { result: `${allocator.prefix}-${String(value).padStart(allocator.width, '0')}`, changed: true };
  });
}

export function writeCheckpoint(manifest, lane, token, phase, sequence, payload) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error('checkpoint sequence must be a non-negative integer');
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const digest = sha256(serialized);
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    const current = state.checkpoints[lane];
    if (current && sequence < current.sequence) throw new Error(`checkpoint sequence regressed from ${current.sequence} to ${sequence}`);
    if (current && sequence === current.sequence) {
      if (current.sha256 !== digest) throw new Error('checkpoint sequence already exists with different content');
      return { result: current, changed: false };
    }
    const path = engagementPath(manifest, join(manifest.writePolicy.checkpointRoot, lane, `${String(sequence).padStart(8, '0')}.json`));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized, { flag: 'wx', mode: 0o600 });
    const record = { phase, sequence, path: relative(manifest.artifactRoot, path).split(sep).join('/'), sha256: digest, recordedAt: new Date().toISOString() };
    state.checkpoints[lane] = record;
    return { result: record, changed: true };
  });
}

export function arriveBarrier(manifest, lane, token, phase) {
  return mutateState(manifest, (state) => {
    requireLeaseState(manifest, state, lane, token);
    if (state.currentPhase !== phase) throw new Error(`current phase is ${state.currentPhase}, not ${phase}`);
    const participants = phaseDefinition(manifest, phase).participants;
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
  if (!['success', 'failure'].includes(outcome)) throw new Error('cleanup outcome must be success or failure');
  return mutateState(manifest, (state) => {
    const allocation = state.allocations[lane];
    if (!allocation) throw new Error(`no allocation exists for ${lane}`);
    if (!nonEmpty(token) || allocation.leaseTokenSha256 !== sha256(token)) throw new Error(`invalid lease for ${lane}`);
    if (allocation.status === 'released') {
      if (allocation.outcome !== outcome) throw new Error(`${lane} was already cleaned with outcome ${allocation.outcome}`);
      return { result: { lane, outcome, released: true, idempotent: true }, changed: false };
    }
    const workerRoot = engagementPath(manifest, join(manifest.writePolicy.workerRoot, lane));
    const targets = {
      'browser-profile': allocation.browserProfile,
      auth: allocation.authDirectory,
      tmp: allocation.temporaryDirectory,
      locks: join(workerRoot, 'locks'),
    };
    for (const key of manifest.cleanup.removeOnRelease) rmSync(targets[key], { recursive: true, force: true });
    rmSync(join(workerRoot, '.lease'), { force: true });
    for (const [resource, held] of Object.entries(state.exclusiveLocks)) if (held.lane === lane) delete state.exclusiveLocks[resource];
    allocation.status = 'released';
    allocation.releasedAt = new Date().toISOString();
    allocation.outcome = outcome;
    return { result: { lane, outcome, released: true }, changed: true };
  });
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

function readState(manifest) {
  const path = engagementPath(manifest, manifest.statePath);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schemaVersion !== 1 || state.engagementId !== manifest.engagementId) throw new Error('engagement state does not match the manifest');
  return state;
}

function mutateState(manifest, mutate) {
  return withStateLock(manifest, () => {
    const state = readState(manifest);
    const { result, changed } = mutate(state);
    if (changed) {
      state.revision += 1;
      atomicWriteJson(engagementPath(manifest, manifest.statePath), state);
    }
    return result;
  });
}

function withStateLock(manifest, operation) {
  const statePath = engagementPath(manifest, manifest.statePath);
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (!acquired) throw new Error('timed out waiting for engagement state lock');
  try { return operation(); }
  finally { rmSync(lockPath, { recursive: true, force: true }); }
}

function requireLeaseState(manifest, state, lane, token) {
  requireSelected(manifest, lane);
  if (!nonEmpty(token)) throw new Error(`lease token is required for ${lane}`);
  const allocation = state.allocations[lane];
  if (!allocation || allocation.status !== 'active' || allocation.leaseTokenSha256 !== sha256(token)) throw new Error(`invalid or inactive lease for ${lane}`);
}

function requireSelected(manifest, lane) {
  if (!manifest.selectedAgents.includes(lane)) throw new Error(`${lane} is not selected for this engagement`);
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
  const participants = phaseDefinition(manifest, phase).participants;
  const arrived = state.barriers[phase] ?? [];
  const missing = participants.filter((lane) => !arrived.includes(lane));
  return { phase, participants, arrived: [...arrived].sort(), missing, complete: missing.length === 0 };
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

function collectDirectPaths(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /^(?:file_path|path|notebook_path|target_path)$/i.test(key)) output.push(child);
    else if (child && typeof child === 'object') collectDirectPaths(child, output);
  }
  return output;
}

function shellMayWrite(command) {
  return /(?:^|[;&|\s])(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|patch)(?:\s|$)|(?:^|\s)(?:sed\s+[^\n]*-[A-Za-z]*i|perl\s+[^\n]*-[A-Za-z]*[pi][A-Za-z]*)|(?:^|[^<])>{1,2}\s*[^&]|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|chmod(?:Sync)?|write_text|write_bytes|open)\s*\(|\.write_(?:text|bytes)\s*\(/i.test(command);
}

function classifyPackagedCommand(command, manifest, manifestPath, cwd, commandSha256) {
  const value = command.trim();
  if (/[;|>\n`]|&&|\$\(/.test(value)) return null;
  const tokens = shellTokens(value);
  const index = tokens.findIndex((token) => token === 'argus-assets' || token.endsWith('/argus-assets'));
  if (index < 0) return null;
  const primary = tokens[index + 1];
  const operation = tokens[index + 2];
  const allow = (reason) => ({ decision: guardDecision('allow', 'GUARD-ALLOW', reason, [], commandSha256) });
  const deny = (reason) => ({ decision: guardDecision('deny', 'GUARD-SHELL-AMBIGUOUS', reason, [], commandSha256) });
  if (['help', '--help', '-h', 'list', 'path', 'inventory', 'verify'].includes(primary)) return allow('packaged read-only command');
  if (primary === 'engagement') {
    if (operation === 'init') return deny('engagement init cannot run inside an active engagement');
    if (['validate', 'allocate', 'status', 'claim', 'release', 'fragment', 'merge', 'id', 'checkpoint', 'barrier', 'cleanup'].includes(operation)) {
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

function optionValue(tokens, name) {
  const index = tokens.indexOf(name);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function collectShellWritePaths(command) {
  const paths = [];
  for (const match of command.matchAll(/(?:^|\s)(?:[0-9]*>>?|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) paths.push(match[1] ?? match[2] ?? match[3]);
  for (const match of command.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|renameSync|rename|chmodSync|chmod|open)\s*\(\s*[rbuf]*["']([^"']+)["']/gi)) paths.push(match[1]);
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
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
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

function validDate(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}
