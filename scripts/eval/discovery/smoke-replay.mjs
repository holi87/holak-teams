#!/usr/bin/env node
// Mode A regression replay smoke: case planning, runner-result classification, the per-bug
// fail-to-pass/specificity/flake summary, and three run.mjs protocols with the test-only stub
// adapter (scripts/fixtures/argus-eval/stub-adapter.mjs): a complete replay with same-port
// restarts, a replay adapter that writes no result, and a corpus whose probes disagree with the
// enabled seeds. Scripted harness validation only; no Argus model score is claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileJsonSchema } from '../../../argus/runtime/json-schema.mjs';
import { seeds as corpusSeeds, seedIds, startApplication } from './corpus/index.mjs';
import { normalizeConfig } from './lib/config.mjs';
import {
  caseName, classifyRunnerResult, evaluateReplayCase, infrastructureReplayCase, planReplayCases, readReplayResult, replayStatus,
  startApplicationOnPort, summarizeReplay, TEST_STUB_SANDBOX,
} from './lib/replay.mjs';
import { evalSchema, formatSchemaErrors, validateEval } from './lib/schemas.mjs';

const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url));
const STUB = fileURLToPath(new URL('../../fixtures/argus-eval/stub-adapter.mjs', import.meta.url));
const CORPUS_URL = pathToFileURL(fileURLToPath(new URL('./corpus/index.mjs', import.meta.url))).href;
const REQUEST_KEYS = ['case', 'frameworkRoot', 'replayRoot', 'resultPath', 'runId', 'runnerMode', 'schema', 'seconds', 'target'];
const PRIVATE_KEYS = ['truth', 'seed', 'seeds', 'build', 'enabledSeeds', 'faulty', 'enabled'];
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-replay-')));
const mode = path => statSync(path).mode & 0o777;
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Restores every sealed/ directory so a failed assertion never leaves an undeletable tree.
function reopen(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === 'sealed' && entry.isDirectory()) chmodSync(path, 0o700);
    if (entry.isDirectory() && !entry.isSymbolicLink()) reopen(path);
  }
}

const event = (caseId, category, status, bugId, expected = false) => ({ caseId, category, status, expected, lifecycle: 'n/a', bugId, reason: 'synthetic' });
function runnerResult(runnerMode, events, exitCode = 0) {
  const categories = { product: 0, automation: 0, infrastructure: 0, skip: 0, policy: 0 };
  for (const item of events) categories[item.category] += 1;
  return { $schema: 'argus/runner-result@1', schemaVersion: 1, mode: runnerMode, status: exitCode === 0 ? 'pass' : 'fail', exitCode,
    categories, events, generatedAt: '2026-01-01T00:00:00Z', deliveryGate: false, missingExpectedBugs: 0 };
}
const replayResult = (plan, fields = {}) => ({ state: 'valid', errors: [], result: {
  schema: 'argus-eval/replay-result@1', case: plan.case, runnerMode: plan.runnerMode, exitCode: 0, timedOut: false,
  sandbox: 'linux-bwrap', runnerResult: runnerResult(plan.runnerMode, [event('REG-0001', 'product', 'pass', 'BUG-0001')]), error: null, ...fields,
} });
const ok = { spawnError: null, exitCode: 0, signal: null, timedOut: false };
const cleanProbes = { mismatches: [], error: null };

