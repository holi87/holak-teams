#!/usr/bin/env node
// Usage: node scripts/eval/discovery/run.mjs <comparison-config.json> <new-output-directory>
// A relative output directory is created under the configuration's workRoot.
//
// Paired, repeated discovery runs. Each host adapter receives ONLY a public hunt request
// (argus-eval/hunt-request@2) and reports launch status and measured usage
// (argus-eval/adapter-result@2). The evaluator extracts findings itself from the run's artifact
// root, seals its private state while a hunt runs, and scans the artifacts for contamination.
// A faulty Mode A run that left a regression framework is then replayed (lib/replay.mjs): the
// same adapter receives public replay requests (argus-eval/replay-request@1) as
// `replay <request>` and runs the frozen suite in its sandbox against fresh applications on the
// hunt's port, again with the private state sealed.
//
// Layout (every directory 0700 and physical):
//   <output>/sealed/private-runs.json  private truth and results (chmod 000 during every hunt)
//   <output>/sealed/canary.txt         contamination canary
//   <output>/sealed/runs/<runId>/      completed runs, moved out of active/
//   <output>/active/<runId>/           request.json, result.json, usage.json, launcher.log and
//                                      artifacts/ (the hunter's only writable root); a replayed
//                                      run adds replay-requests/<case>-<k>.json and
//                                      replay/<case>-<k>/ plus replay/<case>-<k>.result.json
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import * as builtInCorpus from './corpus/index.mjs';
import { loadConfig } from './lib/config.mjs';
import { corpusFileNames, scanArtifacts } from './lib/contamination.mjs';
import { extractFindings } from './lib/extract.mjs';
import { caseName, evaluateReplayCase, infrastructureReplayCase, planReplayCases, readReplayResult, REPLAY_KILL_GRACE_SECONDS,
  replayStatus, startApplicationOnPort, verifySeedProbes } from './lib/replay.mjs';
import { assertEval, formatSchemaErrors, validateEval } from './lib/schemas.mjs';

const MAX_RESULT_BYTES = 1024 * 1024;
const SCORABLE = new Set(['awaiting-adjudication', 'timed-out']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

const [configPath, outputArgument] = process.argv.slice(2);
if (!configPath || !outputArgument) {
  console.error('usage: node scripts/eval/discovery/run.mjs <comparison-config.json> <new-output-directory>');
  process.exit(2);
}
const config = loadConfig(configPath);

// A corpus v2 module (built-in or private) is one composite application: the faulty build
// enables every seed, the corrected build none.
const source = config.corpusModule ? await import(pathToFileURL(config.corpusModule)) : builtInCorpus;
if (typeof source.corpusVersion !== 'string' || !source.corpusVersion || !Array.isArray(source.seedIds) || !source.seedIds.length
  || typeof source.startApplication !== 'function' || typeof source.truthFor !== 'function') {
  throw new Error('corpus module must export corpusVersion, seedIds, startApplication and truthFor');
}
const corpusDir = realpathSync(source.corpusDir ?? dirname(config.corpusModule ?? builtInCorpus.corpusDir));
const corpusFiles = typeof source.corpusFiles === 'function' ? source.corpusFiles() : [basename(config.corpusModule)];
const scanOptions = {
  corpusFileNames: corpusFileNames(basename(corpusDir), corpusFiles),
  seedIds: [...source.seedIds],
};

// Every directory the evaluator creates is 0700 and must resolve to itself.
function makeDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error(`${path} must be a physical directory`);
  return path;
}

function createOutput(argument, workRoot) {
  const requested = resolve(workRoot, argument);
  let parent;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    throw new Error(`the parent of output directory ${requested} must exist`);
  }
  const output = join(parent, basename(requested));
  let exists = true;
  try { lstatSync(output); } catch { exists = false; }
  if (exists) throw new Error(`output directory ${output} already exists; pass a new directory`);
  return makeDirectory(output);
}

const output = createOutput(outputArgument, config.workRoot);
const sealed = makeDirectory(join(output, 'sealed'));
const sealedRuns = makeDirectory(join(sealed, 'runs'));
const active = makeDirectory(join(output, 'active'));
const privateRunsPath = join(sealed, 'private-runs.json');
const canary = `ARGUS-EVAL-CANARY-${randomBytes(16).toString('hex')}`;
writeFileSync(join(sealed, 'canary.txt'), `${canary}\n`, { mode: 0o600, flag: 'wx' });
const repoRoot = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
scanOptions.canary = canary;
scanOptions.forbiddenPaths = [...new Set([repoRoot, output, corpusDir])];

