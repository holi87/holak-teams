// Mode A regression replay. After a faulty Mode A hunt that left a regression framework, the
// evaluator replays that frozen suite through the adapter's sandboxed `replay` phase against
// fresh applications on the hunt's own port: every seed enabled, none enabled, and each seed
// alone. A replay request names only the case, the runner mode, the framework to copy, the
// target, and the budget; it never carries truth, seeds, or enabled flags. The runner results
// are classified per ledger bug here. Mapping bugs to seeds is scoring's job (final verdicts).
import { lstatSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { formatSchemaErrors, validateArgus, validateEval } from './schemas.mjs';

// The evaluator kills the adapter group this long after the runner budget; the adapter itself
// enforces the budget on the runner.
export const REPLAY_KILL_GRACE_SECONDS = 60;
// A runner result may be up to 5 MB; the wrapper adds little.
export const MAX_REPLAY_RESULT_BYTES = 6 * 1024 * 1024;
export const OS_SANDBOXES = Object.freeze(['macos-sandbox-exec', 'linux-bwrap']);
// Reported only by the smoke-test stub adapter; accepted only in testMode.
export const TEST_STUB_SANDBOX = 'unsandboxed-test-stub';
export const CASE_STATUSES = Object.freeze(['completed', 'timed-out', 'adapter-error', 'infrastructure', 'harness-error']);
export const BUG_OUTCOMES = Object.freeze(['caught', 'passed', 'broken', 'skipped', 'missing']);
const ONLY = 'only-';
// When several events of one runner result carry the same bug, the strongest outcome wins:
// a product failure (caught) over a broken case, a broken case over a skip, a skip over a pass.
const PRECEDENCE = Object.freeze(['missing', 'passed', 'skipped', 'broken', 'caught']);

const byId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sortedObject = entries => Object.fromEntries([...entries].sort(([left], [right]) => byId(left, right)));

// The ordered replay cases of one faulty run: 'all-on' x repeats (defect-evidence), 'all-off' x
// repeats (candidate-regression), 'all-off-baseline' x 1 (baseline), then, with perSeedMatrix,
// 'only-<seedId>' x 1 per truth seed in truth order (candidate-regression). `k` numbers the
// repeats of one case from 0. enabledSeeds stays evaluator-side; it never enters a request.
export function planReplayCases(truth, { repeats, perSeedMatrix }) {
  if (!Array.isArray(truth) || truth.some(seed => typeof seed?.id !== 'string' || !seed.id)) throw new Error('planReplayCases needs the run truth (seeds with an id)');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('replay repeats must be an integer from 1 through 5');
  const seedIds = truth.map(seed => seed.id);
  const cases = [];
  for (let k = 0; k < repeats; k++) cases.push({ case: 'all-on', k, runnerMode: 'defect-evidence', enabledSeeds: [...seedIds] });
  for (let k = 0; k < repeats; k++) cases.push({ case: 'all-off', k, runnerMode: 'candidate-regression', enabledSeeds: [] });
  cases.push({ case: 'all-off-baseline', k: 0, runnerMode: 'baseline', enabledSeeds: [] });
  if (perSeedMatrix) for (const id of seedIds) cases.push({ case: `${ONLY}${id}`, k: 0, runnerMode: 'candidate-regression', enabledSeeds: [id] });
  return cases;
}

// '<case>-<k>': the request file, replay root and result file stem of one case.
export const caseName = ({ case: label, k }) => `${label}-${k}`;

function eventOutcome(event) {
  if (event.status === 'fail') return event.category === 'product' ? 'caught' : 'broken';
  return event.status === 'pass' ? 'passed' : 'skipped';
}

// Classifies a valid argus/runner-result@1 document per bug: an event with a non-null bugId
// that failed with category product is 'caught', one that passed is 'passed', a failure in any
// other category (automation, infrastructure, policy) is 'broken', and a skipped or denied
// event is 'skipped'. Every ID in `bugIds` (the run's ledger bugs) without an event is
// 'missing'. infrastructureFailures counts the failed infrastructure events, bug-linked or not.
export function classifyRunnerResult(doc, { bugIds = [] } = {}) {
  const errors = validateArgus('runner-result', doc);
  if (errors.length) throw new Error(`runner result violates runner-result@1: ${formatSchemaErrors(errors)}`);
  const bugs = new Map(bugIds.map(id => [id, 'missing']));
  let infrastructureFailures = 0;
  for (const event of doc.events) {
    if (event.category === 'infrastructure' && event.status === 'fail') infrastructureFailures += 1;
    if (event.bugId === null) continue;
    const outcome = eventOutcome(event);
    if (PRECEDENCE.indexOf(outcome) > PRECEDENCE.indexOf(bugs.get(event.bugId) ?? 'missing')) bugs.set(event.bugId, outcome);
  }
  return { bugs: sortedObject(bugs), infrastructureFailures };
}

// Reads an adapter's argus-eval/replay-result@1 from outside the replay root.
export function readReplayResult(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { state: 'missing', errors: ['the adapter wrote no replay result'], result: null };
  }
  const invalid = message => ({ state: 'invalid', errors: [message], result: null });
  if (stat.isSymbolicLink() || !stat.isFile()) return invalid('the replay result is not a regular file');
  if (stat.size > MAX_REPLAY_RESULT_BYTES) return invalid(`the replay result exceeds ${MAX_REPLAY_RESULT_BYTES} bytes`);
  let result;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return invalid(`the replay result is not valid JSON: ${error.message}`);
  }
  const errors = validateEval('replay-result', result);
  if (errors.length) return invalid(`the replay result violates replay-result@1: ${formatSchemaErrors(errors)}`);
  return { state: 'valid', errors: [], result };
}

