#!/usr/bin/env node
// Reference host adapter for the discovery evaluator. Maintainer-only; never packaged.
//
// Variant command (run.mjs appends the final argument, or `replay` and the final argument):
//   [<absolute node>, <repo>/scripts/eval/discovery/adapters/argus-unattested.mjs,
//    '--checkout', <absolute checkout of the variant revision>,
//    ('--plugin-root', <absolute plugin root, default <checkout>/argus/claude>,)
//    ('--no-provision-browser')]
//   ... <hunt-request.json>            argus-eval/hunt-request@2  -> argus-eval/adapter-result@2
//   ... replay <replay-request.json>   argus-eval/replay-request@1 -> argus-eval/replay-result@1
//
// Hunt: binds to the checkout (HEAD equals the requested revision and argus/claude is clean),
// requires an empty, physical 0700 artifact root, identifies the plugin by version and content
// digest, and runs `<pluginRoot>/bin/argus-launch claude --unattested ...` once, with this
// process's environment unchanged. It never sets HOME, ARGUS_MODEL_TRUST_STORE or
// CLAUDE_CONFIG_DIR, never touches a trust store, never shims `claude`, and never retries: a
// host with trust material gets `launcher-refused` from the launcher's downgrade guard and
// needs an attested adapter. Measured usage comes from the launcher's --usage-json report.
// Replay: copies the frozen framework to the replay root, probes the OS sandbox, and runs
// `bash run-tests.sh --mode <runnerMode>` there with only the replay root writable.
//
// Exit status: 0 completed (hunt) or replay result written; 1 internal error; 2 invalid
// request or unmet precondition (not launched); 3 launcher refused; 4 launcher or runner
// failure; 5 no usable OS sandbox (replay).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, cpSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeSync,
  writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { pluginSubject } from '../lib/plugin-digest.mjs';
import { detectSandbox, killActiveSandboxes, probeSandbox, runSandboxed } from '../lib/sandbox.mjs';
import { assertEval, formatSchemaErrors, validateArgus } from '../lib/schemas.mjs';

const EXIT = Object.freeze({ ok: 0, internal: 1, precondition: 2, refused: 3, failed: 4, sandbox: 5 });
// The launcher's downgrade guard message (both variants) up to the em dash.
const REFUSAL_TEXT ='--unattested is for hosts with no key material';
const LOG_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_USAGE_BYTES = 5 * 1024 * 1024;
const MAX_RUNNER_RESULT_BYTES = 5 * 1024 * 1024;
const HELP_TIMEOUT_MS = 30_000;
const PROBE_SECONDS = 30;
const LAUNCH_ASSURANCE = 'unattested';
const NULL_SUBJECT = Object.freeze({ pluginVersion: null, pluginDigest: null });
const UNAVAILABLE_USAGE = Object.freeze({
  source: 'unavailable', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
  totalTokens: null, costUsd: null, numTurns: null, controllerTurnCapHit: null,
});

// Raised for an unusable request or unmet precondition before anything is launched.
class PreconditionError extends Error {}

const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const lstatOrNull = path => lstatSync(path, { throwIfNoEntry: false }) ?? null;
const realpathOrSelf = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const isPhysicalDirectory = path => {
  const stat = lstatOrNull(path);
  return Boolean(stat?.isDirectory()) && realpathOrSelf(path) === path;
};

function usage(message) {
  throw new PreconditionError(`${message}\nusage: argus-unattested.mjs --checkout <absolute-checkout> [--plugin-root <absolute-dir>] [--no-provision-browser] `
    + '<hunt-request.json> | replay <replay-request.json>');
}

function parseArguments(argv) {
  const options = { checkout: null, pluginRoot: null, provisionBrowser: true };
  const operands = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--checkout' || argument === '--plugin-root') {
      const value = argv[++index];
      if (!value || !isAbsolute(value)) usage(`${argument} requires an absolute path`);
      options[argument === '--checkout' ? 'checkout' : 'pluginRoot'] = value;
    } else if (argument === '--no-provision-browser') {
      options.provisionBrowser = false;
    } else if (argument.startsWith('--')) {
      usage(`unknown option ${argument}`);
    } else {
      operands.push(argument);
    }
  }
  if (operands.length === 1) return { ...options, phase: 'hunt', requestPath: operands[0] };
  if (operands.length === 2 && operands[0] === 'replay') return { ...options, phase: 'replay', requestPath: operands[1] };
  return usage('expected <hunt-request.json> or replay <replay-request.json>');
}

