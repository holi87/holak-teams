#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allocateWorker,
  advanceBarrier,
  appendHeartbeat,
  arriveBarrier,
  bindLegacyAllocationDecision,
  cleanupWorker,
  createDefaultEngagement,
  ensurePreflightHeartbeat,
  evaluateWriteGuard,
  getEngagementStatus,
  initializeEngagementState,
  writeCheckpoint,
} from '../argus/runtime/engagement.mjs';

const ROOT = new URL('..', import.meta.url);
const template = JSON.parse(readFileSync(new URL('argus/policies/engagement.template.json', ROOT), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'argus-engagement-state-'));

try {
  testHardLinkWriteGuard();
  testHeartbeatGuardRequiresController();
  testDecisionBoundAllocationAuthorization();
  testAuthenticatedControllerRecovery();
  testControllerSuccessRequiresFinalBarrier();
  testWorkerSuccessRequiresBarrier();
  testIdempotentPreflightHeartbeat();
  testAuthenticatedMonotonicHeartbeats();
  testLegacyStateMigrationAndResume();
  console.log('PASS  Argus engagement state: decision-bound leases, v1 migration, authenticated heartbeat, and link defenses');
} finally {
  rmSync(work, { recursive: true, force: true });
}

function testHardLinkWriteGuard() {
  const fixture = createFixture('guard-hardlink-alias');
  const source = join(fixture.root, 'app/source.ts');
  const alias = join(fixture.root, 'reports/source-alias.ts');
  mkdirSync(join(fixture.root, 'app'), { recursive: true });
  mkdirSync(join(fixture.root, 'reports'), { recursive: true });
  writeFileSync(source, 'application source\n');
  linkSync(source, alias);
  for (const payload of [
    { tool_name: 'Write', tool_input: { file_path: 'reports/source-alias.ts', content: 'compromised' } },
    { tool_name: 'Bash', tool_input: { command: 'printf compromised > reports/source-alias.ts' } },
  ]) {
    const decision = evaluateWriteGuard({ manifest: fixture.manifest, payload, cwd: fixture.root });
    assert(decision.decision === 'deny' && decision.ruleId === 'GUARD-HARDLINK-ALIAS', `${payload.tool_name} guard accepted an allowed-path hard-link alias`);
  }
  for (const command of [
    'ln app/source.ts reports/future-ln-alias.ts && printf compromised > reports/future-ln-alias.ts',
    '/bin/ln app/source.ts reports/future-path-ln-alias.ts && printf compromised > reports/future-path-ln-alias.ts',
    'link app/source.ts reports/future-link-alias.ts && printf compromised > reports/future-link-alias.ts',
    `node -e "const fs=require('fs'); fs.linkSync('app/source.ts','reports/future-node-alias.ts'); fs.writeFileSync('reports/future-node-alias.ts','compromised')"`,
    `node -e "const fs=require('fs'); fs.link('app/source.ts','reports/future-async-alias.ts',()=>fs.writeFileSync('reports/future-async-alias.ts','compromised'))"`,
  ]) {
    const decision = evaluateWriteGuard({ manifest: fixture.manifest, payload: { tool_name: 'Bash', tool_input: { command } }, cwd: fixture.root });
    assert(decision.decision === 'deny' && decision.ruleId === 'GUARD-LINK-ALIAS', `guard accepted link creation before an allowed-path write: ${command}`);
  }
  assert(readFileSync(source, 'utf8') === 'application source\n', 'guard evaluation modified the hard-linked source sentinel');
}

function testHeartbeatGuardRequiresController() {
  const fixture = createFixture('guard-heartbeat-controller');
  const manifestPath = join(fixture.root, 'ai_agents_internal/engagement.json');
  const directPayloads = [
    { tool_name: 'Write', tool_input: { file_path: 'ai_agents_internal/heartbeat/odysseus.log', content: 'forged\n' } },
    { tool_name: 'Bash', tool_input: { command: 'printf forged > ai_agents_internal/heartbeat/odysseus.log' } },
  ];
  for (const manifest of [
    fixture.manifest,
    {
      ...fixture.manifest,
      writePolicy: {
        ...fixture.manifest.writePolicy,
        allowedArtifactRoots: ['ai_agents_internal/heartbeat', ...fixture.manifest.writePolicy.allowedArtifactRoots],
      },
    },
  ]) {
    for (const payload of directPayloads) {
      const decision = evaluateWriteGuard({ manifest, manifestPath, payload, cwd: fixture.root });
      assert(decision.decision === 'deny' && decision.ruleId === 'GUARD-HEARTBEAT-CONTROLLER', `${payload.tool_name} bypassed the heartbeat controller`);
    }
  }
  const packaged = evaluateWriteGuard({
    manifest: fixture.manifest,
    manifestPath,
    cwd: fixture.root,
    payload: {
      tool_name: 'Bash',
      tool_input: {
        command: `argus-assets engagement heartbeat --manifest ${manifestPath} --lane odysseus --token lease --phase discovery --completed 0 --total 1 --status running`,
      },
    },
  });
  assert(packaged.decision === 'allow', 'packaged engagement heartbeat was denied by the controller-only guard');
}