// Sealing: the private directory is unreadable while any adapter runs. The OS sandbox denies
// chmod outside the artifact root, so a hunter cannot undo it. Restored on every exit path.
let activeChild = null;
let sealedClosed = false;
function seal() {
  chmodSync(sealed, 0o000);
  sealedClosed = true;
}
function unseal() {
  if (!sealedClosed) return;
  try {
    chmodSync(sealed, 0o700);
    sealedClosed = false;
  } catch (error) {
    console.error(`WARN  could not restore ${sealed} to 0700: ${error.message}`);
  }
}
function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The process group has already exited.
  }
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    killGroup(activeChild);
    unseal();
    process.exit(code);
  });
}

function adapterEnvironment() {
  const names = ['PATH', 'HOME', 'TMPDIR', ...config.adapterEnv].filter(name => process.env[name] !== undefined);
  return { names, env: Object.fromEntries(names.map(name => [name, process.env[name]])) };
}

// Spawns the adapter with `args` appended to its command, as its own process group, sealed for
// the whole lifetime of that group. The group is killed after `seconds` (timedOut: the mode
// budget of a hunt, or the runner budget plus a grace period of a replay) and, after a normal
// exit, again so that no straggler sees the private directory reopen.
function runAdapter(variant, args, cwd, seconds, env) {
  return new Promise(done => {
    let child = null;
    let timer = null;
    let timedOut = false;
    let settled = false;
    const startedAtMs = Date.now();
    const finish = fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child);
      activeChild = null;
      done({ ...fields, timedOut, startedAtMs, elapsedMs: Date.now() - startedAtMs });
    };
    seal();
    try {
      child = spawn(variant.command[0], [...variant.command.slice(1), ...args], {
        cwd, detached: true, stdio: ['ignore', 'ignore', 'inherit'], env });
    } catch (error) {
      finish({ exitCode: null, signal: null, spawnError: error.message });
      return;
    }
    activeChild = child;
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, seconds * 1000);
    child.once('error', error => finish({ exitCode: null, signal: null, spawnError: error.message }));
    child.once('close', (code, signal) => finish({ exitCode: code, signal, spawnError: null }));
  }).finally(unseal);
}

// Reads result.json from OUTSIDE the artifact root; a hunter can never write it.
function readAdapterResult(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { resultState: 'missing', resultErrors: [], result: null };
  }
  const invalid = message => ({ resultState: 'invalid', resultErrors: [message], result: null });
  if (stat.isSymbolicLink() || !stat.isFile()) return invalid('result.json is not a regular file');
  if (stat.size > MAX_RESULT_BYTES) return invalid(`result.json exceeds ${MAX_RESULT_BYTES} bytes`);
  let result;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return invalid(`result.json is not valid JSON: ${error.message}`);
  }
  const errors = validateEval('adapter-result', result);
  if (errors.length) return invalid(`result.json violates adapter-result@2: ${formatSchemaErrors(errors)}`);
  return { resultState: 'valid', resultErrors: [], result };
}

function classify({ outcome, adapter, contamination }) {
  const problems = [];
  if (outcome.spawnError) problems.push(`adapter could not start: ${outcome.spawnError}`);
  if (adapter.resultState === 'missing') problems.push('adapter wrote no result.json');
  if (adapter.resultState === 'invalid') problems.push(adapter.resultErrors.join('; '));
  if (adapter.result && adapter.result.status !== 'completed') {
    problems.push(`adapter status ${adapter.result.status}${adapter.result.reason ? `: ${adapter.result.reason}` : ''}`);
  }
  if (contamination.status === 'contaminated') {
    const kinds = [...new Set(contamination.hits.filter(hit => hit.kind !== 'seed-id' && hit.kind !== 'unreadable').map(hit => hit.kind))];
    return { status: 'contaminated', reason: [`artifacts contain ${kinds.join(', ')} traces`, ...problems].join('; ') };
  }
  if (outcome.timedOut) return { status: 'timed-out', reason: ['adapter exceeded the mode budget and was killed', ...problems].join('; ') };
  if (problems.length) return { status: 'invalid-run', reason: problems.join('; ') };
  return { status: 'awaiting-adjudication', reason: null };
}

