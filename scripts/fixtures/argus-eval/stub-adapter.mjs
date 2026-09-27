#!/usr/bin/env node
// Test-only host adapter for scripts/eval/discovery/smoke-replay.mjs. It is NOT an agent and it
// is NOT sandboxed: it runs the replayed framework directly, so it refuses to run unless
// ARGUS_EVAL_SMOKE=1 (listed in the smoke configuration's adapterEnv) and reports the test-only
// sandbox value that run.mjs accepts only in testMode.
//
// Usage (run.mjs appends the last one or two arguments):
//   stub-adapter.mjs [--behavior <name>] <hunt-request.json>
//   stub-adapter.mjs [--behavior <name>] replay <replay-request.json>
// Behaviors: normal (default); replay-no-result (the replay phase writes no replay result).
//
// Hunt: writes a valid ledger with BUG-0001 (origin ATA-001, confirmed, wired, REG-0001) and
// BUG-0002 (origin ATA-002, confirmed, wired, REG-0002), one report each, and a regression
// framework (run-tests.sh plus scripts/runner-contract.sh) whose node check POSTs quantity
// limit+1 to /api/orders: BUG-0001 fails with category product on 201 and passes on 422,
// BUG-0002 always fails with category product. Baseline mode runs no regression case.
// Replay: copies the framework to the replay root, runs `bash run-tests.sh --mode <runnerMode>`
// there with API_URL set to the target, and writes argus-eval/replay-result@1.
import { spawn } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSchemaErrors, validateArgus, validateEval } from '../../eval/discovery/lib/schemas.mjs';

const PRIVATE_KEYS = ['truth', 'seed', 'seeds', 'build', 'enabledSeeds', 'faulty', 'enabled'];
const FRAMEWORK = 'regression';
const MAX_RUNNER_RESULT_BYTES = 5 * 1024 * 1024;

const fail = message => {
  process.stderr.write(`stub adapter: ${message}\n`);
  process.exit(9);
};
if (process.env.ARGUS_EVAL_SMOKE !== '1') fail('test-only and unsandboxed; refusing to run without ARGUS_EVAL_SMOKE=1');

const args = process.argv.slice(2);
let behavior = 'normal';
if (args[0] === '--behavior') {
  behavior = args[1];
  args.splice(0, 2);
}
if (!['normal', 'replay-no-result'].includes(behavior)) fail(`unknown behavior ${behavior}`);

const readRequest = (path, schema) => {
  const request = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateEval(schema, request);
  if (errors.length) fail(`invalid ${schema}: ${formatSchemaErrors(errors)}`);
  for (const key of PRIVATE_KEYS) if (key in request) fail(`private key leaked: ${key}`);
  return request;
};
const physical = path => realpathSync(path) === path;
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const writeAtomically = (path, document) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
};
const write = (root, path, content, mode = 0o644) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, { mode });
};

// The bug rows follow the packaged example ledger, which the Argus schema gate keeps valid.
function ledger(runId) {
  const example = JSON.parse(readFileSync(fileURLToPath(new URL('../../../argus/framework-template/solution/bug-ledger.example.json', import.meta.url)), 'utf8'));
  const template = example.bugs.find(bug => bug.status === 'confirmed' && bug.wired);
  if (!template) fail('the example ledger has no confirmed, wired row');
  const row = (id, origin, testId, title) => ({ ...structuredClone(template), id, origin: [origin], lane: 'atalanta', testId, title });
  return {
    ...example,
    engagementId: `eval-${runId}`,
    bugs: [
      row('BUG-0001', 'ATA-001', 'REG-0001', 'Order quantity above the published limit is accepted'),
      row('BUG-0002', 'ATA-002', 'REG-0002', 'Order confirmation omits the promised delivery window'),
    ],
  };
}

const RUN_TESTS = `#!/usr/bin/env bash
# Stub regression runner for the replay smoke: run-tests.sh --mode <runner mode>.
set -u
mode=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="\${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
cd "$(dirname "$0")" || exit 12
exec node checks/regression.mjs "$mode"
`;

const RUNNER_CONTRACT = `#!/usr/bin/env bash
# Stub runner contract marker: checks/regression.mjs writes reports/argus-runner-result.json itself.
exit 0
`;

// Dependency-free check: the events and exit codes follow the Argus runner contract.
const CHECK = `import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (!['baseline', 'defect-evidence', 'candidate-regression'].includes(mode)) process.exit(14);
const target = process.env.API_URL;
const events = [];
const event = (caseId, status, expected, lifecycle, bugId, reason) => events.push({ caseId, category: 'product', status, expected, lifecycle, bugId, reason });
const contract = await (await fetch(target + '/contract')).json();
if (mode === 'baseline') {
  event('TST-0001', contract.application ? 'pass' : 'fail', false, 'n/a', null, 'contract-published');
} else {
  const evidence = mode === 'defect-evidence';
  const limit = contract.modules.orders.quantityLimit;
  const response = await fetch(target + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity: limit + 1 }) });
  await response.arrayBuffer();
  const accepted = response.status === 201;
  event('REG-0001', accepted ? 'fail' : 'pass', evidence, accepted ? (evidence ? 'reproduced' : 'automated') : (evidence ? 'n/a' : 'fixed'), 'BUG-0001', accepted ? 'quantity-above-limit-accepted' : 'quantity-above-limit-rejected');
  event('REG-0002', 'fail', evidence, evidence ? 'reproduced' : 'automated', 'BUG-0002', 'delivery-window-missing');
}
const failed = events.some(item => item.status === 'fail');
const exitCode = mode === 'defect-evidence' ? (events.every(item => item.status === 'fail') ? 0 : 10) : (failed ? 10 : 0);
mkdirSync('reports', { recursive: true });
writeFileSync('reports/argus-runner-result.json', JSON.stringify({
  $schema: 'argus/runner-result@1', schemaVersion: 1, mode, status: exitCode === 0 ? 'pass' : 'fail', exitCode,
  categories: { product: events.length, automation: 0, infrastructure: 0, skip: 0, policy: 0 },
  events, generatedAt: new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z'), deliveryGate: false, missingExpectedBugs: 0,
}, null, 2));
process.exit(exitCode);
`;