function testDecisionBoundAllocationAuthorization() {
  const fixture = createFixture('decision-bound-allocation', ['atlas', 'hermes', 'odysseus']);
  const controllerBinding = executionBinding('decision-bound-controller');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { executionBinding: executionBinding('worker-before-controller') }),
    'worker bootstrap without Odysseus',
  );
  expectThrow(() => allocateWorker(fixture.manifest, 'odysseus'), 'Odysseus bootstrap without a model decision');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'odysseus', { executionBinding: { ...controllerBinding, unexpected: true } }),
    'Odysseus bootstrap with a non-exact model decision shape',
  );
  const controller = allocateWorker(fixture.manifest, 'odysseus', { executionBinding: controllerBinding });
  assertLeaseMarker(fixture, controller, 'Odysseus');
  expectThrow(() => allocateWorker(fixture.manifest, 'odysseus'), 'active controller token redisclosure without a resume token');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'odysseus', { resumeToken: '0'.repeat(64) }),
    'active controller token redisclosure with a wrong resume token',
  );
  const controllerResume = allocateWorker(fixture.manifest, 'odysseus', { resumeToken: controller.token });
  assert(controllerResume.resumed === true && controllerResume.token === controller.token, 'controller did not resume with the exact supplied token');

  const workerBinding = executionBinding('decision-bound-hermes');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { executionBinding: workerBinding }),
    'worker allocation without a controller token',
  );
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { controllerToken: controller.token }),
    'worker allocation without a model decision',
  );
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { controllerToken: controller.token, executionBinding: { ...workerBinding, extra: 'forbidden' } }),
    'worker allocation with a non-exact model decision shape',
  );
  const worker = allocateWorker(fixture.manifest, 'hermes', { controllerToken: controller.token, executionBinding: workerBinding });
  assertLeaseMarker(fixture, worker, 'Hermes');
  expectThrow(
    () => writeCheckpoint(fixture.manifest, 'hermes', worker.token, 'hunting', 1, workerBinding.dispatchId, 2, { premature: true }),
    'checkpoint for a future attempt',
  );
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { resumeToken: controller.token, controllerToken: controller.token }),
    'worker resume with a cross-lane token',
  );
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { resumeToken: worker.token, controllerToken: worker.token }),
    'worker resume with a non-controller token',
  );
  const workerResume = allocateWorker(fixture.manifest, 'hermes', { resumeToken: worker.token, controllerToken: controller.token });
  assert(workerResume.resumed === true && workerResume.token === worker.token, 'worker did not resume with its own token and the controller token');

  writeCheckpoint(fixture.manifest, 'hermes', worker.token, 'hunting', 1, workerBinding.dispatchId, 1, { generation: 1 });
  expectThrow(
    () => cleanupWorker(fixture.manifest, 'odysseus', controller.token, 'interrupted'),
    'controller cleanup while a worker remains active',
  );
  const checkpointSource = join(fixture.root, 'ai_agents_internal/checkpoints/hermes');
  const checkpointArchive = join(fixture.root, 'ai_agents_internal/checkpoints/.released/hermes', worker.allocationId);
  mkdirSync(join(fixture.root, 'ai_agents_internal/checkpoints/.released/hermes'), { recursive: true });
  mkdirSync(checkpointArchive, { recursive: true });
  expectThrow(() => cleanupWorker(fixture.manifest, 'hermes', worker.token, 'interrupted'), 'cleanup with colliding checkpoint source and archive');
  assert(existsSync(leasePath(fixture, 'hermes')) && existsSync(worker.temporaryDirectory) && existsSync(checkpointSource),
    'failed checkpoint preflight deleted live lease, resources, or source checkpoint');
  rmSync(checkpointArchive, { recursive: true, force: true });
  renameSync(checkpointSource, checkpointArchive);
  cleanupWorker(fixture.manifest, 'hermes', worker.token, 'interrupted');
  const archivedCheckpoint = join(fixture.root, 'ai_agents_internal/checkpoints/.released/hermes', worker.allocationId, '00000001.json');
  assert(existsSync(archivedCheckpoint), 'released worker checkpoint was not preserved in its allocation archive');
  const replacementBinding = executionBinding('decision-bound-hermes-replacement', { attempt: 2 });
  const replacement = allocateWorker(fixture.manifest, 'hermes', { controllerToken: controller.token, executionBinding: replacementBinding });
  assert(replacement.allocationId !== worker.allocationId && replacement.token !== worker.token, 'worker reallocation reused its prior capability');
  const replacementCheckpoint = writeCheckpoint(fixture.manifest, 'hermes', replacement.token, 'hunting', 1, replacementBinding.dispatchId, 2, { generation: 2 });
  assert(replacementCheckpoint.path.endsWith('/hermes/00000001.json') && existsSync(join(fixture.root, replacementCheckpoint.path)), 'replacement worker could not start a fresh checkpoint sequence');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'hermes', { resumeToken: worker.token, controllerToken: controller.token }),
    'reallocated worker accepted its previous token',
  );
  assert(allocateWorker(fixture.manifest, 'hermes', { resumeToken: replacement.token, controllerToken: controller.token }).resumed, 'replacement worker did not resume');
  cleanupWorker(fixture.manifest, 'hermes', replacement.token, 'interrupted');
  expectThrow(
    () => cleanupWorker(fixture.manifest, 'odysseus', controller.token, 'success'),
    'controller success cleanup before the terminal phase',
  );
  cleanupWorker(fixture.manifest, 'odysseus', controller.token, 'interrupted');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'odysseus', { executionBinding: executionBinding('controller-rebootstrap', { attempt: 2 }) }),
    'released controller was bootstrapped a second time',
  );
}

