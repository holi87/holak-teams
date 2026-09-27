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
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  allocateWorker,
  advanceBarrier,
  appendHeartbeat,
  arriveBarrier,
  bindDispatchableAgents,
  cleanupWorker,
  conditionalGateRequest,
  createDefaultEngagement,
  ensurePreflightHeartbeat,
  evaluateWriteGuard,
  getBarrierStatus,
  getEngagementStatus,
  initializeEngagementState,
  mergeCanonical,
  resolveConditionalGates,
  skipPhases,
  validateEngagementManifest,
  writeCheckpoint,
  writeFragment,
} from '../argus/runtime/engagement.mjs';
import { derivePhasePlan } from '../argus/runtime/orchestration-plan.mjs';

const ROOT = new URL('..', import.meta.url);
const readRepoJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const template = readRepoJson('argus/policies/engagement.template.json');
const orchestrationPlan = readRepoJson('argus/orchestration-plan.json');
const capabilityMatrix = readRepoJson('argus/capabilities/capability-matrix.json');
const raci = readRepoJson('argus/raci.json');
const finalSummaryFixture = readRepoJson('scripts/fixtures/argus-schemas/valid/final-summary.json');
const coverageResultFixture = readRepoJson('scripts/fixtures/argus-schemas/valid/coverage-result.json');
const runnerResultFixture = readRepoJson('scripts/fixtures/argus-schemas/valid/runner-result.json');
const bugLedgerFixture = readRepoJson('scripts/fixtures/argus-schemas/valid/bug-ledger.json');
const evidenceFixture = readRepoJson('scripts/fixtures/argus-schemas/valid/evidence-reference.json');
const stateSchemaAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(stateSchemaAjv);
const validateStateSchema = stateSchemaAjv.compile(readRepoJson('argus/schemas/engagement-state.schema.json'));
const MODE_A_PHASES = [
  'preflight', 'discovery', 'hunting', 'proof', 'deep-hunt-1', 'deep-proof-1', 'deep-hunt-2', 'deep-proof-2',
  'deep-hunt-3', 'deep-proof-3', 'automation', 'verification', 'reporting', 'complete',
];
const work = mkdtempSync(join(tmpdir(), 'argus-engagement-state-'));

try {
  testHardLinkWriteGuard();
  testHeartbeatGuardRequiresController();
  testDecisionBoundAllocationAuthorization();
  testAuthenticatedControllerRecovery();
  testControllerSuccessRequiresFinalBarrier();
  testWorkerSuccessRequiresBarrier();
  testDerivedPhasePlan();
  testProofPhaseRequiresLedgerMerge();
  testLedgerSnapshotNewConfirmed();
  testConvergedSkip();
  testStandbyBlocksSuccessCleanup();
  testConditionalLaneProjection();
  testConditionalGateResolution();
  testGateUnmetFinalSummary();
  testIdempotentPreflightHeartbeat();
  testAuthenticatedMonotonicHeartbeats();
  console.log('PASS  Argus engagement state: derived phases, standby, proof ledger gate, recorded skips, conditional lanes, one-shot gate resolution, decision-bound leases, authenticated heartbeat, and link defenses');
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
  const { manifest } = fixture;
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('worker-barrier-controller') });
  const worker = allocateWorker(manifest, 'hermes', {
    controllerToken: controller.token,
    executionBinding: executionBinding('worker-barrier-hermes'),
  });
  expectThrow(() => cleanupWorker(manifest, 'hermes', worker.token, 'success'), 'worker success before its declared barrier arrival');
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'hermes', worker.token, 'hunting');
  expectThrowMessage(
    () => cleanupWorker(manifest, 'hermes', worker.token, 'success'),
    'hermes success cleanup is not yet available: pending proof, deep-hunt-1, deep-proof-1, deep-hunt-2, deep-proof-2, deep-hunt-3, deep-proof-3; the lease stays active and Odysseus performs terminal cleanup',
    'hermes success while its deep-hunt passes and proof standby are pending',
  );
  assert(getEngagementStatus(manifest).allocations.hermes.status === 'active', 'refused success cleanup released the lease');
  advanceBarrier(manifest, 'odysseus', controller.token);
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'hermes', worker.token, 'deep-hunt-1');
  expectThrowMessage(
    () => cleanupWorker(manifest, 'hermes', worker.token, 'success'),
    'hermes success cleanup is not yet available: pending deep-proof-1, deep-hunt-2, deep-proof-2, deep-hunt-3, deep-proof-3; the lease stays active and Odysseus performs terminal cleanup',
    'hermes success after deep-hunt-1 while later passes are pending',
  );
  advanceBarrier(manifest, 'odysseus', controller.token);
  advanceBarrier(manifest, 'odysseus', controller.token);
  assert(getEngagementStatus(manifest).currentPhase === 'deep-hunt-2', 'phase did not reach deep-hunt-2');
  arriveBarrier(manifest, 'hermes', worker.token, 'deep-hunt-2');
  expectThrowMessage(() => skipPhases(manifest, 'odysseus', controller.token, 'controller-budget'), 'phase deep-hunt-2 already has arrivals', 'skip of a started pass');
  advanceBarrier(manifest, 'odysseus', controller.token);
  expectThrowMessage(() => skipPhases(manifest, 'odysseus', controller.token, 'controller-budget'), 'only a deep-hunt pass can start a skip', 'skip starting at a proof pass');
  advanceBarrier(manifest, 'odysseus', controller.token);
  // Without a selected validator no proof snapshot exists, so convergence cannot be claimed.
  expectThrowMessage(
    () => skipPhases(manifest, 'odysseus', controller.token, 'converged'),
    'converged skip requires deep-proof-2 to record zero new confirmed defects',
    'converged skip without a ledger snapshot',
  );
  const skip = skipPhases(manifest, 'odysseus', controller.token, 'controller-budget');
  assert(JSON.stringify(skip.skipped) === JSON.stringify(['deep-hunt-3', 'deep-proof-3']) && skip.currentPhase === 'automation' && skip.reason === 'controller-budget',
    `controller-budget skip returned an unexpected result: ${JSON.stringify(skip)}`);
  const skippedState = getEngagementStatus(manifest);
  assert(skippedState.skippedPhases['deep-hunt-3']?.reason === 'controller-budget' && skippedState.skippedPhases['deep-hunt-3'].basis === null,
    'controller-budget skip was not recorded with a null basis');
  assert(!skippedState.completedPhases.includes('deep-hunt-3'), 'a skipped phase was recorded as completed');
  const cleaned = cleanupWorker(manifest, 'hermes', worker.token, 'success');
  assert(cleaned.released === true && cleaned.outcome === 'success', 'worker did not release after its passes arrived or were skipped');
  cleanupWorker(manifest, 'odysseus', controller.token, 'interrupted');
}