function readRequest(path, schema) {
  const stat = lstatOrNull(path);
  if (!stat?.isFile() || stat.size > MAX_REQUEST_BYTES) throw new PreconditionError(`${path} is not a regular request file within ${MAX_REQUEST_BYTES} bytes`);
  let request;
  try {
    request = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PreconditionError(`${path} is not valid JSON: ${error.message}`);
  }
  try {
    return assertEval(schema, request, 'request');
  } catch (error) {
    throw new PreconditionError(error.message);
  }
}

// Why an output file the adapter writes cannot be used, or null: its parent must be a physical
// directory, the path must not be a symbolic link, and it must lie outside every root in `roots`.
function outputPathProblem(path, roots) {
  const parent = dirname(path);
  if (!isPhysicalDirectory(parent)) return `parent ${parent} is not a physical directory`;
  if (lstatOrNull(path)?.isSymbolicLink()) return 'is a symbolic link';
  const root = roots.find(candidate => within(candidate, path));
  return root ? `lies inside ${root}` : null;
}

// Validates the document against the evaluator schema, then writes it with a temporary file and
// a rename in the same directory.
function writeDocument(path, schema, document) {
  assertEval(schema, document, schema);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

// Appends to `path` (never through a symbolic link) up to `limit` bytes, then one truncation
// marker; later writes are dropped so the producer can still be drained.
function cappedLog(path, limit = LOG_LIMIT_BYTES) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let written = 0;
  let truncated = false;
  return {
    write(chunk) {
      if (truncated) return;
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (written + data.length <= limit) {
        writeSync(fd, data);
        written += data.length;
        return;
      }
      if (limit > written) writeSync(fd, data.subarray(0, limit - written));
      writeSync(fd, `\n[argus-unattested: output truncated at ${limit} bytes]\n`);
      written = limit;
      truncated = true;
    },
    close() {
      closeSync(fd);
    },
  };
}

// --- hunt ----------------------------------------------------------------------------------

function git(checkout, args) {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim().split('\n').at(-1) || `exit ${result.status}`);
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

// Why the checkout does not carry exactly `revision` for the plugin, or null.
function checkoutBindingProblem(checkout, revision, pluginRoot) {
  if (!isPhysicalDirectory(checkout)) return `checkout ${checkout} is not a physical directory`;
  try {
    const toplevel = git(checkout, ['rev-parse', '--show-toplevel']).trim();
    if (realpathOrSelf(toplevel) !== checkout) return `checkout ${checkout} is not the top level of its repository (${toplevel})`;
    const head = git(checkout, ['rev-parse', 'HEAD']).trim();
    if (head !== revision) return `checkout HEAD ${head} is not the requested revision ${revision}`;
    const pathspecs = ['argus/claude'];
    if (within(checkout, pluginRoot) && relative(checkout, pluginRoot) !== 'argus/claude') pathspecs.push(relative(checkout, pluginRoot) || '.');
    const dirty = git(checkout, ['status', '--porcelain', '--', ...pathspecs]);
    if (dirty.trim()) return `the checkout has uncommitted changes under ${pathspecs.join(', ')}: ${dirty.trim().split('\n').slice(0, 5).join('; ')}`;
  } catch (error) {
    return error.message;
  }
  return null;
}

function artifactRootProblem(artifactRoot) {
  const stat = lstatOrNull(artifactRoot);
  if (!stat) return `artifact root ${artifactRoot} does not exist`;
  if (realpathOrSelf(artifactRoot) !== artifactRoot) return `artifact root ${artifactRoot} is not its physical path (${realpathOrSelf(artifactRoot)})`;
  if (!stat.isDirectory()) return `artifact root ${artifactRoot} is not a directory`;
  if ((stat.mode & 0o777) !== 0o700) return `artifact root ${artifactRoot} has mode ${(stat.mode & 0o777).toString(8)}, not 700`;
  if (readdirSync(artifactRoot).length) return `artifact root ${artifactRoot} is not empty`;
  return null;
}