function testControllerSuccessRequiresFinalBarrier() {
  const fixture = createFixture('controller-final-barrier', ['odysseus']);
  const controller = allocateWorker(fixture.manifest, 'odysseus', { executionBinding: executionBinding('controller-final-barrier') });
  while (getEngagementStatus(fixture.manifest).currentPhase !== 'complete') {
    advanceBarrier(fixture.manifest, 'odysseus', controller.token);
  }
  expectThrow(
    () => cleanupWorker(fixture.manifest, 'odysseus', controller.token, 'success'),
    'controller success before final barrier arrival',
  );
  arriveBarrier(fixture.manifest, 'odysseus', controller.token, 'complete');
  const cleaned = cleanupWorker(fixture.manifest, 'odysseus', controller.token, 'success');
  assert(cleaned.released === true && cleaned.outcome === 'success', 'controller did not release after the completed final barrier');
}

function testWorkerSuccessRequiresBarrier() {
  const fixture = createFixture('worker-success-barrier', ['hermes', 'odysseus']);
  const controller = allocateWorker(fixture.manifest, 'odysseus', { executionBinding: executionBinding('worker-barrier-controller') });
  const worker = allocateWorker(fixture.manifest, 'hermes', {
    controllerToken: controller.token,
    executionBinding: executionBinding('worker-barrier-hermes'),
  });
  expectThrow(() => cleanupWorker(fixture.manifest, 'hermes', worker.token, 'success'), 'worker success before its declared barrier arrival');
  advanceBarrier(fixture.manifest, 'odysseus', controller.token);
  arriveBarrier(fixture.manifest, 'hermes', worker.token, 'hunting');
  const cleaned = cleanupWorker(fixture.manifest, 'hermes', worker.token, 'success');
  assert(cleaned.released === true && cleaned.outcome === 'success', 'worker did not release after its declared barrier arrival');
  cleanupWorker(fixture.manifest, 'odysseus', controller.token, 'interrupted');
}