function testDerivedPhasePlan() {
  const fixture = createFixture('derived-phase-plan');
  const { manifest, root, statePath } = fixture;
  assert(manifest.schemaVersion === 2, 'derived manifest did not use schemaVersion 2');
  assert(JSON.stringify(manifest.phasePlan.map((phase) => phase.id)) === JSON.stringify(MODE_A_PHASES), `Mode A phase ids drifted: ${manifest.phasePlan.map((phase) => phase.id).join(', ')}`);
  const hunting = manifest.phasePlan.find((phase) => phase.id === 'hunting');
  const proof = manifest.phasePlan.find((phase) => phase.id === 'proof');
  assert(JSON.stringify(hunting.participants) === '["hermes"]' && JSON.stringify(proof.participants) === '[]' && JSON.stringify(proof.standby) === '["hermes"]',
    'derived phase membership was not narrowed to the selected lanes');
  const state = getEngagementStatus(manifest);
  assert(state.currentPhase === 'discovery' && JSON.stringify(state.completedPhases) === '["preflight"]', 'initial phase cursor is not the first derived work phase');
  assert(JSON.stringify(Object.keys(state.barriers)) === JSON.stringify(MODE_A_PHASES), 'barriers are not keyed by the derived phases');
  assert(JSON.stringify(state.skippedPhases) === '{}' && JSON.stringify(state.ledgerSnapshots) === '{}', 'initial state lacks empty skippedPhases and ledgerSnapshots');
  assert(state.conditionalAgents === null && state.gateResolution === null, 'initial state lacks null conditionalAgents and gateResolution');

  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('derived-plan-controller') });
  const hermesBinding = executionBinding('derived-plan-hermes');
  const hermes = allocateWorker(manifest, 'hermes', { controllerToken: controller.token, executionBinding: hermesBinding });
  expectThrowMessage(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'deep-hunt-9', 0, 1, 'started'), 'heartbeat phase is invalid: deep-hunt-9', 'heartbeat outside the derived plan');
  expectThrowMessage(() => writeCheckpoint(manifest, 'hermes', hermes.token, 'deep-hunt-9', 1, hermesBinding.dispatchId, 1, {}), 'unknown phase: deep-hunt-9', 'checkpoint outside the derived plan');
  appendHeartbeat(manifest, 'hermes', hermes.token, 'deep-hunt-3', 0, 1, 'started', '2026-07-12T09:00:00.000Z');
  expectThrow(() => appendHeartbeat(manifest, 'hermes', hermes.token, 'deep-proof-1', 0, 1, 'running', '2026-07-12T09:00:01.000Z'), 'heartbeat regression to an earlier derived phase');
  const heartbeat = join(root, 'ai_agents_internal/heartbeat/hermes.log');
  writeFileSync(heartbeat, readFileSync(heartbeat, 'utf8').replace('\tdeep-hunt-3\t', '\tdeep-hunt-9\t'));
  expectThrowMessage(
    () => appendHeartbeat(manifest, 'hermes', hermes.token, 'reporting', 0, 1, 'started', '2026-07-12T09:00:02.000Z'),
    'heartbeat log for hermes has an invalid record at line 1',
    'persisted heartbeat record outside the derived plan',
  );
  cleanupWorker(manifest, 'hermes', hermes.token, 'interrupted');
  cleanupWorker(manifest, 'odysseus', controller.token, 'interrupted');

  expectThrowMessage(
    () => createDefaultEngagement({ template, target: root, targetRoot: root, artifactRoot: root, mode: 'A', engagementId: 'no-plan', selectedAgents: ['odysseus'] }),
    'createDefaultEngagement requires a derived phasePlan',
    'engagement creation without a derived phase plan',
  );
  const legacy = {
    ...structuredClone(manifest),
    schemaVersion: 1,
    phasePlan: ['preflight', 'discovery', 'hunting', 'automation', 'verification', 'reporting', 'complete']
      .map((id) => ({ id, participants: id === 'preflight' || id === 'complete' ? ['odysseus'] : [] })),
  };
  const legacyErrors = validateEngagementManifest(legacy);
  assert(legacyErrors.includes('schemaVersion must be 2') && legacyErrors.some((error) => error.startsWith('phase preflight must contain exactly')),
    `pre-5.0 manifest was not rejected: ${legacyErrors.join('; ')}`);
  for (const [label, mutate, expected] of [
    ['proof participant other than minos', (plan) => { plan[3].participants = ['hermes']; plan[3].standby = []; }, 'proof phase proof participants must be a subset of minos'],
    ['skippable first pass', (plan) => { plan[4].skippable = true; }, 'phase deep-hunt-1 skippable must be boolean and true only for a proof or deep-hunt pass of 2 or more'],
    ['pass on a work phase', (plan) => { plan[2].pass = 1; }, 'phase hunting pass must be an integer 0-3 exactly when kind is proof or deep-hunt'],
    ['missing pass on a deep-hunt phase', (plan) => { delete plan[6].pass; }, 'phase deep-hunt-2 pass must be an integer 0-3 exactly when kind is proof or deep-hunt'],
    ['wave regression', (plan) => { plan[10].wave = 'W1'; }, 'phase automation regresses wave W1'],
    ['unknown phase field', (plan) => { plan[2].owner = 'hermes'; }, 'phase hunting must contain exactly id, wave, kind, pass (proof and deep-hunt only), skippable, participants, and standby'],
    ['participant and standby overlap', (plan) => { plan[2].standby = ['hermes']; }, 'phase hunting lists hermes as both participant and standby'],
    ['unselected participant', (plan) => { plan[2].participants = ['hermes', 'kleio']; }, 'phase hunting participants and standby must be unique selected agent slugs'],
    ['duplicate phase id', (plan) => { plan[5].id = 'deep-hunt-1'; }, 'phasePlan ids must be unique slugs'],
    ['missing terminal phase', (plan) => { plan.pop(); }, 'phasePlan must start with preflight and end with complete'],
    ['controller phase in the middle', (plan) => { plan[2].wave = 'controller'; }, 'phase hunting: only preflight and complete may be controller control phases'],
    ['worker in a control phase', (plan) => { plan[0].participants = ['hermes']; }, 'phase preflight must be a controller control phase with at most odysseus participating and no standby'],
  ]) {
    const mutated = structuredClone(manifest);
    mutate(mutated.phasePlan);
    const errors = validateEngagementManifest(mutated);
    assert(errors.includes(expected), `${label} was not rejected with "${expected}": ${errors.join('; ')}`);
  }

  const current = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, `${JSON.stringify({ ...current, schemaVersion: 2 }, null, 2)}\n`);
  expectThrowMessage(() => getEngagementStatus(manifest), 'unsupported engagement state schemaVersion: 2', 'pre-5.0 engagement state');
  const { skippedPhases, ledgerSnapshots, ...withoutNewFields } = current;
  writeFileSync(statePath, `${JSON.stringify(withoutNewFields, null, 2)}\n`);
  expectThrow(() => getEngagementStatus(manifest), 'v3 state without skippedPhases and ledgerSnapshots');
  // There is no migration path: a state without the conditional-lane fields is not v3.
  const { conditionalAgents, gateResolution, ...withoutConditionalFields } = current;
  writeFileSync(statePath, `${JSON.stringify(withoutConditionalFields, null, 2)}\n`);
  expectThrowMessage(
    () => getEngagementStatus(manifest),
    'engagement state integrity failed: conditionalAgents must be null until the dispatchable projection is bound; gateResolution must be null until the dispatchable projection is bound',
    'v3 state without conditionalAgents and gateResolution',
  );
  writeFileSync(statePath, `${JSON.stringify({ ...current, conditionalAgents: { hermes: ['db-access'] } }, null, 2)}\n`);
  expectThrow(() => getEngagementStatus(manifest), 'conditional lanes before the dispatchable projection is bound');
  writeFileSync(statePath, `${JSON.stringify({ ...current, skippedPhases: { proof: { reason: 'converged', skippedAt: '2026-07-12T09:00:00.000Z', basis: null } } }, null, 2)}\n`);
  expectThrow(() => getEngagementStatus(manifest), 'skip record on a non-skippable phase');
  writeFileSync(statePath, `${JSON.stringify({ ...current, ledgerSnapshots: { triage: {} } }, null, 2)}\n`);
  expectThrow(() => getEngagementStatus(manifest), 'ledger snapshot for an unknown phase');
  writeFileSync(statePath, `${JSON.stringify(current, null, 2)}\n`);
  assert(getEngagementStatus(manifest).revision === current.revision, 'restored v3 state was not accepted');
}