const outputs = [];
try {
  // 1. Case plan: all-on and all-off per repeat, one baseline, then one case per truth seed.
  {
    const truth = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }];
    const plan = planReplayCases(truth, { repeats: 2, perSeedMatrix: true });
    assert.deepEqual(plan.map(caseName), ['all-on-0', 'all-on-1', 'all-off-0', 'all-off-1', 'all-off-baseline-0', 'only-alpha-0', 'only-beta-0', 'only-gamma-0']);
    assert.deepEqual(plan.map(item => item.runnerMode), ['defect-evidence', 'defect-evidence', 'candidate-regression', 'candidate-regression', 'baseline',
      'candidate-regression', 'candidate-regression', 'candidate-regression']);
    assert.deepEqual(plan.map(item => item.enabledSeeds), [['alpha', 'beta', 'gamma'], ['alpha', 'beta', 'gamma'], [], [], [], ['alpha'], ['beta'], ['gamma']]);
    assert.deepEqual(planReplayCases(truth, { repeats: 1, perSeedMatrix: false }).map(caseName), ['all-on-0', 'all-off-0', 'all-off-baseline-0']);
    assert.equal(planReplayCases(corpusSeeds, { repeats: 2, perSeedMatrix: true }).length, 5 + seedIds.length);
    assert.throws(() => planReplayCases(truth, { repeats: 0, perSeedMatrix: true }), /repeats/);
    assert.throws(() => planReplayCases([{}], { repeats: 1, perSeedMatrix: true }), /truth/);
    console.log('PASS  replay plan: all-on and all-off per repeat, one all-off-baseline, then only-<seedId> per truth seed');
  }

  // 2. Runner-result classification per bug, with the strongest outcome winning.
  {
    const doc = runnerResult('candidate-regression', [
      event('REG-0001', 'product', 'fail', 'BUG-0001'),
      event('REG-0002', 'product', 'pass', 'BUG-0002'),
      event('REG-0003', 'automation', 'fail', 'BUG-0003'),
      event('REG-0004', 'infrastructure', 'fail', 'BUG-0004'),
      event('REG-0005', 'policy', 'fail', 'BUG-0005'),
      event('REG-0006', 'skip', 'skipped', 'BUG-0006'),
      event('REG-0007', 'policy', 'denied', 'BUG-0007'),
      event('REG-0009a', 'product', 'pass', 'BUG-0009'),
      event('REG-0009b', 'automation', 'fail', 'BUG-0009'),
      event('REG-0010a', 'automation', 'fail', 'BUG-0010'),
      event('REG-0010b', 'product', 'fail', 'BUG-0010'),
      event('REG-0011a', 'product', 'pass', 'BUG-0011'),
      event('REG-0011b', 'skip', 'skipped', 'BUG-0011'),
      event('wrapper', 'infrastructure', 'fail', null),
      event('TST-0001', 'product', 'fail', null),
    ], 10);
    const { bugs, infrastructureFailures } = classifyRunnerResult(doc, { bugIds: ['BUG-0008', 'BUG-0001'] });
    assert.deepEqual(bugs, {
      'BUG-0001': 'caught', 'BUG-0002': 'passed', 'BUG-0003': 'broken', 'BUG-0004': 'broken', 'BUG-0005': 'broken', 'BUG-0006': 'skipped',
      'BUG-0007': 'skipped', 'BUG-0008': 'missing', 'BUG-0009': 'broken', 'BUG-0010': 'caught', 'BUG-0011': 'skipped',
    });
    assert.deepEqual(Object.keys(bugs), [...Object.keys(bugs)].sort(), 'bug outcomes are keyed in id order');
    assert.equal(infrastructureFailures, 2, 'failed infrastructure events count whether or not they carry a bug');
    assert.throws(() => classifyRunnerResult({ ...doc, mode: 'nightly' }), /runner-result@1/);
    console.log('PASS  runner-result classification: caught, passed, broken, skipped, missing; caught > broken > skipped > passed');
  }

  // 3. Case evaluation: consistency checks and status precedence.
  {
    const [allOn] = planReplayCases([{ id: 'alpha' }], { repeats: 1, perSeedMatrix: false });
    const base = { plan: allOn, outcome: ok, probeCheck: cleanProbes, bugIds: ['BUG-0001', 'BUG-0002'], seconds: 30 };
    const completed = evaluateReplayCase({ ...base, replayResult: replayResult(allOn) });
    assert.deepEqual(completed, { case: 'all-on', k: 0, runnerMode: 'defect-evidence', exitCode: 0, timedOut: false, status: 'completed',
      bugs: { 'BUG-0001': 'passed', 'BUG-0002': 'missing' }, infrastructureFailures: 0, sandbox: 'linux-bwrap', reason: null });
    const status = (fields, extra = {}) => evaluateReplayCase({ ...base, ...extra, replayResult: fields === null ? readReplayResult(join(work, 'absent.json')) : replayResult(allOn, fields) });
    assert.equal(status({}, { probeCheck: null }).status, 'completed', 'a corpus without probe() skips the re-verification');
    const harness = status({}, { probeCheck: { mismatches: ['alpha'], error: null } });
    assert.deepEqual([harness.status, harness.reason, harness.bugs['BUG-0001']], ['harness-error', 'seed probes disagree with the enabled seeds: alpha', 'passed']);
    assert.equal(status({}, { probeCheck: { mismatches: [], error: 'seed probe alpha failed: boom' } }).status, 'harness-error');
    assert.equal(status({ timedOut: true, exitCode: null, runnerResult: null }, { probeCheck: { mismatches: ['alpha'], error: null } }).status, 'harness-error', 'harness errors take precedence');
    const killed = status(null, { outcome: { spawnError: null, exitCode: null, signal: 'SIGKILL', timedOut: true } });
    assert.deepEqual([killed.status, killed.timedOut], ['timed-out', true]);
    assert.match(killed.reason, /killed the replay adapter 60 s after the 30 s runner budget/);
    assert.deepEqual([status({ timedOut: true, exitCode: null, runnerResult: null }).status], ['timed-out']);
    const missing = status(null, { outcome: { ...ok, exitCode: 3 } });
    assert.deepEqual([missing.status, missing.reason], ['adapter-error', 'the replay adapter exited with status 3; the adapter wrote no replay result']);
    assert.match(evaluateReplayCase({ ...base, outcome: { ...ok, spawnError: 'ENOENT' }, probeCheck: null, replayResult: null }).reason, /could not start: ENOENT/);
    assert.match(status({ case: 'all-off' }).reason, /answers case all-off/);
    assert.match(status({ runnerResult: runnerResult('baseline', []) }).reason, /mode baseline, not defect-evidence/);
    assert.match(status({ runnerResult: { schemaVersion: 1 } }).reason, /violates runner-result@1/);
    assert.match(status({ exitCode: 10 }).reason, /exited with 10, but its result records exit code 0/);
    assert.match(status({ runnerResult: null }).reason, /carries no runner result/);
    const refused = status({ sandbox: null, exitCode: null, runnerResult: null, error: 'unsupported-sandbox' });
    assert.deepEqual([refused.status, refused.reason], ['adapter-error', 'the replay adapter reported: unsupported-sandbox']);
    assert.match(status({ sandbox: TEST_STUB_SANDBOX }).reason, /without an OS sandbox \(unsandboxed-test-stub\)/);
    assert.equal(status({ sandbox: TEST_STUB_SANDBOX }, { allowTestStub: true }).status, 'completed', 'testMode accepts the stub adapter');
    assert.deepEqual(infrastructureReplayCase(allOn, 'port 1 busy'), { ...completed, exitCode: null, status: 'infrastructure', bugs: {}, sandbox: null, reason: 'port 1 busy' });
    const validateCase = compileJsonSchema({ $defs: evalSchema('private-runs').$defs, $ref: '#/$defs/replayCase' });
    for (const record of [completed, harness, killed, missing, refused]) assert.deepEqual(validateCase(record), [], `${record.status} fits the private-runs replay case slot`);
    assert.deepEqual([replayStatus([completed, completed]), replayStatus([completed, missing]), replayStatus([missing]), replayStatus([])], ['completed', 'partial', 'unavailable', 'unavailable']);

    const resultFile = join(work, 'replay-result.json');
    writeFileSync(resultFile, JSON.stringify(replayResult(allOn).result));
    assert.equal(readReplayResult(resultFile).state, 'valid');
    symlinkSync(resultFile, join(work, 'replay-link.json'));
    assert.match(readReplayResult(join(work, 'replay-link.json')).errors[0], /not a regular file/);
    writeFileSync(join(work, 'replay-broken.json'), '{');
    assert.match(readReplayResult(join(work, 'replay-broken.json')).errors[0], /not valid JSON/);
    writeFileSync(join(work, 'replay-schema.json'), JSON.stringify({ ...replayResult(allOn).result, sandbox: null, error: null }));
    assert.match(readReplayResult(join(work, 'replay-schema.json')).errors[0], /violates replay-result@1/, 'a result without a sandbox must name its error');
    console.log('PASS  replay case evaluation: harness-error > timed-out > adapter-error > completed; request, mode, exit code and sandbox consistency');
  }

  // 4. Summary: fail-to-pass, flake, specificity and false alarms over completed cases only.
  {
    const entry = (label, k, bugs, fields = {}) => ({ case: label, k, runnerMode: 'candidate-regression', exitCode: 0, timedOut: false, status: 'completed',
      bugs, infrastructureFailures: 0, sandbox: 'linux-bwrap', reason: null, ...fields });
    const replay = { status: 'partial', frameworkRoot: '/x/artifacts', reason: 'synthetic', cases: [
      entry('all-on', 0, { 'BUG-0001': 'caught', 'BUG-0002': 'caught', 'BUG-0003': 'caught' }, { runnerMode: 'defect-evidence' }),
      entry('all-on', 1, { 'BUG-0001': 'caught', 'BUG-0002': 'passed', 'BUG-0003': 'caught' }, { runnerMode: 'defect-evidence' }),
      entry('all-off', 0, { 'BUG-0001': 'passed', 'BUG-0002': 'passed', 'BUG-0003': 'broken' }),
      entry('all-off', 1, { 'BUG-0001': 'passed', 'BUG-0002': 'passed', 'BUG-0003': 'passed' }),
      entry('all-off-baseline', 0, { 'BUG-0001': 'missing', 'BUG-0002': 'missing', 'BUG-0003': 'missing' }, { runnerMode: 'baseline' }),
      entry('only-alpha', 0, { 'BUG-0001': 'caught', 'BUG-0002': 'passed', 'BUG-0003': 'caught' }),
      entry('only-beta', 0, { 'BUG-0001': 'passed', 'BUG-0002': 'passed', 'BUG-0003': 'caught' }),
      entry('only-gamma', 0, { 'BUG-0001': 'caught', 'BUG-0004': 'caught' }, { status: 'harness-error', reason: 'synthetic' }),
    ] };
    const summary = summarizeReplay(replay);
    assert.deepEqual(summary, { status: 'partial', baselineGreenOnFix: true, bugs: {
      'BUG-0001': { failsOnFaulty: true, passesOnFix: true, flaky: false, specificTo: ['alpha'], falseAlarm: false },
      'BUG-0002': { failsOnFaulty: false, passesOnFix: true, flaky: true, specificTo: [], falseAlarm: false },
      'BUG-0003': { failsOnFaulty: true, passesOnFix: false, flaky: true, specificTo: ['alpha', 'beta'], falseAlarm: true },
      'BUG-0004': { failsOnFaulty: false, passesOnFix: false, flaky: false, specificTo: [], falseAlarm: false },
    } }, 'a harness-error case is recorded but never counted');
    const incomplete = { ...replay, cases: replay.cases.map(item => (item.case === 'all-off' && item.k === 1 ? { ...item, status: 'infrastructure', bugs: {} } : item)) };
    assert.equal(summarizeReplay(incomplete).bugs['BUG-0001'].passesOnFix, false, 'every all-off repeat must complete');
    const red = { ...replay, cases: replay.cases.map(item => (item.case === 'all-off-baseline' ? { ...item, exitCode: 10 } : item)) };
    assert.equal(summarizeReplay(red).baselineGreenOnFix, false);
    const noBaseline = { ...replay, cases: replay.cases.filter(item => item.case !== 'all-off-baseline') };
    assert.equal(summarizeReplay(noBaseline).baselineGreenOnFix, false);
    assert.equal(summarizeReplay(null), null);
    console.log('PASS  replay summary: failsOnFaulty, passesOnFix, flaky, specificTo, falseAlarm and baselineGreenOnFix over completed cases');
  }

  // 5. Configuration: replay defaults to on with Mode A and records only its own settings.
  {
    const raw = { schema: 'argus-eval/comparison-config@2', variants: [{ name: 'stub', revision: '0'.repeat(40), command: [process.execPath, STUB] }], repeats: 2 };
    const normalize = (change, env = {}) => normalizeConfig({ ...raw, ...change }, { baseDir: work, env });
    const validateConfig = compileJsonSchema({ $defs: evalSchema('private-runs').$defs, $ref: '#/$defs/config' });
    const cases = [
      [{ modes: ['A'] }, { enabled: true, repeats: 2, perSeedMatrix: true, secondsPerRunner: 1800 }],
      [{}, { enabled: false }],
      [{ modes: ['A'], replay: { enabled: false, repeats: 3 } }, { enabled: false }],
      [{ modes: ['B', 'A'], replay: { repeats: 5, perSeedMatrix: false, secondsPerRunner: 60 } }, { enabled: true, repeats: 5, perSeedMatrix: false, secondsPerRunner: 60 }],
      [{ modes: ['B'], replay: { repeats: 3 } }, { enabled: false }],
    ];
    for (const [change, expected] of cases) {
      const config = normalize(change);
      assert.deepEqual(config.replay, expected, JSON.stringify(change));
      assert.deepEqual(validateConfig(config), [], `normalized replay fits private-runs@2: ${JSON.stringify(change)}`);
    }
    const rejects = (change, pattern, env = {}) => assert.throws(() => normalize(change, env), pattern);
    rejects({ modes: ['B'], replay: { enabled: true } }, /replay\.enabled requires mode A/);
    rejects({ modes: ['A'], replay: { repeats: 0 } }, /repeats/);
    rejects({ modes: ['A'], replay: { repeats: 6 } }, /repeats/);
    rejects({ modes: ['A'], replay: { secondsPerRunner: 59 } }, /secondsPerRunner/);
    rejects({ modes: ['A'], replay: { secondsPerRunner: 7201 } }, /secondsPerRunner/);
    rejects({ modes: ['A'], replay: { perSeedMatrix: 'yes' } }, /perSeedMatrix/);
    rejects({ modes: ['A'], replay: { cases: [] } }, /additional property cases/);
    const test = normalize({ modes: ['A'], testMode: true, secondsByMode: { A: 1 }, replay: { secondsPerRunner: 1 } }, { ARGUS_EVAL_SMOKE: '1' });
    assert.equal(test.replay.secondsPerRunner, 1, 'testMode lowers the runner budget minimum to 1 s');
    console.log('PASS  comparison-config@2 replay: on by default with mode A, {enabled: false} otherwise, repeats 1-5, runner budget 60-7200 s (1 s in testMode)');
  }

  // 6. Same-port restarts: EADDRINUSE is retried, then rethrown; other errors are not retried.
  {
    const busy = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    let attempts = 0;
    const flaky = async options => {
      attempts += 1;
      if (attempts < 3) throw busy();
      return { port: options.port };
    };
    assert.deepEqual(await startApplicationOnPort(flaky, { port: 4000 }, { delayMs: 1 }), { port: 4000 });
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(startApplicationOnPort(async () => { attempts += 1; throw busy(); }, { port: 4000 }, { delayMs: 1 }), { code: 'EADDRINUSE' });
    assert.equal(attempts, 6, 'one attempt plus five retries');
    attempts = 0;
    await assert.rejects(startApplicationOnPort(async () => { attempts += 1; throw new Error('boom'); }, { port: 4000 }, { delayMs: 1 }), /boom/);
    assert.equal(attempts, 1);
    await assert.rejects(startApplicationOnPort(flaky, { port: 0 }), /hunt port/);
    const blocker = createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    await assert.rejects(startApplicationOnPort(startApplication, { seed: 1, enabledSeeds: [], port }, { retries: 2, delayMs: 10 }), { code: 'EADDRINUSE' });
    await new Promise(resolve => blocker.close(resolve));
    const app = await startApplicationOnPort(startApplication, { seed: 1, enabledSeeds: [], port });
    assert.equal(app.port, port, 'the released port is reused');
    await app.close();
    console.log('PASS  same-port restart: EADDRINUSE retried 5 x 200 ms, then an infrastructure failure; the released port is reused');
  }

  const variant = (name, args = []) => ({ name, revision: '0'.repeat(40), command: [process.execPath, STUB, ...args] });
  const base = { schema: 'argus-eval/comparison-config@2', testMode: true, workRoot: work, secondsByMode: { A: 60, B: 60 }, adapterEnv: ['ARGUS_EVAL_SMOKE'] };
  const harness = (name, config) => {
    const configPath = join(work, `${name}.json`);
    writeFileSync(configPath, JSON.stringify({ ...base, ...config }));
    const run = spawnSync(process.execPath, [RUN, configPath, join(work, `${name}-output`)], { encoding: 'utf8', timeout: 600000,
      env: { ...process.env, ARGUS_EVAL_SMOKE: '1' } });
    const line = run.stdout.trim().split('\n').at(-1);
    assert(line, `${name}: run.mjs printed no summary (status ${run.status}): ${run.stderr}`);
    const summary = JSON.parse(line);
    const output = dirname(dirname(summary.privateResults));
    outputs.push(output);
    const document = JSON.parse(readFileSync(summary.privateResults, 'utf8'));
    const errors = validateEval('private-runs', document);
    assert.deepEqual(errors, [], `${name}: private-runs@2 violation: ${formatSchemaErrors(errors)}`);
    return { status: run.status, stderr: run.stderr, summary, output, runs: document.runs };
  };
  const requestsOf = (output, run) => {
    const dir = join(output, 'sealed', 'runs', run.runId, 'replay-requests');
    return readdirSync(dir).sort().map(file => ({ file, path: join(dir, file), request: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
  };

  // 7. Protocol: modes A and B, both builds, 2 repeats. Only the faulty Mode A runs replay, each
  // with 2 all-on, 2 all-off, 1 baseline and 22 single-seed cases on the hunt port.
  {
    const { status, stderr, summary, output, runs } = harness('replay', {
      variants: [variant('stub')], modes: ['A', 'B'], builds: ['faulty', 'corrected'], repeats: 2, seeds: [11, 22], replay: { secondsPerRunner: 60 },
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual([summary.runs, summary.statuses, summary.replays], [8, { 'awaiting-adjudication': 8 }, { completed: 2 }]);
    assert.equal(mode(join(output, 'sealed')), 0o700, 'sealed/ is reopened after the replays');
    const replayed = runs.filter(run => run.replay !== null);
    assert.deepEqual(replayed.map(run => run.runId), ['r0-A-faulty-stub', 'r1-A-faulty-stub']);
    for (const run of runs) assert.equal(run.contamination.status, 'clean', `${run.runId}: the stub leaves no corpus traces`);
    for (const run of runs.filter(item => item.replay === null)) {
      assert(run.mode === 'B' || run.build === 'corrected', `${run.runId} should have been replayed`);
      if (run.build === 'faulty') assert.equal(run.extraction.framework.root, 'regression', 'a Mode B framework is found but never replayed');
    }
    const expectedCases = planReplayCases(corpusSeeds, { repeats: 2, perSeedMatrix: true });
    let restarts = 0;
    for (const run of replayed) {
      assert.deepEqual(run.extraction.findings.map(item => [item.id, item.origin[0], item.wired, item.testId]),
        [['BUG-0001', 'ATA-001', true, 'REG-0001'], ['BUG-0002', 'ATA-002', true, 'REG-0002']]);
      assert.deepEqual([run.replay.status, run.replay.reason, run.replay.frameworkRoot], ['completed', null, join(run.artifactRoot, 'regression')]);
      assert.deepEqual(run.replay.cases.map(item => [item.case, item.k, item.runnerMode]), expectedCases.map(item => [item.case, item.k, item.runnerMode]));
      for (const item of run.replay.cases) {
        assert.equal(item.status, 'completed', `${run.runId} ${caseName(item)}: ${item.reason}`);
        assert.deepEqual([item.sandbox, item.infrastructureFailures, item.timedOut], [TEST_STUB_SANDBOX, 0, false]);
      }
      const byName = Object.fromEntries(run.replay.cases.map(item => [caseName(item), item]));
      assert.deepEqual(byName['all-on-0'].bugs, { 'BUG-0001': 'caught', 'BUG-0002': 'caught' });
      assert.deepEqual([byName['all-on-0'].exitCode, byName['all-off-0'].exitCode], [0, 10]);
      assert.deepEqual(byName['all-off-1'].bugs, { 'BUG-0001': 'passed', 'BUG-0002': 'caught' });
      assert.deepEqual([byName['all-off-baseline-0'].bugs, byName['all-off-baseline-0'].exitCode], [{ 'BUG-0001': 'missing', 'BUG-0002': 'missing' }, 0]);
      assert.deepEqual(byName['only-quantity-boundary-0'].bugs, { 'BUG-0001': 'caught', 'BUG-0002': 'caught' });

      const replaySummary = summarizeReplay(run.replay);
      assert.deepEqual(replaySummary, { status: 'completed', baselineGreenOnFix: true, bugs: {
        'BUG-0001': { failsOnFaulty: true, passesOnFix: true, flaky: false, specificTo: ['quantity-boundary'], falseAlarm: false },
        'BUG-0002': { failsOnFaulty: true, passesOnFix: false, flaky: false, specificTo: [...seedIds], falseAlarm: true },
      } });

      // Public replay requests: exact keys, no private data, physical paths outside the artifact root.
      const active = join(output, 'active', run.runId);
      const requests = requestsOf(output, run);
      assert.deepEqual(requests.map(item => item.file), expectedCases.map(item => `${caseName(item)}.json`).sort());
      for (const { file, path, request } of requests) {
        const name = file.slice(0, -'.json'.length);
        assert.deepEqual(Object.keys(request).sort(), REQUEST_KEYS, `${name}: replay request keys`);
        assert.deepEqual(PRIVATE_KEYS.filter(key => key in request), []);
        const rest = JSON.stringify(request).replaceAll(request.case, '');
        for (const seed of corpusSeeds) {
          assert(!rest.includes(seed.id), `${name}: the request names seed ${seed.id} outside its case label`);
          assert(!rest.includes(seed.criterion), `${name}: the request carries a seed criterion`);
        }
        assert.equal(mode(path), 0o600);
        assert.equal(request.target, run.url, `${name}: every case reuses the hunt URL and port`);
        assert.equal(request.frameworkRoot, join(active, 'artifacts', 'regression'));
        assert.equal(request.replayRoot, join(active, 'replay', name));
        assert.equal(request.resultPath, join(active, 'replay', `${name}.result.json`));
        assert(!inside(join(active, 'artifacts'), request.replayRoot), `${name}: replayRoot is inside the artifact root`);
        assert(!inside(request.replayRoot, request.resultPath), `${name}: the result path is inside the replay root`);
        assert.equal(request.seconds, 60);
        const copied = join(output, 'sealed', 'runs', run.runId, 'replay', name);
        assert(existsSync(join(copied, 'reports', 'argus-runner-result.json')), `${name}: the replay root holds the runner result`);
        if (process.getuid?.() !== 0) assert.equal(readFileSync(join(copied, 'seal-state.txt'), 'utf8').trim(), 'sealed:EACCES', `${name}: sealed/ is closed during the replay`);
        restarts += 1;
      }
      assert.equal(mode(join(output, 'sealed', 'runs', run.runId, 'replay')), 0o700);
    }
    assert(restarts >= 24, `only ${restarts} same-port restarts`);
    console.log(`PASS  ${restarts} replay cases restart the application on the hunt port: BUG-0001 fails on faulty, passes on the fix and is specific to quantity-boundary; BUG-0002 is a false alarm; only faulty Mode A runs replay`);
  }

  // 8. A replay adapter that writes no result: every case is an adapter error.
  {
    const { status, stderr, summary, runs } = harness('no-result', {
      variants: [variant('stub', ['--behavior', 'replay-no-result'])], modes: ['A'], builds: ['faulty'], repeats: 2,
      replay: { repeats: 1, perSeedMatrix: false, secondsPerRunner: 60 },
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(summary.replays, { unavailable: 2 });
    for (const run of runs) {
      assert.deepEqual([run.replay.status, run.replay.reason], ['unavailable', '3 of 3 replay cases did not complete (adapter-error)']);
      for (const item of run.replay.cases) {
        assert.equal(item.status, 'adapter-error');
        assert.equal(item.reason, 'the replay adapter exited with status 0; the adapter wrote no replay result');
      }
      assert.deepEqual(summarizeReplay(run.replay), { status: 'unavailable', baselineGreenOnFix: false, bugs: {} });
    }
    console.log('PASS  a replay adapter that writes no replay result gives adapter-error cases and an unavailable replay');
  }

  // 9. A corpus whose probe disagrees with the enabled seeds: every case is a harness error.
  {
    const corpusModule = join(work, 'lying-corpus.mjs');
    writeFileSync(corpusModule, `export * from ${JSON.stringify(CORPUS_URL)};
import { probe as realProbe } from ${JSON.stringify(CORPUS_URL)};
export async function probe(id, url, contract) {
  const observed = await realProbe(id, url, contract);
  return id === 'quantity-boundary' ? !observed : observed;
}
`);
    const { status, stderr, runs } = harness('lying', {
      variants: [variant('stub')], modes: ['A'], builds: ['faulty'], repeats: 2, corpusModule,
      replay: { repeats: 1, perSeedMatrix: false, secondsPerRunner: 60 },
    });
    assert.equal(status, 0, stderr);
    for (const run of runs) {
      assert.equal(run.replay.status, 'unavailable');
      for (const item of run.replay.cases) {
        assert.deepEqual([item.status, item.reason], ['harness-error', 'seed probes disagree with the enabled seeds: quantity-boundary']);
      }
      assert.deepEqual(Object.values(summarizeReplay(run.replay).bugs).map(bug => bug.failsOnFaulty), [false, false]);
    }
    console.log('PASS  a seed probe that disagrees with the enabled seeds gives harness-error cases that never count');
  }
} finally {
  for (const output of outputs) if (existsSync(output)) reopen(output);
  rmSync(work, { recursive: true, force: true });
}