function testAuthenticatedControllerRecovery() {
  const fixture = createFixture('authenticated-controller-recovery');
  const binding = executionBinding('controller-recovery');
  const controller = allocateWorker(fixture.manifest, 'odysseus', { executionBinding: binding });
  const temporarySentinel = join(controller.temporaryDirectory, 'preserve-until-authenticated');
  writeFileSync(temporarySentinel, 'sentinel\n');
  const checkpoint = writeCheckpoint(fixture.manifest, 'odysseus', controller.token, 'discovery', 1, binding.dispatchId, 1, { completed: ['preflight'] });
  unlinkSync(leasePath(fixture, 'odysseus'));
  expectThrow(
    () => allocateWorker(fixture.manifest, 'odysseus', { resumeToken: controller.token, executionBinding: executionBinding('different-controller-recovery') }),
    'controller recovery with a different model decision',
  );
  assert(existsSync(temporarySentinel), 'failed controller recovery mutated resources before validating its decision');
  const recovered = allocateWorker(fixture.manifest, 'odysseus', { resumeToken: controller.token, executionBinding: binding });
  assert(recovered.recoveredFromCrash === true && recovered.token !== controller.token && recovered.allocationId === controller.allocationId, 'authenticated controller recovery did not rotate only its capability token');
  const recoveredState = getEngagementStatus(fixture.manifest);
  assert(recoveredState.checkpoints.odysseus.path === checkpoint.path && recoveredState.checkpoints.odysseus.allocationId === recovered.allocationId, 'authenticated recovery invalidated its durable checkpoint binding');
  assertLeaseMarker(fixture, recovered, 'recovered Odysseus');
  expectThrow(
    () => allocateWorker(fixture.manifest, 'odysseus', { resumeToken: controller.token }),
    'recovered controller accepted its pre-recovery token',
  );
}