function hunt(requestPath) {
  const request = readRequest(requestPath, 'hunt-request');
  if (!physical(request.artifactRoot) || readdirSync(request.artifactRoot).length) fail('the artifact root must be physical and empty');
  const root = request.artifactRoot;
  write(root, 'solution/bug-ledger.json', `${JSON.stringify(ledger(request.runId), null, 2)}\n`);
  write(root, 'bugs/ATA-001-quantity-limit.md', '# Order quantity above the published limit is accepted\n');
  write(root, 'bugs/ATA-002-delivery-window.md', '# Order confirmation omits the promised delivery window\n');
  write(root, `${FRAMEWORK}/run-tests.sh`, RUN_TESTS, 0o755);
  write(root, `${FRAMEWORK}/scripts/runner-contract.sh`, RUNNER_CONTRACT, 0o755);
  write(root, `${FRAMEWORK}/checks/regression.mjs`, CHECK);
  writeFileSync(request.logPath, `stub adapter hunt ${request.runId}\n`);
  writeAtomically(request.resultPath, {
    schema: 'argus-eval/adapter-result@2', status: 'completed', launcherExitCode: 0,
    usage: { source: 'claude-cli-result-json', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, numTurns: 1, controllerTurnCapHit: false },
    subject: { pluginVersion: null, pluginDigest: null }, reason: null, launchAssurance: 'unattested',
  });
}

function runTests(replayRoot, runnerMode, target, seconds) {
  return new Promise(done => {
    let timedOut = false;
    const child = spawn('bash', ['run-tests.sh', '--mode', runnerMode], {
      cwd: replayRoot, detached: true, stdio: ['ignore', 'ignore', 'inherit'],
      env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: join(replayRoot, '.tmp'), API_URL: target, UI_URL: target, CI: '1' },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, seconds * 1000);
    child.once('error', () => {
      clearTimeout(timer);
      done({ exitCode: null, timedOut });
    });
    child.once('close', code => {
      clearTimeout(timer);
      done({ exitCode: code, timedOut });
    });
  });
}

async function replay(requestPath) {
  const request = readRequest(requestPath, 'replay-request');
  if (!physical(request.frameworkRoot) || !lstatSync(request.frameworkRoot).isDirectory()) fail('frameworkRoot must be a physical directory');
  if (!physical(dirname(request.replayRoot))) fail('the replay root parent must be physical');
  let exists = true;
  try { lstatSync(request.replayRoot); } catch { exists = false; }
  if (exists) fail('the replay root must not exist');
  if (inside(request.replayRoot, request.resultPath)) fail('the result path is inside the replay root');
  // The seal is observable from here because this stub is unsandboxed; record it for the smoke.
  const output = dirname(dirname(dirname(dirname(request.replayRoot))));
  let sealState;
  try {
    readdirSync(join(output, 'sealed'));
    sealState = 'sealed:readable';
  } catch (error) {
    sealState = `sealed:${error.code}`;
  }
  cpSync(request.frameworkRoot, request.replayRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  mkdirSync(join(request.replayRoot, '.tmp'));
  writeFileSync(join(request.replayRoot, 'seal-state.txt'), `${sealState}\n`);
  const { exitCode, timedOut } = await runTests(request.replayRoot, request.runnerMode, request.target, request.seconds);
  if (behavior === 'replay-no-result') return;
  let runnerResult = null;
  let error = null;
  const resultFile = join(request.replayRoot, 'reports', 'argus-runner-result.json');
  try {
    const stat = lstatSync(resultFile);
    if (!stat.isFile() || stat.size > MAX_RUNNER_RESULT_BYTES) throw new Error('not a regular file within 5 MB');
    const document = JSON.parse(readFileSync(resultFile, 'utf8'));
    const errors = validateArgus('runner-result', document);
    if (errors.length) throw new Error(`violates runner-result@1: ${formatSchemaErrors(errors)}`);
    runnerResult = document;
  } catch (reason) {
    if (!timedOut) error = `runner-result-unusable: ${reason.message}`;
  }
  writeAtomically(request.resultPath, {
    schema: 'argus-eval/replay-result@1', case: request.case, runnerMode: request.runnerMode, exitCode, timedOut,
    sandbox: 'unsandboxed-test-stub', runnerResult, error,
  });
}

if (args[0] === 'replay' && args.length === 2) await replay(args[1]);
else if (args.length === 1) hunt(args[0]);
else fail('usage: stub-adapter.mjs [--behavior <name>] <hunt-request.json> | replay <replay-request.json>');
