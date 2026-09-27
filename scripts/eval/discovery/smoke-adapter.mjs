#!/usr/bin/env node
// Reference adapter smoke (adapters/argus-unattested.mjs). No API and no Claude CLI: a stub
// plugin root whose bin/argus-launch records its argv and environment outside the artifact
// root, a temporary git checkout for the revision binding, the real argus-launch for the
// downgrade guard, and a trivial framework replayed inside the OS sandbox. It also pins the
// replay sandbox to the argus-launch profile and the plugin digest to its definition.
// Scripted harness validation only; no Argus model score is claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDigest, pluginSubject } from './lib/plugin-digest.mjs';
import { detectSandbox, escapeSandboxValue, LINUX_SANDBOX, macosProfile, sandboxInvocation } from './lib/sandbox.mjs';
import { formatSchemaErrors, validateArgus, validateEval } from './lib/schemas.mjs';

const ADAPTER = fileURLToPath(new URL('./adapters/argus-unattested.mjs', import.meta.url));
const REPO = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const REAL_PLUGIN = join(REPO, 'argus', 'claude');
const LAUNCHER_SOURCE = join(REPO, 'argus', 'bin', 'argus-launch');
const FIXTURE_CLAUDE_DIR = join(REPO, 'scripts', 'fixtures', 'argus-launcher');
const TARGET = 'http://127.0.0.1:9';
const RUN_ID = 'r0-B-faulty-baseline';
const API_KEY = 'sk-ant-smoke-not-a-real-key';
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-adapter-')));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const mode = path => statSync(path).mode & 0o777;

function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
function write(path, content, fileMode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: fileMode });
  chmodSync(path, fileMode);
}
// Hermetic git for the smoke's own repository setup: no global or system configuration.
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Argus Smoke', '-c', 'user.email=argus-smoke@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// Stub argus-launch: every call appends {argv, env} to STUB_LAUNCH_RECORD. --help advertises the
// options named in STUB_LAUNCH_HELP (default usage-json); STUB_LAUNCH_BEHAVIOR picks the launch.
const STUB_LAUNCHER = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LAUNCH_RECORD, JSON.stringify({ argv: args, env: process.env }) + '\\n');
if (args[0] === '--help') {
  const features = (process.env.STUB_LAUNCH_HELP ?? 'usage-json').split(',').filter(Boolean);
  process.stdout.write('Usage:\\n  argus-launch claude --target <t> --artifact-root <a> --mode <m> --engagement-id <id> --unattested'
    + features.map(name => ' [--' + name + ' ...]').join('') + '\\nOperators who cannot provision keys may use --unattested.\\n');
  process.exit(0);
}
const at = args.indexOf('--usage-json');
const usagePath = at >= 0 ? args[at + 1] : null;
const behavior = process.env.STUB_LAUNCH_BEHAVIOR ?? 'success';
const report = (subtype, withModels = true) => {
  if (!usagePath) return;
  const document = { type: 'result', subtype, is_error: subtype !== 'success', num_turns: 37, total_cost_usd: 1.25, result: 'stub result',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } };
  if (withModels) document.modelUsage = {
    'claude-opus-stub': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 5000, cacheCreationInputTokens: 300, costUSD: 1 },
    'claude-sonnet-stub': { inputTokens: 400, outputTokens: 100, cacheReadInputTokens: 2000, cacheCreationInputTokens: 50, costUSD: 0.25 },
  };
  writeFileSync(usagePath, JSON.stringify(document));
};
if (behavior === 'refuse') {
  process.stderr.write('FAIL  a host model trust store exists at ' + process.env.HOME + '/.config/argus/model-trust.json; --unattested is for hosts with no key material \\u2014 run attested with --trust-store/--runtime-key-id\\n');
  process.exit(1);
}
if (behavior === 'max-turns') {
  report('error_max_turns');
  process.stdout.write('stub stopped at the turn cap\\n');
  process.exit(1);
}
if (behavior === 'fail') {
  process.stderr.write('FAIL  Claude Code CLI is unavailable\\n');
  process.exit(2);
}
report('success', behavior !== 'snake-usage');
process.stdout.write('stub launch complete\\n');
process.stderr.write('stub launch stderr\\n');
process.exit(0);
`;

function stubPlugin(name) {
  const root = join(work, name);
  write(join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'argus', version: '9.9.9-stub' })}\n`);
  write(join(root, 'bin', 'argus-launch'), STUB_LAUNCHER, 0o755);
  write(join(root, 'agents', 'odysseus.md'), '# stub\n');
  return root;
}