function testIdempotentPreflightHeartbeat() {
  const resumed = createFixture('preflight-resumed-unallocated');
  const created = ensurePreflightHeartbeat(resumed.manifest, '2026-07-12T07:00:00.000Z');
  assert(created.disposition === 'created' && created.wrote === true, 'resumed unallocated preflight did not create its initial heartbeat');
  assert(created.record?.phase === 'preflight' && created.record.completed === 0 && created.record.total === 1 && created.record.status === 'running', 'created preflight record is not exact');
  const heartbeat = join(resumed.root, created.path);
  const initialBytes = readFileSync(heartbeat, 'utf8');
  const existing = ensurePreflightHeartbeat(resumed.manifest, '2026-07-12T07:00:01.000Z');
  assert(existing.disposition === 'existing' && existing.wrote === false, 'preflight replay appended instead of validating');
  assert(existing.record?.recordedAt === '2026-07-12T07:00:00.000Z', 'preflight replay did not return the persisted initial record');
  assert(readFileSync(heartbeat, 'utf8') === initialBytes, 'preflight replay changed the heartbeat log');
  const odysseus = allocateWorker(resumed.manifest, 'odysseus', { executionBinding: executionBinding('preflight-resumed-controller') });
  const allocatedReplay = ensurePreflightHeartbeat(resumed.manifest, '2026-07-12T07:00:02.000Z');
  assert(allocatedReplay.disposition === 'existing' && allocatedReplay.wrote === false, 'allocated preflight replay did not validate the existing record');
  assert(odysseus.resumed === false, 'Odysseus fixture unexpectedly resumed');

  const peer = join(work, 'preflight-hardlink-peer.log');
  linkSync(heartbeat, peer);
  expectThrow(() => ensurePreflightHeartbeat(resumed.manifest), 'hard-linked existing preflight heartbeat');
  unlinkSync(peer);

  const allocatedWithoutRecord = createFixture('preflight-allocated-without-record');
  const freshAllocation = allocateWorker(allocatedWithoutRecord.manifest, 'odysseus', { executionBinding: executionBinding('preflight-before-heartbeat') });
  expectThrow(() => ensurePreflightHeartbeat(allocatedWithoutRecord.manifest), 'non-legacy allocation before initial preflight heartbeat');
  appendHeartbeat(allocatedWithoutRecord.manifest, 'odysseus', freshAllocation.token, 'discovery', 0, 4, 'started', '2026-07-12T07:00:00.000Z');
  expectThrow(() => ensurePreflightHeartbeat(allocatedWithoutRecord.manifest), 'fresh-v2 post-preflight log without an initial record');

  const malformed = createFixture('preflight-malformed-existing');
  const malformedPath = join(malformed.root, 'ai_agents_internal/heartbeat/odysseus.log');
  mkdirSync(join(malformed.root, 'ai_agents_internal/heartbeat'), { recursive: true });
  writeFileSync(malformedPath, '2026-07-12T07:00:00.000Z\todysseus\tdiscovery\t0/1\tstarted\n', { mode: 0o600 });
  expectThrow(() => ensurePreflightHeartbeat(malformed.manifest), 'existing heartbeat without an initial preflight record');

  const migrated = createFixture('preflight-legacy-active');
  const migratedAllocation = allocateWorker(migrated.manifest, 'odysseus', { executionBinding: executionBinding('preflight-legacy-controller') });
  const legacy = JSON.parse(readFileSync(migrated.statePath, 'utf8'));
  legacy.schemaVersion = 1;
  delete legacy.migrations;
  delete legacy.allocations.odysseus.allocationId;
  writeFileSync(leasePath(migrated, 'odysseus'), `${migratedAllocation.token}\n`, { mode: 0o600 });
  writeFileSync(migrated.statePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  const migratedState = getEngagementStatus(migrated.manifest);
  assert(migratedState.migrations[0].activeAllocationIdsAtMigration.odysseus === migratedState.allocations.odysseus.allocationId, 'legacy heartbeat exemption did not bind the original allocation');
  const legacyResult = ensurePreflightHeartbeat(migrated.manifest, '2026-07-12T07:00:03.000Z');
  assert(legacyResult.disposition === 'legacy-migrated-no-record' && legacyResult.wrote === false && legacyResult.record === null, 'legacy migration did not return a truthful non-writing preflight result');
  assert(!existsSync(join(migrated.root, legacyResult.path)), 'legacy no-record result wrote a heartbeat file');
  appendHeartbeat(migrated.manifest, 'odysseus', migratedAllocation.token, 'discovery', 0, 4, 'started', '2026-07-12T07:00:04.000Z');
  const migratedExisting = ensurePreflightHeartbeat(migrated.manifest, '2026-07-12T07:00:05.000Z');
  assert(migratedExisting.disposition === 'legacy-migrated-existing' && migratedExisting.wrote === false, 'legacy discovery heartbeat was not resumable');
  assert(migratedExisting.record?.phase === 'discovery' && migratedExisting.record.completed === 0, 'legacy resume did not return the first authenticated post-preflight record');
  assert(ensurePreflightHeartbeat(migrated.manifest).disposition === 'legacy-migrated-existing', 'later legacy preflight ensure was not idempotent');
  cleanupWorker(migrated.manifest, 'odysseus', migratedAllocation.token, 'interrupted');
  const replacementState = JSON.parse(readFileSync(migrated.statePath, 'utf8'));
  delete replacementState.allocations.odysseus;
  writeFileSync(migrated.statePath, `${JSON.stringify(replacementState, null, 2)}\n`, { mode: 0o600 });
  const replacement = allocateWorker(migrated.manifest, 'odysseus', { executionBinding: executionBinding('preflight-current-controller') });
  assert(replacement.allocationId !== migratedState.allocations.odysseus.allocationId, 'replacement allocation reused the migrated allocation identity');
  expectThrow(() => ensurePreflightHeartbeat(migrated.manifest), 'replacement allocation inherited a migrated existing-heartbeat exemption');
  rmSync(join(migrated.root, legacyResult.path), { force: true });
  expectThrow(() => ensurePreflightHeartbeat(migrated.manifest), 'replacement allocation inherited a migrated no-heartbeat exemption');
}

function createFixture(name, selectedAgents = ['atlas', 'hermes', 'odysseus']) {
  const root = join(work, name);
  mkdirSync(root, { recursive: true });
  const manifest = createDefaultEngagement({
    template,
    target: root,
    targetRoot: root,
    artifactRoot: root,
    mode: 'A',
    engagementId: name,
    selectedAgents,
  });
  const initialized = initializeEngagementState(manifest);
  assert(initialized.state.schemaVersion === 2, 'new engagement state did not use schemaVersion 2');
  assert(initialized.state.migrations.length === 0, 'new engagement state unexpectedly recorded a migration');
  assertPrivateSingleLink(initialized.path, 'new engagement state');
  return { root, manifest, statePath: initialized.path };
}

function testAuthenticatedMonotonicHeartbeats() {
  const { root, manifest, statePath } = createFixture('heartbeat-hardening');
  ensurePreflightHeartbeat(manifest, '2026-07-12T08:00:00.000Z');

  const odysseus = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('heartbeat-controller') });
  const hermes = allocateWorker(manifest, 'hermes', {
    controllerToken: odysseus.token,
    executionBinding: executionBinding('heartbeat-hermes'),
  });
  assertPrivateSingleLink(join(root, 'ai_agents_internal/workers/odysseus/.lease'), 'Odysseus lease');
  assertPrivateSingleLink(join(root, 'ai_agents_internal/workers/hermes/.lease'), 'Hermes lease');
  assert(ensurePreflightHeartbeat(manifest).disposition === 'existing', 'preflight replay after allocation did not validate the initial record');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', '', 'hunting', 1, 4, 'running'), 'heartbeat without a lease');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', odysseus.token, 'hunting', 1, 4, 'running'), 'cross-lane heartbeat token');
  unlinkSync(join(root, 'ai_agents_internal/workers/odysseus/.lease'));
  expectThrow(() => appendHeartbeat(manifest, 'odysseus', odysseus.token, 'discovery', 0, 1, 'started'), 'heartbeat with a missing live lease file');

  appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 1, 4, 'running', '2026-07-12T08:01:00.000Z');
  const heartbeat = join(root, 'ai_agents_internal/heartbeat/hermes.log');
  assertPrivateSingleLink(heartbeat, 'Hermes heartbeat');
  appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 1, 4, 'blocked', '2026-07-12T08:01:01.000Z');
  appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 2, 4, 'running', '2026-07-12T08:01:02.000Z');
  appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 2, 4, 'degraded', '2026-07-12T08:01:03.000Z');
  appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 3, 4, 'running', '2026-07-12T08:01:04.000Z');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 2, 4, 'running', '2026-07-12T08:01:05.000Z'), 'heartbeat progress regression');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 3, 5, 'running', '2026-07-12T08:01:05.000Z'), 'heartbeat total drift');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 3, 4, 'started', '2026-07-12T08:01:05.000Z'), 'heartbeat status regression');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'discovery', 3, 4, 'running', '2026-07-12T08:01:05.000Z'), 'heartbeat phase regression');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 2, 4, 'running', '2026-07-12T07:59:59.000Z'), 'heartbeat timestamp regression');

  const beforeHeartbeat = readFileSync(heartbeat, 'utf8');
  const heartbeatPeer = join(work, 'heartbeat-hardlink-peer.log');
  linkSync(heartbeat, heartbeatPeer);
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 4, 4, 'complete', '2026-07-12T08:01:05.000Z'), 'hard-linked heartbeat');
  assert(readFileSync(heartbeatPeer, 'utf8') === beforeHeartbeat, 'hard-linked heartbeat peer was modified');
  unlinkSync(heartbeatPeer);
  appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 4, 4, 'complete', '2026-07-12T08:01:05.000Z');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'hunting', 4, 4, 'running', '2026-07-12T08:01:06.000Z'), 'heartbeat resumed after terminal completion within one phase');

  const lease = join(root, 'ai_agents_internal/workers/hermes/.lease');
  const leasePeer = join(work, 'lease-hardlink-peer');
  linkSync(lease, leasePeer);
  expectThrow(
    () => allocateWorker(manifest, 'hermes', { resumeToken: hermes.token, controllerToken: odysseus.token }),
    'hard-linked active lease',
  );
  assert(readFileSync(leasePeer, 'utf8').trim() === `allocation:${hermes.allocationId}`, 'hard-linked lease peer was modified');
  unlinkSync(leasePeer);

  const sentinel = join(work, 'stale-lease-sentinel');
  writeFileSync(sentinel, 'do-not-truncate\n', { mode: 0o600 });
  const staleLease = join(root, 'ai_agents_internal/workers/atlas/.lease');
  mkdirSync(join(root, 'ai_agents_internal/workers/atlas'), { recursive: true });
  linkSync(sentinel, staleLease);
  expectThrow(
    () => allocateWorker(manifest, 'atlas', {
      controllerToken: odysseus.token,
      executionBinding: executionBinding('heartbeat-atlas'),
    }),
    'hard-linked stale lease',
  );
  assert(readFileSync(sentinel, 'utf8') === 'do-not-truncate\n', 'stale hard-linked lease truncated its peer');
  unlinkSync(staleLease);

  const statePeer = join(work, 'state-hardlink-peer.json');
  const stateBefore = readFileSync(statePath, 'utf8');
  linkSync(statePath, statePeer);
  expectThrow(
    () => writeCheckpoint(manifest, 'hermes', hermes.token, 'hunting', 1, 'hardlink-state-write', 1, { shouldNotPersist: true }),
    'mutation through a hard-linked engagement state',
  );
  assert(readFileSync(statePeer, 'utf8') === stateBefore, 'hard-linked state peer was modified');
  unlinkSync(statePeer);
}