function testProofPhaseRequiresLedgerMerge() {
  const fixture = createFixture('proof-ledger-gate', ['hermes', 'minos', 'odysseus']);
  const { manifest, root } = fixture;
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('proof-gate-controller') });
  const minos = allocateWorker(manifest, 'minos', { controllerToken: controller.token, executionBinding: executionBinding('proof-gate-minos') });
  const hermes = allocateWorker(manifest, 'hermes', { controllerToken: controller.token, executionBinding: executionBinding('proof-gate-hermes') });
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'hermes', hermes.token, 'hunting');
  advanceBarrier(manifest, 'odysseus', controller.token);
  expectThrowMessage(() => advanceBarrier(manifest, 'odysseus', controller.token), 'phase proof is waiting for: minos', 'proof advance before the validator arrives');
  arriveBarrier(manifest, 'minos', minos.token, 'proof');
  expectThrowMessage(
    () => advanceBarrier(manifest, 'odysseus', controller.token),
    'proof phase proof requires a Minos bug-ledger merge before it can advance',
    'proof advance without a ledger merge',
  );
  assert(getEngagementStatus(manifest).currentPhase === 'proof', 'refused proof advance moved the phase cursor');
  mergeEmptyLedger(fixture, minos.token, 'proof-ledger');
  const snapshot = getEngagementStatus(manifest).ledgerSnapshots.proof;
  assert(JSON.stringify(snapshot?.fragmentIds) === '["proof-ledger"]' && snapshot.confirmed.length === 0 && snapshot.newConfirmed.length === 0 &&
    snapshot.suspected.length === 0 && snapshot.needsOracle.length === 0 && snapshot.bounced.length === 0 && snapshot.quarantined.length === 0 &&
    Number.isFinite(Date.parse(snapshot.mergedAt)), `proof ledger snapshot is not exact: ${JSON.stringify(snapshot)}`);
  const advanced = advanceBarrier(manifest, 'odysseus', controller.token);
  assert(advanced.completed === 'proof' && advanced.currentPhase === 'deep-hunt-1', 'proof phase did not advance after the Minos ledger merge');
  assert(existsSync(join(root, 'solution/bug-ledger.json')), 'ledger merge did not write the canonical bug ledger');
  for (const [lane, token] of [['hermes', hermes.token], ['minos', minos.token], ['odysseus', controller.token]]) cleanupWorker(manifest, lane, token, 'interrupted');
}