// The launcher options this revision's argus-launch advertises in its --help text.
function launcherFeatures(launcher) {
  const result = spawnSync(launcher, ['--help'], { encoding: 'utf8', timeout: HELP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = result.status === 0 ? result.stdout : '';
  return { usageJson: text.includes('--usage-json'), provisionBrowser: text.includes('--provision-browser') };
}

// The Claude CLI result document the launcher wrote with --usage-json, or null.
function readUsageDocument(path) {
  const stat = lstatOrNull(path);
  if (!stat?.isFile() || stat.size > MAX_USAGE_BYTES) return null;
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (Array.isArray(document)) document = document.findLast(entry => entry?.type === 'result');
  return document?.type === 'result' ? document : null;
}

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// adapter-result@2 usage from the result document: token counts summed over modelUsage (or,
// failing that, the snake_case usage fields), total_cost_usd, num_turns, and whether the
// controller stopped at its native turn cap. Never an estimate: an unreadable value is null.
function measuredUsage(document) {
  if (!document) return { ...UNAVAILABLE_USAGE };
  let tokens = null;
  const models = isObject(document.modelUsage) ? Object.values(document.modelUsage) : [];
  if (models.length && models.every(isObject)) {
    const sum = key => models.reduce((total, model) => (total === null || count(model[key]) === null ? null : total + model[key]), 0);
    tokens = [sum('inputTokens'), sum('outputTokens'), sum('cacheReadInputTokens'), sum('cacheCreationInputTokens')];
    if (tokens.includes(null)) tokens = null;
  }
  if (!tokens) {
    const fields = isObject(document.usage) ? document.usage : {};
    tokens = [count(fields.input_tokens), count(fields.output_tokens), count(fields.cache_read_input_tokens), count(fields.cache_creation_input_tokens)];
  }
  const [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens] = tokens;
  const cost = document.total_cost_usd;
  return {
    source: 'claude-cli-result-json',
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    totalTokens: tokens.includes(null) ? null : tokens.reduce((total, value) => total + value, 0),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    numTurns: count(document.num_turns),
    controllerTurnCapHit: document.subtype === 'error_max_turns',
  };
}

// Spawns the launcher once in this process group (the evaluator's group kill reaches it), with
// the environment unchanged, and streams its output into the capped log.
function launch(launcher, args, log) {
  return new Promise(done => {
    let refused = false;
    let carry = '';
    let tail = Buffer.alloc(0);
    let child;
    try {
      child = spawn(launcher, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ exitCode: null, signal: null, spawnError: error.message, refused, lastError: null });
      return;
    }
    activeLauncher = child;
    child.stdout.on('data', chunk => log.write(chunk));
    child.stderr.on('data', chunk => {
      log.write(chunk);
      const text = carry + chunk.toString('latin1');
      if (text.includes(REFUSAL_TEXT)) refused = true;
      carry = text.slice(-REFUSAL_TEXT.length);
      tail = Buffer.concat([tail, chunk]).subarray(-4096);
    });
    const lastError = () => tail.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? null;
    child.once('error', error => {
      activeLauncher = null;
      done({ exitCode: null, signal: null, spawnError: error.message, refused, lastError: lastError() });
    });
    child.once('close', (code, signal) => {
      activeLauncher = null;
      done({ exitCode: code, signal, spawnError: null, refused, lastError: lastError() });
    });
  });
}

async function hunt(options) {
  const request = readRequest(options.requestPath, 'hunt-request');
  const artifactRoots = [...new Set([request.artifactRoot, realpathOrSelf(request.artifactRoot)])];
  const resultProblem = outputPathProblem(request.resultPath, artifactRoots);
  if (resultProblem) throw new PreconditionError(`resultPath ${request.resultPath} ${resultProblem}`);
  const report = fields => writeDocument(request.resultPath, 'adapter-result', {
    schema: 'argus-eval/adapter-result@2', launcherExitCode: null, usage: { ...UNAVAILABLE_USAGE }, subject: { ...NULL_SUBJECT }, reason: null,
    ...fields, launchAssurance: LAUNCH_ASSURANCE,
  });
  const notLaunched = (reason, subject = NULL_SUBJECT) => {
    report({ status: 'launcher-failed', subject: { ...subject }, reason: `not launched: ${reason}` });
    process.stderr.write(`argus-unattested: not launched: ${reason}\n`);
    return EXIT.precondition;
  };

  for (const [label, path] of [['usagePath', request.usagePath], ['logPath', request.logPath]]) {
    const problem = outputPathProblem(path, artifactRoots);
    if (problem) return notLaunched(`${label} ${path} ${problem}`);
  }
  if (!options.checkout) return notLaunched('--checkout is required for a hunt');
  const pluginRoot = options.pluginRoot ?? join(options.checkout, 'argus', 'claude');

  const bindingProblem = checkoutBindingProblem(options.checkout, request.revision, pluginRoot);
  if (bindingProblem) {
    report({ status: 'revision-mismatch', reason: bindingProblem });
    process.stderr.write(`argus-unattested: revision mismatch: ${bindingProblem}\n`);
    return EXIT.precondition;
  }
  const artifactProblem = artifactRootProblem(request.artifactRoot);
  if (artifactProblem) return notLaunched(artifactProblem);

  if (!isPhysicalDirectory(pluginRoot)) return notLaunched(`plugin root ${pluginRoot} is not a physical directory`);
  let subject;
  try {
    subject = pluginSubject(pluginRoot);
  } catch (error) {
    return notLaunched(error.message);
  }
  const launcher = join(pluginRoot, 'bin', 'argus-launch');
  const launcherStat = lstatOrNull(launcher);
  if (!launcherStat?.isFile() || (launcherStat.mode & 0o111) === 0) return notLaunched(`${launcher} is not an executable regular file`, subject);
  // The launcher isolates CLAUDE_CONFIG_DIR, so the launched Claude has no stored login.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return notLaunched('ANTHROPIC_API_KEY is not set; list it in the comparison adapterEnv', subject);
  }
  if (lstatOrNull(request.usagePath)) return notLaunched(`usage report ${request.usagePath} already exists`, subject);

  const features = launcherFeatures(launcher);
  const args = ['claude', '--target', request.target, '--artifact-root', request.artifactRoot, '--mode', request.mode,
    '--engagement-id', request.engagementId, '--unattested'];
  if (options.provisionBrowser && features.provisionBrowser) args.push('--provision-browser');
  if (features.usageJson) args.push('--usage-json', request.usagePath);

  const log = cappedLog(request.logPath);
  let outcome;
  try {
    log.write(`argus-unattested ${new Date().toISOString()} plugin ${subject.pluginVersion ?? 'unversioned'} ${subject.pluginDigest}\n`);
    log.write(`argus-unattested launch ${[launcher, ...args].join(' ')}\n`);
    if (!features.usageJson) log.write('argus-unattested: this argus-launch has no --usage-json; usage is unavailable\n');
    if (options.provisionBrowser && !features.provisionBrowser) log.write('argus-unattested: this argus-launch has no --provision-browser\n');
    outcome = await launch(launcher, args, log);
    log.write(`argus-unattested launcher exit ${outcome.exitCode ?? `signal ${outcome.signal ?? outcome.spawnError}`}\n`);
  } finally {
    log.close();
  }

  const usageReport = features.usageJson ? measuredUsage(readUsageDocument(request.usagePath)) : { ...UNAVAILABLE_USAGE };
  const launcherExitCode = outcome.exitCode;
  if (outcome.exitCode === 0 || usageReport.controllerTurnCapHit === true) {
    const reason = usageReport.controllerTurnCapHit ? 'the controller stopped at its native turn cap (error_max_turns), a measured outcome' : null;
    report({ status: 'completed', launcherExitCode, usage: usageReport, subject, reason });
    return EXIT.ok;
  }
  if (outcome.refused) {
    report({ status: 'launcher-refused', launcherExitCode, usage: usageReport, subject,
      reason: 'the argus-launch downgrade guard refused --unattested because this host has operator trust material '
        + '(ARGUS_MODEL_TRUST_STORE or ~/.config/argus/model-trust.json); hosts with trust material need an attested adapter' });
    return EXIT.refused;
  }
  const how = outcome.spawnError ? `could not start: ${outcome.spawnError}`
    : outcome.exitCode === null ? `was terminated by ${outcome.signal}` : `exited with status ${outcome.exitCode}`;
  report({ status: 'launcher-failed', launcherExitCode, usage: usageReport, subject,
    reason: `argus-launch ${how}${outcome.lastError ? `: ${outcome.lastError}` : ''}` });
  return EXIT.failed;
}