let runs = 0;
function prepareRun(overrides = {}) {
  const dir = directory(join(work, 'runs', `run-${runs++}`));
  const paths = {
    dir, artifacts: directory(join(dir, 'artifacts')), request: join(dir, 'request.json'), record: join(dir, 'launcher-record.jsonl'),
    resultPath: join(dir, 'result.json'), usagePath: join(dir, 'usage.json'), logPath: join(dir, 'launcher.log'),
  };
  const request = {
    schema: 'argus-eval/hunt-request@2', runId: RUN_ID, revision, target: TARGET, contractUrl: `${TARGET}/contract`, mode: 'B',
    artifactRoot: paths.artifacts, resultPath: paths.resultPath, usagePath: paths.usagePath, logPath: paths.logPath,
    budget: { seconds: 600, tokens: null }, ...overrides,
  };
  assert.deepEqual(validateEval('hunt-request', request), []);
  writeFileSync(paths.request, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  return { ...paths, request: paths.request, requestDocument: request };
}

const harnessHome = directory(join(work, 'home'));
const harnessTmp = directory(join(work, 'tmp'));
const baseEnv = { PATH: process.env.PATH, HOME: harnessHome, TMPDIR: harnessTmp, ANTHROPIC_API_KEY: API_KEY };

function adapter(args, env) {
  return spawnSync(process.execPath, [ADAPTER, ...args], { env, encoding: 'utf8', timeout: 180_000 });
}
function hunt(run, { behavior = 'success', help = 'usage-json', options = [], env = {} } = {}) {
  const result = adapter([...stubOptions, ...options, run.request], { ...baseEnv, STUB_LAUNCH_RECORD: run.record, STUB_LAUNCH_BEHAVIOR: behavior, STUB_LAUNCH_HELP: help, ...env });
  return { ...result, result: existsSync(run.resultPath) ? readAdapterResult(run.resultPath) : null, records: records(run.record) };
}
function readAdapterResult(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateEval('adapter-result', document);
  assert.deepEqual(errors, [], `adapter-result@2: ${formatSchemaErrors(errors)}`);
  assert.equal(document.launchAssurance, 'unattested');
  return document;
}
function records(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const launches = recorded => recorded.filter(entry => entry.argv[0] === 'claude');

// The argus-launch sandbox profile and bubblewrap invocation, extracted from its source.
function launcherSandbox() {
  const source = readFileSync(LAUNCHER_SOURCE, 'utf8');
  const literal = String.raw`(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*")`;
  const profile = source.match(new RegExp(String.raw`printf '%s\\n' \\\n((?:[ \t]+${literal} \\\n)*[ \t]+${literal}) >"\$profile"`));
  assert.ok(profile, 'argus-launch profile block not found');
  const lines = profile[1].split('\n').map(line => line.trim().replace(/ \\$/, '')).map(literal => (literal.startsWith("'")
    ? literal.slice(1, -1)
    : literal.slice(1, -1).replace(/\\(["\\$`])/g, '$1')));
  const bwrap = source.match(/\n\s*bwrap ((?:[^\n]*\\\n)*[^\n]*) "\$@"\n/);
  assert.ok(bwrap, 'argus-launch bwrap invocation not found');
  return { lines, bwrapArgs: bwrap[1].replace(/\\\n/g, ' ').trim().split(/\s+/) };
}

const checkout = directory(join(work, 'checkout'));
write(join(checkout, 'argus', 'claude', 'README.md'), 'stub plugin sources\n');
write(join(checkout, 'README.md'), 'stub checkout\n');
git(checkout, 'init', '-q');
git(checkout, 'add', '-A');
git(checkout, 'commit', '-q', '-m', 'stub revision');
const revision = git(checkout, 'rev-parse', 'HEAD');
const plugin = stubPlugin('stub-plugin');
const stubOptions = ['--checkout', checkout, '--plugin-root', plugin];

try {
  // Plugin digest: sorted `relPath\0sha256(content)\n` lines over regular files, excluding the
  // manifest, node_modules/ and .DS_Store.
  {
    const root = join(work, 'digest-plugin');
    write(join(root, '.claude-plugin', 'plugin.json'), '{"name":"argus","version":"1.0.0"}\n');
    write(join(root, 'b.txt'), 'bee\n');
    write(join(root, 'a', 'z.md'), 'zed\n');
    write(join(root, 'a-b.txt'), 'dash\n');
    write(join(root, 'node_modules', 'x', 'index.js'), 'ignored\n');
    write(join(root, 'a', 'node_modules', 'y.js'), 'ignored\n');
    write(join(root, '.DS_Store'), 'ignored');
    write(join(root, 'a', '.DS_Store'), 'ignored');
    const expected = sha256(['a-b.txt', 'a/z.md', 'b.txt'].map(path => `${path}\0${sha256(readFileSync(join(root, path)))}\n`).join(''));
    assert.equal(pluginDigest(root), expected);
    assert.deepEqual(pluginSubject(root), { pluginVersion: '1.0.0', pluginDigest: expected });
    write(join(root, '.claude-plugin', 'plugin.json'), '{"name":"argus","version":"2.0.0"}\n');
    write(join(root, 'node_modules', 'x', 'index.js'), 'changed\n');
    assert.equal(pluginDigest(root), expected, 'the manifest and node_modules must not change the digest');
    write(join(root, 'b.txt'), 'bee!\n');
    assert.notEqual(pluginDigest(root), expected, 'a content change must change the digest');
    symlinkSync('b.txt', join(root, 'alias.txt'));
    assert.throws(() => pluginDigest(root), /not a regular file/);
    write(join(root, '.claude-plugin', 'plugin.json'), '{"name":"hephaestus","version":"1.0.0"}\n');
    assert.throws(() => pluginSubject(root), /does not name the plugin argus/);
    assert.match(pluginDigest(REAL_PLUGIN), /^[a-f0-9]{64}$/);
    console.log('PASS  plugin digest: sorted path/content lines over regular files; manifest, node_modules and .DS_Store excluded; symbolic links fail');
  }

  // Sandbox drift: the replay profile and bubblewrap invocation equal argus-launch's.
  {
    const { lines, bwrapArgs } = launcherSandbox();
    const root = '/private/tmp/replay "quoted" \\ root';
    const expected = `${lines.map(line => line.replace('$escaped_artifact', escapeSandboxValue(root))).join('\n')}\n`;
    assert.equal(macosProfile(root), expected);
    assert.match(macosProfile('/w'), /\(allow file-write\* \(subpath "\/w"\)\)/);
    const invocation = sandboxInvocation({ kind: LINUX_SANDBOX, executable: '/usr/bin/bwrap', error: null }, { writableRoot: '/w/replay', cwd: '/w/replay', argv: ['bash', 'run-tests.sh'] });
    const launcherArgs = bwrapArgs.map(arg => ({ '"$artifact_root"': '/w/replay', '"$workspace"': '/w/replay' })[arg] ?? arg);
    assert.deepEqual(invocation.args, [...launcherArgs, 'bash', 'run-tests.sh']);
    console.log('PASS  replay sandbox: the macOS profile and the bubblewrap invocation equal argus-launch os-native-target-readonly@3 with the replay root writable');
  }

  // (1) A completed run: exact unattested argv, unchanged environment, measured usage.
  {
    const run = prepareRun();
    const outcome = hunt(run);
    assert.equal(outcome.status, 0, outcome.stderr);
    const { result } = outcome;
    assert.equal(result.status, 'completed');
    assert.equal(result.launcherExitCode, 0);
    assert.equal(result.reason, null);
    assert.deepEqual(result.subject, { pluginVersion: '9.9.9-stub', pluginDigest: pluginDigest(plugin) });
    assert.deepEqual(result.usage, {
      source: 'claude-cli-result-json', inputTokens: 1400, outputTokens: 300, cacheReadTokens: 7000, cacheCreationTokens: 350,
      totalTokens: 9050, costUsd: 1.25, numTurns: 37, controllerTurnCapHit: false,
    });
    const [launch, ...more] = launches(outcome.records);
    assert.equal(more.length, 0, 'the launcher must be started exactly once');
    assert.deepEqual(launch.argv, ['claude', '--target', TARGET, '--artifact-root', run.artifacts, '--mode', 'B',
      '--engagement-id', `eval-${RUN_ID}`, '--unattested', '--usage-json', run.usagePath]);
    assert.ok(!launch.argv.includes('--trust-store') && !launch.argv.includes('--provision-browser'));
    assert.equal(launch.env.HOME, harnessHome);
    assert.equal(launch.env.PATH, baseEnv.PATH, 'no claude shim may be prepended to PATH');
    assert.equal(launch.env.TMPDIR, harnessTmp);
    assert.equal(launch.env.ANTHROPIC_API_KEY, API_KEY);
    for (const name of ['ARGUS_MODEL_TRUST_STORE', 'CLAUDE_CONFIG_DIR']) assert.equal(launch.env[name], undefined, `${name} must not be set`);
    assert.ok(!existsSync(join(harnessHome, '.config')), 'the adapter must not create a trust store location');
    assert.deepEqual(readdirSync(run.artifacts), [], 'the adapter writes nothing inside the artifact root');
    assert.equal(mode(run.resultPath), 0o600);
    const log = readFileSync(run.logPath, 'utf8');
    assert.match(log, /stub launch complete/);
    assert.match(log, /stub launch stderr/);
    console.log('PASS  completed hunt: one --unattested --mode B launch on the physical artifact root with --usage-json and no trust store; HOME and PATH unchanged; usage summed over modelUsage');
  }

  // Feature detection: --provision-browser only when advertised and not opted out; no
  // --usage-json means unavailable usage; the snake_case usage fields are the fallback.
  {
    const provisioned = hunt(prepareRun(), { help: 'provision-browser' });
    assert.equal(provisioned.status, 0, provisioned.stderr);
    const [launch] = launches(provisioned.records);
    assert.ok(launch.argv.includes('--provision-browser') && !launch.argv.includes('--usage-json'));
    assert.deepEqual(provisioned.result.usage, {
      source: 'unavailable', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
      totalTokens: null, costUsd: null, numTurns: null, controllerTurnCapHit: null,
    });
    const optedOut = hunt(prepareRun(), { help: 'usage-json,provision-browser', options: ['--no-provision-browser'] });
    assert.equal(optedOut.status, 0, optedOut.stderr);
    assert.ok(!launches(optedOut.records)[0].argv.includes('--provision-browser'));
    const snake = hunt(prepareRun(), { behavior: 'snake-usage' });
    assert.equal(snake.status, 0, snake.stderr);
    assert.deepEqual([snake.result.usage.inputTokens, snake.result.usage.outputTokens, snake.result.usage.cacheReadTokens,
      snake.result.usage.cacheCreationTokens, snake.result.usage.totalTokens], [1, 2, 3, 4, 10]);
    console.log('PASS  launcher features: --provision-browser only when advertised (and not with --no-provision-browser); usage unavailable without --usage-json; snake_case usage fallback');
  }

  // (2) The launcher refusal text: launcher-refused, adapter exit 3, one launch, no retry.
  {
    const run = prepareRun();
    const outcome = hunt(run, { behavior: 'refuse' });
    assert.equal(outcome.status, 3, outcome.stderr);
    assert.equal(outcome.result.status, 'launcher-refused');
    assert.equal(outcome.result.launcherExitCode, 1);
    assert.match(outcome.result.reason, /trust material need an attested adapter/);
    assert.equal(launches(outcome.records).length, 1, 'a refused launch is never retried');
    console.log('PASS  downgrade-guard refusal: launcher-refused with exit 3 after exactly one launch');
  }

  // (3) Revision mismatch, then a dirty argus/claude: exit 2 and the launcher never runs.
  {
    const wrong = prepareRun({ revision: revision.replace(/^./, character => (character === 'a' ? 'b' : 'a')) });
    const outcome = hunt(wrong);
    assert.equal(outcome.status, 2, outcome.stderr);
    assert.equal(outcome.result.status, 'revision-mismatch');
    assert.match(outcome.result.reason, /is not the requested revision/);
    assert.deepEqual(outcome.records, [], 'the launcher must not be invoked on a revision mismatch');
    const extra = join(checkout, 'argus', 'claude', 'untracked.md');
    write(extra, 'dirty\n');
    try {
      const dirty = hunt(prepareRun());
      assert.equal(dirty.status, 2, dirty.stderr);
      assert.equal(dirty.result.status, 'revision-mismatch');
      assert.match(dirty.result.reason, /uncommitted changes under argus\/claude/);
      assert.deepEqual(dirty.records, []);
    } finally {
      unlinkSync(extra);
    }
    console.log('PASS  checkout binding: a different HEAD or uncommitted argus/claude changes give revision-mismatch, exit 2, and no launch');
  }

  // (4) An artifact root given through a symbolic link alias, a non-empty one, and a 0755 one.
  {
    const aliasRun = prepareRun();
    const alias = join(aliasRun.dir, 'artifacts-alias');
    symlinkSync(aliasRun.artifacts, alias);
    const request = { ...aliasRun.requestDocument, artifactRoot: alias };
    writeFileSync(aliasRun.request, JSON.stringify(request), { mode: 0o600 });
    const outcome = hunt(aliasRun);
    assert.equal(outcome.status, 2, outcome.stderr);
    assert.equal(outcome.result.status, 'launcher-failed');
    assert.equal(outcome.result.launcherExitCode, null);
    assert.match(outcome.result.reason, /^not launched: artifact root .* is not its physical path/);
    assert.deepEqual(outcome.records, []);
    const full = prepareRun();
    write(join(full.artifacts, 'left-over.txt'), 'x\n');
    assert.equal(hunt(full).status, 2);
    assert.match(readAdapterResult(full.resultPath).reason, /is not empty/);
    const open = prepareRun();
    chmodSync(open.artifacts, 0o755);
    assert.equal(hunt(open).status, 2);
    assert.match(readAdapterResult(open.resultPath).reason, /not 700/);
    const inside = prepareRun();
    writeFileSync(inside.request, JSON.stringify({ ...inside.requestDocument, resultPath: join(inside.artifacts, 'result.json') }));
    const forged = hunt(inside);
    assert.equal(forged.status, 2);
    assert.deepEqual(readdirSync(inside.artifacts), [], 'nothing may be written inside the artifact root');
    assert.deepEqual(forged.records, []);
    console.log('PASS  artifact root: a symbolic link alias, a non-empty or 0755 root, or a result path inside it gives exit 2 without a launch');
  }

  // (5) error_max_turns with launcher exit 1 is a measured, completed outcome; other failures
  // are launcher-failed; a missing API key is never launched.
  {
    const capped = hunt(prepareRun(), { behavior: 'max-turns' });
    assert.equal(capped.status, 0, capped.stderr);
    assert.equal(capped.result.status, 'completed');
    assert.equal(capped.result.launcherExitCode, 1);
    assert.equal(capped.result.usage.controllerTurnCapHit, true);
    assert.equal(capped.result.usage.numTurns, 37);
    assert.match(capped.result.reason, /error_max_turns/);
    const failed = hunt(prepareRun(), { behavior: 'fail' });
    assert.equal(failed.status, 4, failed.stderr);
    assert.equal(failed.result.status, 'launcher-failed');
    assert.equal(failed.result.launcherExitCode, 2);
    assert.match(failed.result.reason, /exited with status 2: FAIL {2}Claude Code CLI is unavailable/);
    assert.equal(failed.result.usage.source, 'unavailable');
    const keyless = prepareRun();
    const noKey = adapter([...stubOptions, keyless.request], { ...baseEnv, ANTHROPIC_API_KEY: '', STUB_LAUNCH_RECORD: keyless.record });
    assert.equal(noKey.status, 2, noKey.stderr);
    assert.match(readAdapterResult(keyless.resultPath).reason, /ANTHROPIC_API_KEY is not set/);
    assert.deepEqual(records(keyless.record), []);
    console.log('PASS  status mapping: error_max_turns is completed with controllerTurnCapHit, other non-zero exits are launcher-failed (exit 4), no API key is never launched');
  }

  // (6) The real argus-launch with a trust store in HOME: launcher-refused, store untouched.
  {
    const hostCommands = ['node', 'jq', 'openssl', 'strings', 'find', 'env', 'awk', 'sed', 'tr', 'mktemp', 'stat', 'id'];
    const missing = hostCommands.filter(name => spawnSync('sh', ['-c', `command -v ${name}`]).status !== 0);
    if (spawnSync('sh', ['-c', 'command -v sha256sum || command -v shasum']).status !== 0) missing.push('sha256sum/shasum');
    if (missing.length) {
      console.log(`SKIP  real argus-launch downgrade guard: host commands unavailable (${missing.join(', ')})`);
    } else {
      const realOptions = ['--checkout', checkout, '--plugin-root', REAL_PLUGIN];
      const env = { ...baseEnv, PATH: `${FIXTURE_CLAUDE_DIR}${delimiter}${process.env.PATH}` };
      const trustHome = directory(join(work, 'trust-home'));
      const store = join(trustHome, '.config', 'argus', 'model-trust.json');
      write(store, `${JSON.stringify({ schema: 'argus/model-trust@1', smoke: sha256(work) })}\n`, 0o600);
      const before = readFileSync(store);
      const beforeStat = statSync(store);
      const run = prepareRun();
      const outcome = adapter([...realOptions, run.request], { ...env, HOME: trustHome });
      assert.equal(outcome.status, 3, outcome.stderr);
      const result = readAdapterResult(run.resultPath);
      assert.equal(result.status, 'launcher-refused');
      assert.equal(result.launcherExitCode, 2);
      assert.deepEqual(result.subject, pluginSubject(REAL_PLUGIN));
      assert.ok(readFileSync(store).equals(before), 'the trust store must stay byte-identical');
      assert.equal(statSync(store).ino, beforeStat.ino);
      assert.equal(statSync(store).mtimeMs, beforeStat.mtimeMs);
      assert.deepEqual(readdirSync(run.artifacts), []);
      assert.match(readFileSync(run.logPath, 'utf8'), /--unattested is for hosts with no key material/);
      const variable = prepareRun();
      const byVariable = adapter([...realOptions, variable.request], { ...env, ARGUS_MODEL_TRUST_STORE: store });
      assert.equal(byVariable.status, 3, byVariable.stderr);
      assert.equal(readAdapterResult(variable.resultPath).status, 'launcher-refused');
      assert.ok(readFileSync(store).equals(before));
      console.log('PASS  real argus-launch: a HOME trust store or ARGUS_MODEL_TRUST_STORE gives launcher-refused (exit 3); the trust store is byte-identical afterwards');
    }
  }

  // (7) Replay inside the OS sandbox: the runner result is captured, writes outside the replay
  // root fail, the runner sees only the documented environment, and the budget is enforced.
  {
    const sandbox = detectSandbox();
    if (!sandbox.kind) {
      console.log(`SKIP  sandboxed replay: ${sandbox.error}`);
    } else {
      const runDir = directory(join(work, 'replay-run'));
      const frameworkRoot = join(directory(join(runDir, 'artifacts')), 'qa');
      const outside = directory(join(work, 'replay-outside'));
      write(join(frameworkRoot, 'run-tests.sh'), `#!/usr/bin/env bash
set -u
mode=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="\${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
cd "$(dirname "$0")" || exit 12
mkdir -p reports
env | sort >reports/runner-env.txt
attempt() {
  if printf escaped >"$2" 2>/dev/null; then echo "$1:written"; else echo "$1:denied"; fi >>reports/attempts.txt
}
attempt relative ../escape-relative.txt
attempt absolute ${JSON.stringify(join(outside, 'escape.txt'))}
attempt framework ${JSON.stringify(join(frameworkRoot, 'tampered.txt'))}
printf tmp >"$TMPDIR/tmp-write.txt" || exit 13
case "$PWD" in */only-sleep-*) sleep 30 ;; esac
exec node checks/result.mjs "$mode"
`, 0o755);
      write(join(frameworkRoot, 'scripts', 'runner-contract.sh'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
      write(join(frameworkRoot, 'checks', 'result.mjs'), `import { writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (mode === 'baseline') process.exit(3);
const events = [{ caseId: 'REG-0001', category: 'product', status: 'fail', expected: true, lifecycle: 'reproduced', bugId: 'BUG-0001', reason: 'synthetic' }];
writeFileSync('reports/argus-runner-result.json', JSON.stringify({ $schema: 'argus/runner-result@1', schemaVersion: 1, mode, status: 'pass', exitCode: 0,
  categories: { product: 1, automation: 0, infrastructure: 0, skip: 0, policy: 0 }, events, generatedAt: '2026-01-01T00:00:00Z', deliveryGate: false, missingExpectedBugs: 0 }));
`);
      const replayDir = directory(join(runDir, 'replay'));
      const replay = (label, testCase, runnerMode, seconds = 120) => {
        const request = {
          schema: 'argus-eval/replay-request@1', runId: 'r0-A-faulty-baseline', case: testCase, runnerMode, frameworkRoot,
          replayRoot: join(replayDir, label), target: TARGET, seconds, resultPath: join(replayDir, `${label}.result.json`),
        };
        assert.deepEqual(validateEval('replay-request', request), []);
        const requestPath = join(runDir, `${label}.request.json`);
        writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
        const started = Date.now();
        const outcome = adapter([...stubOptions, 'replay', requestPath], { ...baseEnv, ARGUS_SMOKE_LEAK: 'must-not-reach-the-runner' });
        const result = existsSync(request.resultPath) ? JSON.parse(readFileSync(request.resultPath, 'utf8')) : null;
        if (result) assert.deepEqual(validateEval('replay-result', result), [], 'replay-result@1');
        return { ...outcome, request, result, elapsedMs: Date.now() - started };
      };

      const captured = replay('all-on-0', 'all-on', 'defect-evidence');
      assert.equal(captured.status, 0, captured.stderr);
      const { result, request } = captured;
      assert.deepEqual([result.case, result.runnerMode, result.sandbox, result.exitCode, result.timedOut, result.error],
        ['all-on', 'defect-evidence', sandbox.kind, 0, false, null]);
      assert.deepEqual(validateArgus('runner-result', result.runnerResult), []);
      assert.deepEqual(result.runnerResult, JSON.parse(readFileSync(join(request.replayRoot, 'reports', 'argus-runner-result.json'), 'utf8')));
      assert.equal(readFileSync(join(request.replayRoot, 'reports', 'attempts.txt'), 'utf8'), 'relative:denied\nabsolute:denied\nframework:denied\n');
      for (const path of [join(replayDir, 'escape-relative.txt'), join(outside, 'escape.txt'), join(frameworkRoot, 'tampered.txt')]) {
        assert.ok(!existsSync(path), `${path} must not exist`);
      }
      assert.ok(!existsSync(join(frameworkRoot, 'reports')), 'the frozen framework stays untouched');
      assert.equal(readFileSync(join(request.replayRoot, '.tmp', 'tmp-write.txt'), 'utf8'), 'tmp');
      assert.ok(!existsSync(join(request.replayRoot, '.tmp', 'probe')));
      assert.deepEqual(readdirSync(replayDir).filter(name => name.startsWith('.argus-replay-probe-')), []);
      const env = Object.fromEntries(readFileSync(join(request.replayRoot, 'reports', 'runner-env.txt'), 'utf8').trim().split('\n')
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      assert.deepEqual([env.API_URL, env.UI_URL, env.CI, env.TMPDIR, env.HOME], [TARGET, TARGET, '1', join(request.replayRoot, '.tmp'), harnessHome]);
      assert.deepEqual(Object.keys(env).filter(name => name.startsWith('ARGUS_') || name === 'ANTHROPIC_API_KEY'), []);
      assert.ok(existsSync(`${request.replayRoot}.log`));

      const missing = replay('all-off-baseline-0', 'all-off-baseline', 'baseline');
      assert.equal(missing.status, 0, missing.stderr);
      assert.deepEqual([missing.result.exitCode, missing.result.runnerResult, missing.result.sandbox], [3, null, sandbox.kind]);
      assert.match(missing.result.error, /^runner-result-missing/);

      const slow = replay('only-sleep-0', 'only-sleep', 'candidate-regression', 1);
      assert.equal(slow.status, 0, slow.stderr);
      assert.deepEqual([slow.result.timedOut, slow.result.exitCode, slow.result.runnerResult, slow.result.error], [true, null, null, null]);
      assert.ok(slow.elapsedMs < 25_000, `the 1 s runner budget took ${slow.elapsedMs} ms`);

      const again = replay('all-on-0', 'all-on', 'defect-evidence');
      assert.equal(again.status, 2);
      assert.equal(again.result.sandbox, null);
      assert.match(again.result.error, /^invalid-replay-request: replayRoot .* already exists/);
      console.log(`PASS  sandboxed replay (${sandbox.kind}): runner result captured, outside writes denied and absent, runner env without ARGUS_* variables, missing results and the runner budget reported`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