function testLedgerSnapshotNewConfirmed() {
  const fixture = createFixture('ledger-new-confirmed', ['hermes', 'minos', 'odysseus']);
  const { manifest, root } = fixture;
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('new-confirmed-controller') });
  const minos = allocateWorker(manifest, 'minos', { controllerToken: controller.token, executionBinding: executionBinding('new-confirmed-minos') });
  const hermes = allocateWorker(manifest, 'hermes', { controllerToken: controller.token, executionBinding: executionBinding('new-confirmed-hermes') });
  const evidenceBytes = 'synthetic reproduction request\n';
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'reports/request-1.txt'), evidenceBytes);
  const evidence = structuredClone(evidenceFixture);
  evidence.engagementId = manifest.engagementId;
  evidence.references = [{ ...evidence.references[0], sha256: createHash('sha256').update(evidenceBytes).digest('hex') }];
  writeFragment(manifest, 'hermes', hermes.token, 'solution/evidence-reference.json', 'hermes-evidence', `${JSON.stringify(evidence)}\n`);
  const ledger = { ...structuredClone(bugLedgerFixture), engagementId: manifest.engagementId };
  writeFragment(manifest, 'minos', minos.token, 'solution/bug-ledger.json', 'confirmed-ledger', `${JSON.stringify(ledger)}\n`);
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'hermes', hermes.token, 'hunting');
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'minos', minos.token, 'proof');
  mergeCanonical(manifest, 'minos', minos.token, 'solution/bug-ledger.json');
  const proof = getEngagementStatus(manifest).ledgerSnapshots.proof;
  assert(JSON.stringify(proof.confirmed) === '["BUG-0001"]' && JSON.stringify(proof.newConfirmed) === '["BUG-0001"]',
    `first proof snapshot did not count BUG-0001 as newly confirmed: ${JSON.stringify(proof)}`);
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'hermes', hermes.token, 'deep-hunt-1');
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'minos', minos.token, 'deep-proof-1');
  mergeCanonical(manifest, 'minos', minos.token, 'solution/bug-ledger.json');
  const deepProof = getEngagementStatus(manifest).ledgerSnapshots['deep-proof-1'];
  assert(JSON.stringify(deepProof.confirmed) === '["BUG-0001"]' && deepProof.newConfirmed.length === 0,
    `deep-proof-1 snapshot counted an earlier confirmed defect as new: ${JSON.stringify(deepProof)}`);
  advanceBarrier(manifest, 'odysseus', controller.token);
  const skip = skipPhases(manifest, 'odysseus', controller.token, 'converged');
  assert(skip.currentPhase === 'automation', 'converged skip was refused although deep-proof-1 confirmed nothing new');
  for (const [lane, token] of [['hermes', hermes.token], ['minos', minos.token], ['odysseus', controller.token]]) cleanupWorker(manifest, lane, token, 'interrupted');
}

function testConvergedSkip() {
  const converged = runToSecondDeepHunt('converged-skip');
  const { manifest } = converged.fixture;
  const { controller, hermes, kleio } = converged.tokens;
  expectThrowMessage(() => skipPhases(manifest, 'hermes', hermes, 'converged'), 'only odysseus may skip phases', 'non-controller skip');
  expectThrowMessage(() => skipPhases(manifest, 'odysseus', controller, 'bored'), 'skip reason must be converged or controller-budget', 'unknown skip reason');
  const skip = skipPhases(manifest, 'odysseus', controller, 'converged');
  assert(JSON.stringify(skip.skipped) === JSON.stringify(['deep-hunt-2', 'deep-proof-2', 'deep-hunt-3', 'deep-proof-3']) && skip.currentPhase === 'automation',
    `converged skip did not cascade to automation: ${JSON.stringify(skip)}`);
  const state = getEngagementStatus(manifest);
  for (const phase of skip.skipped) {
    const record = state.skippedPhases[phase];
    assert(record?.reason === 'converged' && record.basis === 'deep-proof-1' && Number.isFinite(Date.parse(record.skippedAt)), `${phase} skip record is not exact`);
  }
  expectThrowMessage(() => arriveBarrier(manifest, 'hermes', hermes, 'deep-hunt-2'), 'phase deep-hunt-2 was skipped (converged)', 'arrival at a skipped phase');
  assert(JSON.stringify(state.barriers['deep-hunt-2']) === '[]', 'skipped phase recorded arrivals');
  mergeFinalSummary(converged.fixture, kleio);
  const convergedSummary = readSolutionJson(converged.fixture, 'final-summary.json');
  assert(convergedSummary.status === 'completed' && convergedSummary.statusReasons.length === 0, `converged skip degraded the final summary: ${JSON.stringify(convergedSummary.statusReasons)}`);
  assert(cleanupWorker(manifest, 'hermes', hermes, 'success').released, 'hermes success cleanup was refused after a converged skip');

  const budget = runToSecondDeepHunt('controller-budget-skip');
  const budgetState = JSON.parse(readFileSync(budget.fixture.statePath, 'utf8'));
  budgetState.ledgerSnapshots['deep-proof-1'].confirmed = ['BUG-0001'];
  budgetState.ledgerSnapshots['deep-proof-1'].newConfirmed = ['BUG-0001'];
  writeFileSync(budget.fixture.statePath, `${JSON.stringify(budgetState, null, 2)}\n`);
  expectThrowMessage(
    () => skipPhases(budget.fixture.manifest, 'odysseus', budget.tokens.controller, 'converged'),
    'converged skip requires deep-proof-1 to record zero new confirmed defects',
    'converged skip after a pass that confirmed a new defect',
  );
  const budgetSkip = skipPhases(budget.fixture.manifest, 'odysseus', budget.tokens.controller, 'controller-budget');
  assert(budgetSkip.currentPhase === 'automation' && budgetSkip.skipped.length === 4, 'controller-budget skip did not cascade to automation');
  mergeFinalSummary(budget.fixture, budget.tokens.kleio);
  const budgetSummary = readSolutionJson(budget.fixture, 'final-summary.json');
  assert(budgetSummary.status === 'degraded' && JSON.stringify(budgetSummary.statusReasons) === '["deep-hunt-skipped:controller-budget"]',
    `controller-budget skip did not degrade a completed final summary through its status reason: ${JSON.stringify(budgetSummary)}`);
}