// One replay case: a fresh application with the case's enabled seeds on the hunt port, one
// sealed `replay <request>` adapter call, then the seed probe re-verification on that instance.
async function replayCase(run, plan, { runDir, requestsDir, replayDir, frameworkRoot, variant, env, bugIds }) {
  const name = caseName(plan);
  const seconds = config.replay.secondsPerRunner;
  let app;
  try {
    app = await startApplicationOnPort(source.startApplication, { seed: run.seed, enabledSeeds: plan.enabledSeeds, port: run.port });
  } catch (error) {
    return infrastructureReplayCase(plan, `the application could not listen on port ${run.port} again: ${error.code ?? error.message}`);
  }
  try {
    if (app.port !== run.port) return infrastructureReplayCase(plan, `the application bound port ${app.port} instead of the hunt port ${run.port}`);
    const request = assertEval('replay-request', {
      schema: 'argus-eval/replay-request@1', runId: run.runId, case: plan.case, runnerMode: plan.runnerMode, frameworkRoot,
      replayRoot: join(replayDir, name), target: app.url, seconds, resultPath: join(replayDir, `${name}.result.json`),
    }, 'replay request');
    const requestPath = join(requestsDir, `${name}.json`);
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const outcome = await runAdapter(variant, ['replay', requestPath], runDir, seconds + REPLAY_KILL_GRACE_SECONDS, env);
    const probeCheck = outcome.spawnError || typeof source.probe !== 'function' ? null
      : await verifySeedProbes(source.probe, app, run.truth.map(item => item.id), plan.enabledSeeds);
    return evaluateReplayCase({ plan, outcome, replayResult: readReplayResult(request.resultPath), probeCheck, bugIds, allowTestStub: config.testMode, seconds });
  } finally {
    await app.close();
  }
}

// Replays the regression framework of a faulty Mode A run. It runs before the run directory
// moves to sealed/, because the requests and replay roots live under active/<runId>/.
async function replayRun(run, { runDir, artifactRoot, variant, env }) {
  const frameworkRoot = join(artifactRoot, run.extraction.framework.root);
  let physical = false;
  try {
    physical = lstatSync(frameworkRoot).isDirectory() && realpathSync(frameworkRoot) === frameworkRoot;
  } catch {
    physical = false;
  }
  if (!physical) return { status: 'unavailable', reason: 'the framework root is not a physical directory inside the artifact root', cases: [] };
  const context = {
    runDir, frameworkRoot, variant, env,
    requestsDir: makeDirectory(join(runDir, 'replay-requests')),
    replayDir: makeDirectory(join(runDir, 'replay')),
    bugIds: [...run.extraction.findings, ...run.extraction.suspected].map(finding => finding.id),
  };
  const cases = [];
  for (const plan of planReplayCases(run.truth, config.replay)) cases.push(await replayCase(run, plan, context));
  const incomplete = cases.filter(entry => entry.status !== 'completed');
  const reason = incomplete.length
    ? `${incomplete.length} of ${cases.length} replay cases did not complete (${[...new Set(incomplete.map(entry => entry.status))].join(', ')})`
    : null;
  return { status: replayStatus(cases), reason, cases };
}