const blankCase = plan => ({
  case: plan.case, k: plan.k, runnerMode: plan.runnerMode, exitCode: null, timedOut: false,
  status: 'adapter-error', bugs: {}, infrastructureFailures: 0, sandbox: null, reason: null,
});

// A case whose application could not listen on the hunt port again: nothing was replayed.
export function infrastructureReplayCase(plan, reason) {
  return { ...blankCase(plan), status: 'infrastructure', reason };
}

// The private record of one replayed case. `outcome` is the adapter process outcome
// ({spawnError, exitCode, timedOut}, timedOut when the evaluator killed the group),
// `replayResult` the readReplayResult() answer, and `probeCheck` the verifySeedProbes() answer
// (null when the corpus has no probe()). Status precedence: harness-error (the application did
// not behave as the case's enabled seeds require), timed-out, adapter-error (no, invalid, or
// inconsistent result, an adapter error, or a replay outside an OS sandbox), completed. Bug
// outcomes are recorded whenever a valid runner result for the case's mode came back; only
// completed cases count in summarizeReplay().
export function evaluateReplayCase({ plan, outcome, replayResult, probeCheck = null, bugIds = [], allowTestStub = false, seconds }) {
  const record = blankCase(plan);
  const problems = [];
  const result = replayResult?.state === 'valid' ? replayResult.result : null;
  if (outcome.spawnError) {
    problems.push(`the replay adapter could not start: ${outcome.spawnError}`);
  } else if (!result) {
    const exit = outcome.exitCode === null ? `was killed${outcome.signal ? ` by ${outcome.signal}` : ''}` : `exited with status ${outcome.exitCode}`;
    problems.push(`the replay adapter ${exit}; ${(replayResult?.errors ?? ['the adapter wrote no replay result']).join('; ')}`);
  } else {
    Object.assign(record, { exitCode: result.exitCode, timedOut: result.timedOut, sandbox: result.sandbox });
    if (result.case !== plan.case || result.runnerMode !== plan.runnerMode) {
      problems.push(`the replay result answers case ${result.case} (${result.runnerMode}), not ${plan.case} (${plan.runnerMode})`);
    } else if (result.runnerResult !== null) {
      const errors = validateArgus('runner-result', result.runnerResult);
      if (errors.length) {
        problems.push(`the runner result violates runner-result@1: ${formatSchemaErrors(errors)}`);
      } else if (result.runnerResult.mode !== plan.runnerMode) {
        problems.push(`the runner result is for mode ${result.runnerResult.mode}, not ${plan.runnerMode}`);
      } else {
        Object.assign(record, classifyRunnerResult(result.runnerResult, { bugIds }));
        if (result.exitCode !== result.runnerResult.exitCode) problems.push(`the runner exited with ${result.exitCode}, but its result records exit code ${result.runnerResult.exitCode}`);
      }
    }
    if (result.error) problems.push(`the replay adapter reported: ${result.error}`);
    else if (result.runnerResult === null && !result.timedOut) problems.push('the replay result carries no runner result');
    const sandboxed = OS_SANDBOXES.includes(result.sandbox) || (allowTestStub && result.sandbox === TEST_STUB_SANDBOX);
    if (result.sandbox !== null && !sandboxed) problems.push(`the replay ran without an OS sandbox (${result.sandbox})`);
  }
  if (outcome.timedOut) record.timedOut = true;
  if (probeCheck && (probeCheck.error || probeCheck.mismatches.length)) {
    const detail = probeCheck.error ?? `seed probes disagree with the enabled seeds: ${probeCheck.mismatches.join(', ')}`;
    return { ...record, status: 'harness-error', reason: detail };
  }
  if (record.timedOut) {
    const who = outcome.timedOut ? `the evaluator killed the replay adapter ${REPLAY_KILL_GRACE_SECONDS} s after the ${seconds} s runner budget` : `the runner exceeded its ${seconds} s budget`;
    return { ...record, status: 'timed-out', reason: [who, ...problems].join('; ') };
  }
  if (problems.length) return { ...record, status: 'adapter-error', reason: problems.join('; ') };
  return { ...record, status: 'completed' };
}