function testStandbyBlocksSuccessCleanup() {
  const fixture = createFixture('standby-cleanup', ['metis', 'minos', 'odysseus']);
  const { manifest } = fixture;
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('standby-controller') });
  const metis = allocateWorker(manifest, 'metis', { controllerToken: controller.token, executionBinding: executionBinding('standby-metis') });
  const minos = allocateWorker(manifest, 'minos', { controllerToken: controller.token, executionBinding: executionBinding('standby-minos') });
  const refusal = (pending) => `metis success cleanup is not yet available: pending ${pending}; the lease stays active and Odysseus performs terminal cleanup`;
  arriveBarrier(manifest, 'metis', metis.token, 'discovery');
  advanceBarrier(manifest, 'odysseus', controller.token);
  advanceBarrier(manifest, 'odysseus', controller.token);
  assert(getEngagementStatus(manifest).currentPhase === 'proof', 'phase did not reach proof');
  expectThrowMessage(
    () => cleanupWorker(manifest, 'metis', metis.token, 'success'),
    refusal('proof, deep-proof-1, deep-proof-2, deep-proof-3, verification'),
    'oracle-desk standby success during proof',
  );
  arriveBarrier(manifest, 'minos', minos.token, 'proof');
  mergeEmptyLedger(fixture, minos.token, 'standby-proof');
  advanceBarrier(manifest, 'odysseus', controller.token);
  expectThrowMessage(
    () => cleanupWorker(manifest, 'metis', metis.token, 'success'),
    refusal('deep-proof-1, deep-proof-2, deep-proof-3, verification'),
    'oracle-desk standby success before the deep proof passes',
  );
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'minos', minos.token, 'deep-proof-1');
  mergeEmptyLedger(fixture, minos.token);
  advanceBarrier(manifest, 'odysseus', controller.token);
  skipPhases(manifest, 'odysseus', controller.token, 'converged');
  expectThrowMessage(
    () => cleanupWorker(manifest, 'metis', metis.token, 'success'),
    refusal('verification'),
    'metis success before its verification arrival',
  );
  advanceBarrier(manifest, 'odysseus', controller.token);
  arriveBarrier(manifest, 'metis', metis.token, 'verification');
  const cleaned = cleanupWorker(manifest, 'metis', metis.token, 'success');
  assert(cleaned.released === true && cleaned.outcome === 'success', 'metis did not release after its proof standby passed or was skipped');
  expectThrowMessage(
    () => cleanupWorker(manifest, 'minos', minos.token, 'success'),
    'minos success cleanup is not yet available: pending verification; the lease stays active and Odysseus performs terminal cleanup',
    'minos success before its verification arrival',
  );
  cleanupWorker(manifest, 'minos', minos.token, 'failure');
  cleanupWorker(manifest, 'odysseus', controller.token, 'interrupted');
}

// The conditional map is sealed with the dispatchable projection: normalized, restricted to
// dispatchable workers other than Odysseus and Kalchas, and immutable once bound.
function testConditionalLaneProjection() {
  const lanes = ['charon', 'hermes', 'kalchas', 'odysseus', 'orion'];
  const fixture = createFixture('conditional-projection', lanes);
  const { manifest } = fixture;
  for (const [label, conditional, expected] of [
    ['controller lane', { odysseus: ['db-access'] }, 'conditional lane odysseus must be a dispatchable worker other than odysseus and kalchas'],
    ['recon lane', { kalchas: ['browser-runtime'] }, 'conditional lane kalchas must be a dispatchable worker other than odysseus and kalchas'],
    ['non-dispatchable lane', { tiresias: ['source-access'] }, 'conditional lane tiresias must be a dispatchable worker other than odysseus and kalchas'],
    ['empty gate list', { charon: [] }, 'conditional lane charon must list one or more capability ids'],
    ['malformed capability id', { charon: ['DB access'] }, 'conditional lane charon must list one or more capability ids'],
  ]) {
    expectThrowMessage(() => bindDispatchableAgents(manifest, lanes, conditional), expected, `binding a ${label}`);
  }
  assert(getEngagementStatus(manifest).dispatchableAgents === null, 'a refused conditional binding sealed the projection');
  bindDispatchableAgents(manifest, lanes, { orion: ['browser-runtime'], charon: ['db-access', 'db-access'] });
  const state = getEngagementStatus(manifest);
  assert(JSON.stringify(state.conditionalAgents) === '{"charon":["db-access"],"orion":["browser-runtime"]}' && state.gateResolution === null,
    `conditional lanes were not normalized when bound: ${JSON.stringify(state.conditionalAgents)}`);
  assertStateSchema(fixture, 'bound conditional projection');
  bindDispatchableAgents(manifest, [...lanes].reverse(), { charon: ['db-access'], orion: ['browser-runtime'] });
  assert(getEngagementStatus(manifest).revision === state.revision, 'an identical conditional re-bind mutated state');
  for (const [label, conditional] of [
    ['a different gate', { charon: ['db-access'], orion: ['source-access'] }],
    ['an extra lane', { charon: ['db-access'], hermes: ['multi-service'], orion: ['browser-runtime'] }],
    ['no conditional map', undefined],
  ]) {
    expectThrowMessage(() => bindDispatchableAgents(manifest, lanes, conditional), 'dispatchable agent projection is immutable once bound', `re-binding with ${label}`);
  }

  const empty = createFixture('conditional-projection-empty', lanes);
  bindDispatchableAgents(empty.manifest, lanes);
  const emptyState = getEngagementStatus(empty.manifest);
  assert(JSON.stringify(emptyState.conditionalAgents) === '{}' && emptyState.gateResolution === null, 'an unconditional projection did not bind an empty conditional map');
  assertStateSchema(empty, 'bound unconditional projection');
  const controller = allocateWorker(empty.manifest, 'odysseus', { executionBinding: executionBinding('conditional-empty-controller') });
  const kalchas = allocateWorker(empty.manifest, 'kalchas', { controllerToken: controller.token, executionBinding: executionBinding('conditional-empty-kalchas') });
  arriveBarrier(empty.manifest, 'kalchas', kalchas.token, 'discovery');
  expectThrowMessage(() => conditionalGateRequest(empty.manifest, controller.token), 'no conditional lanes await gate resolution', 'gate request without conditional lanes');
  assert(advanceBarrier(empty.manifest, 'odysseus', controller.token).currentPhase === 'hunting', 'discovery without conditional lanes waited for gate resolution');
  for (const [lane, token] of [['kalchas', kalchas.token], ['odysseus', controller.token]]) cleanupWorker(empty.manifest, lane, token, 'interrupted');
}