function testLegacyStateMigrationAndResume() {
  const { root, manifest, statePath } = createFixture('legacy-state-resume', ['hermes', 'odysseus']);
  const controllerBinding = executionBinding('legacy-controller');
  const workerBinding = executionBinding('legacy-hermes');
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: controllerBinding });
  const allocation = allocateWorker(manifest, 'hermes', {
    controllerToken: controller.token,
    executionBinding: workerBinding,
  });
  writeCheckpoint(manifest, 'hermes', allocation.token, 'hunting', 1, workerBinding.dispatchId, 1, { completed: ['surface-a'], next: 'surface-b' });

  // This is the exact field shape written before commit 8db70aa: allocation
  // records had no allocationId and checkpoints had no dispatch/attempt/allocation binding.
  const runtimeV1 = JSON.parse(readFileSync(statePath, 'utf8'));
  const legacy = structuredClone(runtimeV1);
  runtimeV1.schemaVersion = 1;
  delete runtimeV1.migrations;
  delete runtimeV1.checkpoints.hermes.bindingOrigin;
  const preservedAllocationId = runtimeV1.allocations.hermes.allocationId;
  const preservedDispatchId = runtimeV1.checkpoints.hermes.dispatchId;
  writeFileSync(statePath, `${JSON.stringify(runtimeV1, null, 2)}\n`, { mode: 0o600 });
  const preserved = getEngagementStatus(manifest);
  assert(preserved.allocations.hermes.allocationId === preservedAllocationId, 'runtime-v1 allocation binding was not preserved');
  assert(preserved.checkpoints.hermes.dispatchId === preservedDispatchId, 'runtime-v1 dispatch binding was not preserved');
  assert(preserved.checkpoints.hermes.bindingOrigin === 'runtime-v1', 'runtime-v1 checkpoint origin is not truthful');
  assert(preserved.migrations[0].runtimeV1BindingsPreserved.join(',') === 'hermes', 'runtime-v1 preservation audit is incomplete');
  assert(preserved.migrations[0].activeAllocationIdsAtMigration.hermes === preserved.allocations.hermes.allocationId, 'runtime-v1 active allocation audit is incomplete');

  legacy.schemaVersion = 1;
  delete legacy.migrations;
  for (const lane of ['hermes', 'odysseus']) {
    delete legacy.allocations[lane].allocationId;
    for (const field of ['modelDecisionId', 'modelDecisionIntegritySha256', 'dispatchId', 'attempt', 'runtime']) delete legacy.allocations[lane][field];
  }
  delete legacy.checkpoints.hermes.dispatchId;
  delete legacy.checkpoints.hermes.attempt;
  delete legacy.checkpoints.hermes.allocationId;
  delete legacy.checkpoints.hermes.bindingOrigin;
  const legacyBytes = `${JSON.stringify(legacy, null, 2)}\n`;
  writeFileSync(leasePath({ root }, 'hermes'), `${allocation.token}\n`, { mode: 0o600 });
  writeFileSync(leasePath({ root }, 'odysseus'), `${controller.token}\n`, { mode: 0o600 });

  writeFileSync(statePath, legacyBytes, { mode: 0o600 });
  const first = getEngagementStatus(manifest);
  assert(first.schemaVersion === 2 && first.migrations.length === 1, 'legacy state was not persisted as v2');
  assert(first.migrations[0].allocationIdsSynthesized.join(',') === 'hermes,odysseus', 'legacy allocation migration audit is incomplete');
  assert(first.migrations[0].activeAllocationIdsAtMigration.hermes === first.allocations.hermes.allocationId, 'legacy active allocation migration audit is incomplete');
  assert(first.migrations[0].checkpointBindingsSynthesized.join(',') === 'hermes', 'legacy checkpoint migration audit is incomplete');
  assert(first.checkpoints.hermes.bindingOrigin === 'migrated-v1', 'legacy checkpoint binding origin is not truthful');
  assert(first.checkpoints.hermes.allocationId === first.allocations.hermes.allocationId, 'legacy checkpoint was not bound to its allocation');
  assert(/^legacy-v1:[a-f0-9]{24}$/.test(first.checkpoints.hermes.dispatchId), 'legacy checkpoint has no deterministic dispatch identity');
  assertPrivateSingleLink(statePath, 'migrated engagement state');

  writeFileSync(statePath, legacyBytes, { mode: 0o600 });
  const second = getEngagementStatus(manifest);
  assert(second.allocations.hermes.allocationId === first.allocations.hermes.allocationId, 'legacy allocation ID migration is not deterministic');
  assert(second.checkpoints.hermes.dispatchId === first.checkpoints.hermes.dispatchId, 'legacy checkpoint dispatch migration is not deterministic');
  assert(second.migrations[0].migrationId === first.migrations[0].migrationId, 'legacy migration identity is not deterministic');

  writeFileSync(leasePath({ root }, 'hermes'), `allocation:${second.allocations.hermes.allocationId}\n`, { mode: 0o600 });
  bindLegacyAllocationDecision(manifest, 'odysseus', controller.token, controllerBinding);
  bindLegacyAllocationDecision(manifest, 'hermes', allocation.token, workerBinding);
  assert(readFileSync(leasePath({ root }, 'odysseus'), 'utf8').trim() === `allocation:${second.allocations.odysseus.allocationId}`, 'legacy controller lease token remained readable after binding');
  assert(readFileSync(leasePath({ root }, 'hermes'), 'utf8').trim() === `allocation:${second.allocations.hermes.allocationId}`, 'legacy worker lease token remained readable after binding');
  const resumed = allocateWorker(manifest, 'hermes', {
    resumeToken: allocation.token,
    controllerToken: controller.token,
    executionBinding: workerBinding,
  });
  assert(resumed.resumed && resumed.token === allocation.token, 'migrated active allocation did not resume with its original lease');
  writeCheckpoint(manifest, 'hermes', allocation.token, 'hunting', 2, workerBinding.dispatchId, 1, { completed: ['surface-a', 'surface-b'], next: null });
  const current = getEngagementStatus(manifest);
  assert(current.checkpoints.hermes.bindingOrigin === 'runtime', 'post-migration checkpoint did not return to runtime binding');
  assert(current.checkpoints.hermes.allocationId === current.allocations.hermes.allocationId, 'post-migration checkpoint lost allocation ownership');
  cleanupWorker(manifest, 'hermes', allocation.token, 'interrupted');
  cleanupWorker(manifest, 'odysseus', controller.token, 'interrupted');
  assert(getEngagementStatus(manifest).allocations.hermes.status === 'released', 'migrated allocation did not complete its lifecycle');
}