async function executeRun({ repeat, seed, mode, build, variant }) {
  const runId = `r${repeat}-${mode}-${build}-${variant.name}`;
  const enabledSeeds = build === 'faulty' ? [...source.seedIds] : [];
  const truth = source.truthFor(enabledSeeds);
  const runDir = makeDirectory(join(active, runId));
  const artifactRoot = makeDirectory(join(runDir, 'artifacts'));
  const requestPath = join(runDir, 'request.json');
  const resultPath = join(runDir, 'result.json');
  const seconds = config.secondsByMode[mode];
  const { names: envNames, env } = adapterEnvironment();
  const app = await source.startApplication({ seed, enabledSeeds });
  let outcome;
  try {
    const request = assertEval('hunt-request', {
      schema: 'argus-eval/hunt-request@2', runId, revision: variant.revision, target: app.url,
      contractUrl: `${app.url}/contract`, mode, artifactRoot, resultPath, usagePath: join(runDir, 'usage.json'),
      logPath: join(runDir, 'launcher.log'), budget: { seconds, tokens: config.tokens },
    }, 'hunt request');
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    outcome = await runAdapter(variant, [requestPath], runDir, seconds, env);
  } finally {
    await app.close();
  }
  const adapter = { envNames, exitCode: outcome.exitCode, signal: outcome.signal, spawnError: outcome.spawnError, ...readAdapterResult(resultPath) };
  const extraction = extractFindings(artifactRoot, { startedAtMs: outcome.startedAtMs, elapsedMs: outcome.elapsedMs });
  const contamination = scanArtifacts(artifactRoot, scanOptions);
  const { status, reason } = classify({ outcome, adapter, contamination });
  const totalTokens = adapter.result?.usage.totalTokens;
  const run = {
    runId, variant: variant.name, revision: variant.revision, repeat, seed, mode, build, enabledSeeds, truth,
    url: app.url, port: app.port, contract: app.contract, status, reason,
    launchAssurance: adapter.result?.launchAssurance ?? 'unreported',
    startedAt: new Date(outcome.startedAtMs).toISOString(), elapsedMs: outcome.elapsedMs, timedOut: outcome.timedOut,
    overBudget: config.tokens !== null && Number.isFinite(totalTokens) && totalTokens > config.tokens,
    artifactRoot, adapter, extraction, contamination, replay: null,
  };
  const replayed = config.replay.enabled && mode === 'A' && build === 'faulty' && SCORABLE.has(status) && extraction.framework.root !== null;
  const replay = replayed ? await replayRun(run, { runDir, artifactRoot, variant, env }) : null;
  const sealedRunDir = join(sealedRuns, runId);
  renameSync(runDir, sealedRunDir);
  run.artifactRoot = join(sealedRunDir, 'artifacts');
  if (replay) run.replay = { status: replay.status, frameworkRoot: join(run.artifactRoot, extraction.framework.root), reason: replay.reason, cases: replay.cases };
  return run;
}

// Rewritten atomically after every run while sealed/ is open.
function writePrivateRuns(document) {
  assertEval('private-runs', document, 'private runs');
  const temporary = join(sealed, `.private-runs.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, privateRunsPath);
}

const seeds = config.seeds ?? Array.from({ length: config.repeats }, () => randomInt(1, 1000000));
const privateRuns = {
  schema: 'argus-eval/private-runs@2',
  createdAt: new Date().toISOString(),
  config,
  corpus: { version: source.corpusVersion, digest: typeof source.corpusDigest === 'function' ? source.corpusDigest() : null },
  canarySha256: sha256(canary),
  runs: [],
};
try {
  writePrivateRuns(privateRuns);
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    const seed = seeds[repeat];
    for (const mode of config.modes) for (const build of config.builds) {
      // Alternate execution order to reduce systematic warm-up effects.
      const variants = repeat % 2 ? [...config.variants].reverse() : config.variants;
      for (const variant of variants) {
        privateRuns.runs.push(await executeRun({ repeat, seed, mode, build, variant }));
        writePrivateRuns(privateRuns);
      }
    }
  }
} finally {
  killGroup(activeChild);
  unseal();
}

const statuses = {};
for (const run of privateRuns.runs) statuses[run.status] = (statuses[run.status] ?? 0) + 1;
// Paired variants must share the same launch assurance; compare every run with a valid result.
const assurances = new Set(privateRuns.runs
  .filter(run => SCORABLE.has(run.status) && run.adapter.resultState === 'valid')
  .map(run => run.launchAssurance));
const summary = { runs: privateRuns.runs.length, status: 'UNSCORED', statuses, privateResults: privateRunsPath };
if (assurances.size > 1) summary.assuranceMismatch = true;
const replays = {};
for (const run of privateRuns.runs) if (run.replay) replays[run.replay.status] = (replays[run.replay.status] ?? 0) + 1;
if (Object.keys(replays).length) summary.replays = replays;
console.log(JSON.stringify(summary));
if (statuses['invalid-run'] || statuses.contaminated || summary.assuranceMismatch) process.exitCode = 1;