function testConditionalGateResolution() {
  const lanes = ['atlas', 'charon', 'hermes', 'kalchas', 'metis', 'odysseus', 'orion'];
  const fixture = createFixture('conditional-gates', lanes);
  const { manifest, statePath } = fixture;
  bindDispatchableAgents(manifest, lanes, { charon: ['db-access'], orion: ['browser-runtime'] });
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('conditional-controller') });
  const tokens = { odysseus: controller.token };
  for (const lane of ['atlas', 'hermes', 'kalchas', 'metis']) {
    tokens[lane] = allocateWorker(manifest, lane, { controllerToken: controller.token, executionBinding: executionBinding(`conditional-${lane}`) }).token;
  }
  expectThrowMessage(
    () => allocateWorker(manifest, 'charon', { controllerToken: controller.token, executionBinding: executionBinding('conditional-charon') }),
    'charon is conditional on db-access; run engagement resolve-gates first',
    'conditional lane allocation before gate resolution',
  );
  const verdicts = {
    'db-access': { status: 'proven', basis: 'kalchas-evidence', reason: 'fixture verdict' },
    'browser-runtime': { status: 'unmet', basis: 'runtime-probe', reason: 'fixture verdict' },
  };
  const evidenceSha256 = createHash('sha256').update('capability evidence fixture').digest('hex');
  expectThrowMessage(
    () => resolveConditionalGates(manifest, tokens.kalchas, { evidenceSha256, capabilities: verdicts }),
    'invalid or inactive lease for odysseus',
    'gate resolution with a non-controller token',
  );
  expectThrowMessage(
    () => resolveConditionalGates(manifest, controller.token, { evidenceSha256, capabilities: verdicts }),
    'resolve-gates requires the Kalchas discovery arrival',
    'gate resolution before the Kalchas arrival',
  );
  for (const lane of ['atlas', 'metis']) arriveBarrier(manifest, lane, tokens[lane], 'discovery');
  expectThrowMessage(() => advanceBarrier(manifest, 'odysseus', controller.token), 'phase discovery is waiting for: kalchas', 'discovery advance before the Kalchas arrival');
  arriveBarrier(manifest, 'kalchas', tokens.kalchas, 'discovery');
  expectThrowMessage(
    () => advanceBarrier(manifest, 'odysseus', controller.token),
    'discovery cannot advance before engagement resolve-gates records the conditional lane verdicts',
    'discovery advance before gate resolution',
  );
  const request = conditionalGateRequest(manifest, controller.token);
  assert(JSON.stringify(request.capabilities) === '["browser-runtime","db-access"]' &&
    JSON.stringify(request.conditionalAgents) === '{"charon":["db-access"],"orion":["browser-runtime"]}',
  `gate request does not name the conditional gates: ${JSON.stringify(request)}`);
  for (const [label, resolution, expected] of [
    ['a caller-supplied lane map', { evidenceSha256, capabilities: verdicts, lanes: { charon: 'released', orion: 'released' } },
      'gate resolution accepts only evidenceSha256 and capabilities; lane verdicts are computed by the runtime'],
    ['a missing gate', { evidenceSha256, capabilities: { 'db-access': verdicts['db-access'] } },
      'gate resolution must cover exactly the conditional gates: browser-runtime, db-access'],
    ['an extra gate', { evidenceSha256, capabilities: { ...verdicts, 'source-access': verdicts['db-access'] } },
      'gate resolution must cover exactly the conditional gates: browser-runtime, db-access'],
    ['an unknown status', { evidenceSha256, capabilities: { ...verdicts, 'db-access': { ...verdicts['db-access'], status: 'likely' } } },
      'gate verdict for db-access must be exactly status (proven or unmet), basis, and reason'],
    ['an extra verdict field', { evidenceSha256, capabilities: { ...verdicts, 'db-access': { ...verdicts['db-access'], proof: 'SELECT 1' } } },
      'gate verdict for db-access must be exactly status (proven or unmet), basis, and reason'],
    ['a malformed evidence digest', { evidenceSha256: 'not-a-digest', capabilities: verdicts },
      'gate resolution evidenceSha256 must be null or a SHA-256 hex digest'],
  ]) {
    expectThrowMessage(() => resolveConditionalGates(manifest, controller.token, resolution), expected, `gate resolution with ${label}`);
  }
  assert(getEngagementStatus(manifest).gateResolution === null, 'a refused gate resolution recorded verdicts');

  const resolved = resolveConditionalGates(manifest, controller.token, { evidenceSha256, capabilities: verdicts });
  assert(JSON.stringify(resolved.lanes) === '{"charon":"released","orion":"gate-unmet"}' && resolved.evidenceSha256 === evidenceSha256 &&
    JSON.stringify(resolved.capabilities) === JSON.stringify({ 'browser-runtime': verdicts['browser-runtime'], 'db-access': verdicts['db-access'] }) &&
    Number.isFinite(Date.parse(resolved.resolvedAt)), `gate resolution returned unexpected verdicts: ${JSON.stringify(resolved)}`);
  assert(JSON.stringify(getEngagementStatus(manifest).gateResolution) === JSON.stringify(resolved), 'gate resolution was not persisted exactly');
  assertStateSchema(fixture, 'resolved gate state');
  expectThrowMessage(
    () => resolveConditionalGates(manifest, controller.token, { evidenceSha256: null, capabilities: { ...verdicts, 'browser-runtime': { ...verdicts['browser-runtime'], status: 'proven' } } }),
    'gate resolution is immutable once recorded',
    'a second gate resolution',
  );
  expectThrowMessage(() => conditionalGateRequest(manifest, controller.token), 'gate resolution is immutable once recorded', 'gate request after resolution');
  expectThrowMessage(
    () => allocateWorker(manifest, 'orion', { controllerToken: controller.token, executionBinding: executionBinding('conditional-orion') }),
    'orion was omitted: gate unmet (browser-runtime)',
    'gate-unmet lane allocation',
  );
  tokens.charon = allocateWorker(manifest, 'charon', { controllerToken: controller.token, executionBinding: executionBinding('conditional-charon') }).token;
  assert(advanceBarrier(manifest, 'odysseus', controller.token).currentPhase === 'hunting', 'discovery did not advance after gate resolution');
  const hunting = getBarrierStatus(manifest, 'hunting');
  assert(JSON.stringify(hunting.participants) === '["charon","hermes"]', `hunting barrier did not omit the gate-unmet lane: ${hunting.participants.join(', ')}`);
  for (const phase of ['deep-hunt-1', 'deep-hunt-3']) {
    assert(!getBarrierStatus(manifest, phase).participants.includes('orion'), `${phase} barrier still waits for the gate-unmet lane`);
  }
  arriveBarrier(manifest, 'hermes', tokens.hermes, 'hunting');
  expectThrowMessage(() => advanceBarrier(manifest, 'odysseus', controller.token), 'phase hunting is waiting for: charon', 'hunting advance without the released lane');
  expectThrowMessage(() => arriveBarrier(manifest, 'orion', controller.token, 'hunting'), 'invalid or inactive lease for orion', 'arrival for a gate-unmet lane');
  expectThrowMessage(
    () => resolveConditionalGates(manifest, controller.token, { evidenceSha256, capabilities: verdicts }),
    'gate resolution is immutable once recorded',
    'gate resolution after discovery',
  );

  // Recorded verdicts are re-validated on every load; lane outcomes follow the capability verdicts.
  const current = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const [label, mutate] of [
    ['a promoted gate-unmet lane', (state) => { state.gateResolution.lanes.orion = 'released'; }],
    ['a dropped lane verdict', (state) => { delete state.gateResolution.lanes.orion; }],
    ['a proof value in a verdict', (state) => { state.gateResolution.capabilities['db-access'].observed = 'SELECT 1'; }],
    ['an empty reason', (state) => { state.gateResolution.capabilities['db-access'].reason = ''; }],
    ['a conditional recon lane', (state) => { state.conditionalAgents.kalchas = ['browser-runtime']; }],
    ['unsorted gates', (state) => { state.conditionalAgents.charon = ['db-access', 'browser-runtime']; }],
    ['a gate outside the conditional map', (state) => { state.gateResolution.capabilities['source-access'] = { status: 'proven', basis: 'x', reason: 'x' }; }],
  ]) {
    const tampered = structuredClone(current);
    mutate(tampered);
    writeFileSync(statePath, `${JSON.stringify(tampered, null, 2)}\n`);
    expectThrow(() => getEngagementStatus(manifest), `state with ${label}`);
  }
  writeFileSync(statePath, `${JSON.stringify(current, null, 2)}\n`);
  assert(getEngagementStatus(manifest).revision === current.revision, 'restored resolved state was not accepted');
  for (const lane of ['atlas', 'charon', 'hermes', 'kalchas', 'metis', 'odysseus']) cleanupWorker(manifest, lane, tokens[lane], 'interrupted');
}