function executionBinding(seed, overrides = {}) {
  const digest = createHash('sha256').update(seed).digest('hex');
  return {
    modelDecisionId: `MDR-${digest.slice(0, 24)}`,
    modelDecisionIntegritySha256: digest,
    dispatchId: `dispatch:${seed}`,
    attempt: 1,
    runtime: 'claude',
    ...overrides,
  };
}

function leasePath(fixture, lane) {
  return join(fixture.root, 'ai_agents_internal', 'workers', lane, '.lease');
}

function assertLeaseMarker(fixture, allocation, label) {
  const path = leasePath(fixture, allocation.lane);
  assertPrivateSingleLink(path, `${label} lease`);
  const marker = readFileSync(path, 'utf8').trim();
  assert(marker === `allocation:${allocation.allocationId}`, `${label} lease does not contain its non-secret allocation marker`);
  assert(marker !== allocation.token, `${label} lease disclosed its capability token`);
}

function assertPrivateSingleLink(path, label) {
  const stats = statSync(path);
  assert(stats.isFile(), `${label} is not a regular file`);
  assert(stats.nlink === 1, `${label} does not have exactly one link`);
  assert((stats.mode & 0o777) === 0o600, `${label} mode is not 0600`);
}

function expectThrow(operation, label) {
  let failed = false;
  try { operation(); }
  catch { failed = true; }
  assert(failed, `${label} unexpectedly succeeded`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