// --- replay --------------------------------------------------------------------------------

let sandboxProbe = null;

// The OS sandbox behavior probe runs once per process.
function ensureSandbox(sandbox, replayRoot, env) {
  sandboxProbe ??= probeSandbox(sandbox, {
    writableRoot: replayRoot, env, seconds: PROBE_SECONDS,
    deniedPath: join(dirname(replayRoot), `.argus-replay-probe-${process.pid}`),
    allowedPath: join(replayRoot, '.tmp', 'probe'),
  });
  return sandboxProbe;
}

// Exactly these variables reach the runner; no ARGUS_* variable does. This Node's directory
// leads PATH so the suite runs on the adapter's Node, not a version-manager shim that would
// need to write outside the sandbox.
function runnerEnvironment(request) {
  const env = {
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':'),
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TMPDIR: join(request.replayRoot, '.tmp'),
    API_URL: request.target,
    UI_URL: request.target,
    CI: '1',
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

// {runnerResult, error}: reports/argus-runner-result.json of the replay root, when it is a
// physical regular file within 5 MB that satisfies runner-result@1.
function readRunnerResult(replayRoot) {
  const path = join(replayRoot, 'reports', 'argus-runner-result.json');
  const stat = lstatOrNull(path);
  if (!stat) return { runnerResult: null, error: 'runner-result-missing: the runner wrote no reports/argus-runner-result.json' };
  if (!stat.isFile() || realpathOrSelf(path) !== path) return { runnerResult: null, error: 'runner-result-unusable: not a physical regular file' };
  if (stat.size > MAX_RUNNER_RESULT_BYTES) return { runnerResult: null, error: `runner-result-unusable: larger than ${MAX_RUNNER_RESULT_BYTES} bytes` };
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { runnerResult: null, error: `runner-result-unusable: not valid JSON: ${error.message}` };
  }
  const errors = validateArgus('runner-result', document);
  if (errors.length) return { runnerResult: null, error: `runner-result-unusable: violates runner-result@1: ${formatSchemaErrors(errors)}` };
  return { runnerResult: document, error: null };
}