// A gate-unmet lane is omitted, not covered: the final-summary merge names it as a status
// reason and caps a completed summary at degraded, while a released lane adds no reason.
function testGateUnmetFinalSummary() {
  const lanes = ['kalchas', 'kleio', 'odysseus', 'orion', 'tiresias'];
  const fixture = createFixture('gate-unmet-summary', lanes);
  const { manifest } = fixture;
  bindDispatchableAgents(manifest, lanes, { orion: ['browser-runtime'], tiresias: ['source-access'] });
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding('gate-unmet-controller') });
  const kalchas = allocateWorker(manifest, 'kalchas', { controllerToken: controller.token, executionBinding: executionBinding('gate-unmet-kalchas') });
  const kleio = allocateWorker(manifest, 'kleio', { controllerToken: controller.token, executionBinding: executionBinding('gate-unmet-kleio') });
  arriveBarrier(manifest, 'kalchas', kalchas.token, 'discovery');
  const resolved = resolveConditionalGates(manifest, controller.token, {
    evidenceSha256: null,
    capabilities: {
      'browser-runtime': { status: 'unmet', basis: 'runtime-probe', reason: 'fixture verdict' },
      'source-access': { status: 'proven', basis: 'kalchas-evidence+path-check', reason: 'fixture verdict' },
    },
  });
  assert(JSON.stringify(resolved.lanes) === '{"orion":"gate-unmet","tiresias":"released"}', `unexpected gate-unmet fixture lanes: ${JSON.stringify(resolved.lanes)}`);
  mergeFinalSummary(fixture, kleio.token);
  const summary = readSolutionJson(fixture, 'final-summary.json');
  assert(summary.status === 'degraded' && JSON.stringify(summary.statusReasons) === '["gate-unmet:orion"]',
    `a gate-unmet lane was not a named final-summary gap: ${JSON.stringify({ status: summary.status, statusReasons: summary.statusReasons })}`);
  for (const [lane, token] of [['kalchas', kalchas.token], ['kleio', kleio.token], ['odysseus', controller.token]]) cleanupWorker(manifest, lane, token, 'interrupted');
}

function assertStateSchema(fixture, label) {
  const state = JSON.parse(readFileSync(fixture.statePath, 'utf8'));
  assert(validateStateSchema(state), `${label} violates engagement-state.schema.json: ${stateSchemaAjv.errorsText(validateStateSchema.errors)}`);
}