// 'completed' when every case completed, 'partial' when some did, otherwise 'unavailable'.
export function replayStatus(cases) {
  const completed = cases.filter(entry => entry.status === 'completed').length;
  if (completed === 0) return 'unavailable';
  return completed === cases.length ? 'completed' : 'partial';
}

// Per bug of a run's replay (null when the run was not replayed), over completed cases only:
// - failsOnFaulty: caught in every all-on repeat (every repeat must have completed);
// - passesOnFix: passed in every all-off repeat (every repeat must have completed);
// - flaky: the outcome differs between completed repeats of one case;
// - specificTo: the seed IDs whose completed only-<seedId> case caught it, in case order;
// - falseAlarm: caught or broken in any completed all-off repeat.
// baselineGreenOnFix is true when the all-off-baseline case completed with exit code 0 (a
// completed case's exit code equals its runner result's). A bug that no valid runner result
// named has no entry.
export function summarizeReplay(replay) {
  if (replay === null || replay === undefined) return null;
  const done = entry => entry.status === 'completed';
  const outcomeOf = (entry, id) => entry.bugs[id] ?? 'missing';
  const groups = new Map();
  for (const entry of replay.cases) groups.set(entry.case, [...(groups.get(entry.case) ?? []), entry]);
  const allOn = groups.get('all-on') ?? [];
  const allOff = groups.get('all-off') ?? [];
  const ids = [...new Set(replay.cases.flatMap(entry => Object.keys(entry.bugs)))].sort(byId);
  const bugs = {};
  for (const id of ids) {
    bugs[id] = {
      failsOnFaulty: allOn.length > 0 && allOn.every(entry => done(entry) && outcomeOf(entry, id) === 'caught'),
      passesOnFix: allOff.length > 0 && allOff.every(entry => done(entry) && outcomeOf(entry, id) === 'passed'),
      flaky: [...groups.values()].some(group => new Set(group.filter(done).map(entry => outcomeOf(entry, id))).size > 1),
      specificTo: replay.cases
        .filter(entry => entry.case.startsWith(ONLY) && done(entry) && outcomeOf(entry, id) === 'caught')
        .map(entry => entry.case.slice(ONLY.length)),
      falseAlarm: allOff.some(entry => done(entry) && ['caught', 'broken'].includes(outcomeOf(entry, id))),
    };
  }
  const baseline = replay.cases.find(entry => entry.case === 'all-off-baseline' && done(entry));
  return { status: replay.status, baselineGreenOnFix: baseline !== undefined && baseline.exitCode === 0, bugs };
}

// Starts the application on the hunt's port. A same-port restart retries briefly while the
// previous listener releases the port; EADDRINUSE after the last retry is rethrown.
export async function startApplicationOnPort(startApplication, options, { retries = 5, delayMs = 200 } = {}) {
  if (!Number.isInteger(options?.port) || options.port < 1) throw new Error('startApplicationOnPort needs the hunt port');
  for (let attempt = 0; ; attempt++) {
    try {
      return await startApplication(options);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt >= retries) throw error;
      await delay(delayMs);
    }
  }
}

// Re-verifies, on the instance a case ran against, that every seed in `seedIds` probes true
// exactly when it is enabled. Probes run in this process, whose HTTP client may still hold
// keep-alive sockets to an earlier instance on the same port; a bounded /contract warm-up
// evicts them before the first probe. Returns {mismatches, error}.
export async function verifySeedProbes(probe, app, seedIds, enabledSeeds, { attempts = 10, delayMs = 100, timeoutMs = 5000 } = {}) {
  let ready = false;
  for (let attempt = 0; attempt < attempts && !ready; attempt++) {
    try {
      const response = await fetch(new URL('/contract', app.url), { signal: AbortSignal.timeout(timeoutMs) });
      await response.arrayBuffer();
      ready = response.ok;
    } catch {
      ready = false;
    }
    if (!ready) await delay(delayMs);
  }
  if (!ready) return { mismatches: [], error: `the replay application at ${app.url} did not answer /contract` };
  const enabled = new Set(enabledSeeds);
  const mismatches = [];
  for (const id of seedIds) {
    let observed;
    try {
      observed = await probe(id, app.url, app.contract);
    } catch (error) {
      return { mismatches, error: `seed probe ${id} failed: ${error.message}` };
    }
    if (Boolean(observed) !== enabled.has(id)) mismatches.push(id);
  }
  return { mismatches, error: null };
}