async function replay(options) {
  const request = readRequest(options.requestPath, 'replay-request');
  const resultProblem = within(request.replayRoot, request.resultPath) ? `lies inside the replay root ${request.replayRoot}`
    : outputPathProblem(request.resultPath, [request.frameworkRoot]);
  if (resultProblem) throw new PreconditionError(`resultPath ${request.resultPath} ${resultProblem}`);
  const report = fields => writeDocument(request.resultPath, 'replay-result', {
    schema: 'argus-eval/replay-result@1', case: request.case, runnerMode: request.runnerMode,
    exitCode: null, timedOut: false, sandbox: null, runnerResult: null, error: null, ...fields,
  });
  const refuse = (error, code) => {
    report({ error });
    process.stderr.write(`argus-unattested: ${error}\n`);
    return code;
  };

  if (!isPhysicalDirectory(request.frameworkRoot)) return refuse(`invalid-replay-request: frameworkRoot ${request.frameworkRoot} is not a physical directory`, EXIT.precondition);
  if (lstatOrNull(request.replayRoot)) return refuse(`invalid-replay-request: replayRoot ${request.replayRoot} already exists`, EXIT.precondition);
  if (!isPhysicalDirectory(dirname(request.replayRoot))) return refuse(`invalid-replay-request: the parent of replayRoot ${request.replayRoot} is not a physical directory`, EXIT.precondition);
  if (within(request.frameworkRoot, request.replayRoot) || within(request.replayRoot, request.frameworkRoot)) {
    return refuse('invalid-replay-request: replayRoot and frameworkRoot overlap', EXIT.precondition);
  }
  const sandbox = detectSandbox();
  if (!sandbox.kind) return refuse(`unsupported-sandbox: ${sandbox.error}`, EXIT.sandbox);

  try {
    cpSync(request.frameworkRoot, request.replayRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    mkdirSync(join(request.replayRoot, '.tmp'));
  } catch (error) {
    return refuse(`replay-copy-failed: ${error.message}`, EXIT.failed);
  }
  const env = runnerEnvironment(request);
  const probe = await ensureSandbox(sandbox, request.replayRoot, env);
  if (!probe.ok) return refuse(`sandbox-probe-failed: ${probe.reason}`, EXIT.sandbox);

  const log = cappedLog(`${request.replayRoot}.log`);
  let outcome;
  try {
    outcome = await runSandboxed(sandbox, {
      writableRoot: request.replayRoot, cwd: request.replayRoot, env, seconds: request.seconds,
      argv: ['bash', 'run-tests.sh', '--mode', request.runnerMode], onOutput: chunk => log.write(chunk),
    });
  } finally {
    log.close();
  }
  if (outcome.spawnError) {
    report({ sandbox: sandbox.kind, error: `runner-not-started: ${outcome.spawnError}` });
    return EXIT.failed;
  }
  const { runnerResult, error } = readRunnerResult(request.replayRoot);
  report({ exitCode: outcome.exitCode, timedOut: outcome.timedOut, sandbox: sandbox.kind, runnerResult, error: outcome.timedOut ? null : error });
  return EXIT.ok;
}

// --- entry point ---------------------------------------------------------------------------

let activeLauncher = null;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    killActiveSandboxes();
    activeLauncher?.kill('SIGTERM');
    process.exit(code);
  });
}

try {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = options.phase === 'hunt' ? await hunt(options) : await replay(options);
} catch (error) {
  process.stderr.write(`argus-unattested: ${error.message}\n`);
  process.exitCode = error instanceof PreconditionError ? EXIT.precondition : EXIT.internal;
}