// Drives a Mode A engagement with a validator and one hunter to the start of deep-hunt-2,
// with an empty ledger snapshot recorded for proof and deep-proof-1.
function runToSecondDeepHunt(name) {
  const fixture = createFixture(name, ['hermes', 'kleio', 'minos', 'odysseus']);
  const { manifest } = fixture;
  const controller = allocateWorker(manifest, 'odysseus', { executionBinding: executionBinding(`${name}-controller`) });
  const tokens = { controller: controller.token };
  for (const lane of ['hermes', 'kleio', 'minos']) {
    tokens[lane] = allocateWorker(manifest, lane, { controllerToken: controller.token, executionBinding: executionBinding(`${name}-${lane}`) }).token;
  }
  advanceBarrier(manifest, 'odysseus', tokens.controller);
  arriveBarrier(manifest, 'hermes', tokens.hermes, 'hunting');
  advanceBarrier(manifest, 'odysseus', tokens.controller);
  arriveBarrier(manifest, 'minos', tokens.minos, 'proof');
  mergeEmptyLedger(fixture, tokens.minos, `${name}-proof`);
  advanceBarrier(manifest, 'odysseus', tokens.controller);
  expectThrowMessage(() => skipPhases(manifest, 'odysseus', tokens.controller, 'controller-budget'), 'phase deep-hunt-1 is not skippable', 'skip of the first deep-hunt pass');
  arriveBarrier(manifest, 'hermes', tokens.hermes, 'deep-hunt-1');
  advanceBarrier(manifest, 'odysseus', tokens.controller);
  arriveBarrier(manifest, 'minos', tokens.minos, 'deep-proof-1');
  // bug-ledger@2 is one complete document, so the next proof phase re-merges it.
  mergeEmptyLedger(fixture, tokens.minos);
  const state = getEngagementStatus(manifest);
  assert(state.ledgerSnapshots['deep-proof-1']?.newConfirmed.length === 0 &&
    JSON.stringify(state.ledgerSnapshots['deep-proof-1'].fragmentIds) === JSON.stringify([`${name}-proof`]) &&
    state.ledgerSnapshots.proof.mergedAt <= state.ledgerSnapshots['deep-proof-1'].mergedAt,
  'deep-proof-1 did not record its own snapshot of the re-merged ledger');
  advanceBarrier(manifest, 'odysseus', tokens.controller);
  assert(getEngagementStatus(manifest).currentPhase === 'deep-hunt-2', 'phase did not reach deep-hunt-2');
  return { fixture, tokens };
}

// Writes the empty ledger fragment when an id is given, then merges the canonical ledger.
function mergeEmptyLedger(fixture, token, fragmentId) {
  if (fragmentId) {
    const ledger = { $schema: 'argus/bug-ledger@2', schemaVersion: 2, engagementId: fixture.manifest.engagementId, bugs: [] };
    writeFragment(fixture.manifest, 'minos', token, 'solution/bug-ledger.json', fragmentId, `${JSON.stringify(ledger)}\n`);
  }
  mergeCanonical(fixture.manifest, 'minos', token, 'solution/bug-ledger.json');
}

// The final-summary merge derives its facts from a merged coverage result and the runner result.
// These fixtures have no Kalchas to publish the coverage inputs, so the helper seeds a complete,
// merge-recorded coverage result and a delivery-gate runner result; with the empty ledger every
// fact is clean, and the only status reasons left are the recorded phase skips.
function mergeFinalSummary(fixture, token) {
  const coverage = structuredClone(coverageResultFixture);
  coverage.engagementId = fixture.manifest.engagementId;
  coverage.surfaces.find((surface) => surface.surfaceId === 'SRF-UI-HOME').executed = true;
  coverage.criticalUnexecuted = [];
  coverage.overall.caseDepth = { plannedWeight: 5, executedWeight: 5, verifiedWeight: 5, coverage: 1, unplannedSurfaces: [], gaps: [] };
  const coverageContent = `${JSON.stringify(coverage, null, 2)}\n`;
  mkdirSync(join(fixture.root, 'solution'), { recursive: true });
  mkdirSync(join(fixture.root, 'reports'), { recursive: true });
  writeFileSync(join(fixture.root, 'solution', 'coverage-result.json'), coverageContent);
  writeFileSync(join(fixture.root, 'reports', 'argus-runner-result.json'), `${JSON.stringify(runnerResultFixture)}\n`);
  const state = JSON.parse(readFileSync(fixture.statePath, 'utf8'));
  state.merges['solution/coverage-result.json'] = { owner: 'kleio', fragments: 1, sha256: createHash('sha256').update(coverageContent).digest('hex'), mergedAt: new Date().toISOString() };
  writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);

  const summary = structuredClone(finalSummaryFixture);
  summary.engagementId = fixture.manifest.engagementId;
  Object.assign(summary, { status: 'completed', statusReasons: [], unproven: [] });
  summary.counts = { bugs: { confirmed: 0, suspected: 0, needsOracle: 0, duplicate: 0, rejected: 0, headline: 0 }, regression: { wired: 0, uncovered: [] }, automated: 0, evidence: 0 };
  summary.automationReview = { status: 'not-applicable', reviewId: null, round: null, blockers: 0, warnings: 0 };
  writeFragment(fixture.manifest, 'kleio', token, 'solution/final-summary.json', 'final-summary', `${JSON.stringify(summary)}\n`);
  mergeCanonical(fixture.manifest, 'kleio', token, 'solution/final-summary.json');
}

function readSolutionJson(fixture, name) {
  return JSON.parse(readFileSync(join(fixture.root, 'solution', name), 'utf8'));
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
    phasePlan: derivePhasePlan(orchestrationPlan, capabilityMatrix, 'A', selectedAgents, raci),
  });
  const manifestErrors = validateEngagementManifest(manifest);
  assert(manifestErrors.length === 0, `derived engagement manifest is invalid: ${manifestErrors.join('; ')}`);
  const initialized = initializeEngagementState(manifest);
  assert(initialized.state.schemaVersion === 3, 'new engagement state did not use schemaVersion 3');
  assert(!Object.hasOwn(initialized.state, 'migrations'), 'new engagement state retained a migration surface');
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

function expectThrowMessage(operation, expected, label) {
  let message = null;
  try { operation(); }
  catch (error) { message = error.message; }
  assert(message !== null, `${label} unexpectedly succeeded`);
  assert(message === expected, `${label} failed with "${message}" instead of "${expected}"`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
