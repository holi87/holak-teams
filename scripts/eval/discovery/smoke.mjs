#!/usr/bin/env node
import assert from 'node:assert/strict';
import { seedIds } from './corpus/index.mjs';
// Live corpus fixtures (seeded defects, correct lookalikes, seed independence) are covered by
// smoke-corpus.mjs, and scoring metrics and the adjudicate.mjs contract by smoke-adjudicate.mjs.
// Scripted harness validation only; no Argus model score is claimed.

// Exercise the comparison CLI protocol (argus-eval/comparison-config@2) without pretending the
// stub is an agent: public request only, evaluator-side extraction, sealing, contamination.
const { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join, relative } = await import('node:path');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { spawnSync } = await import('node:child_process');
const { createHash } = await import('node:crypto');
const { normalizeConfig } = await import('./lib/config.mjs');
const { pathForms, scanArtifacts } = await import('./lib/contamination.mjs');
const { formatSchemaErrors, validateEval } = await import('./lib/schemas.mjs');

const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url));
const ADJUDICATE = fileURLToPath(new URL('./adjudicate.mjs', import.meta.url));
const SCHEMAS_URL = pathToFileURL(fileURLToPath(new URL('./lib/schemas.mjs', import.meta.url))).href;
const PRIVATE_KEYS = ['truth', 'seed', 'seeds', 'build', 'enabledSeeds', 'faulty', 'enabled'];
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-protocol-')));
const mode = path => statSync(path).mode & 0o777;

// Restores every sealed/ directory so a failed assertion never leaves an undeletable tree.
function reopen(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === 'sealed' && entry.isDirectory()) chmodSync(path, 0o700);
    if (entry.isDirectory() && !entry.isSymbolicLink()) reopen(path);
  }
}

const STUB = `import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { formatSchemaErrors, validateEval } from ${JSON.stringify(SCHEMAS_URL)};
const [behavior, requestPath] = process.argv.slice(2);
const fail = message => { process.stderr.write('protocol stub: ' + message + '\\n'); process.exit(9); };
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const errors = validateEval('hunt-request', request);
if (errors.length) fail('invalid hunt request: ' + formatSchemaErrors(errors));
for (const key of ${JSON.stringify(PRIVATE_KEYS)}) if (key in request) fail('private key leaked: ' + key);
if (process.env.ARGUS_EVAL_SMOKE !== undefined || process.env.ARGUS_EVAL_SMOKE_UNLISTED !== undefined) fail('an unlisted variable reached the adapter');
if (process.env.ARGUS_EVAL_SMOKE_LISTED !== 'present') fail('a listed adapterEnv variable was dropped');
if (realpathSync(request.artifactRoot) !== request.artifactRoot) fail('artifactRoot is not physical');
for (const key of ['resultPath', 'usagePath', 'logPath']) if (realpathSync(dirname(request[key])) !== dirname(request[key])) fail(key + ' is not physical');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
for (const key of ['resultPath', 'usagePath', 'logPath']) if (inside(request.artifactRoot, request[key])) fail(key + ' is inside the artifact root');
if (readdirSync(request.artifactRoot).length) fail('artifact root is not empty');
if ((statSync(request.artifactRoot).mode & 0o777) !== 0o700) fail('artifact root is not 0700');
const response = await fetch(request.contractUrl);
if (!response.ok) fail('application unreachable');
const outputRoot = dirname(dirname(dirname(request.artifactRoot)));
const usage = { source: 'claude-cli-result-json', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, numTurns: 1, controllerTurnCapHit: false };
const result = { schema: 'argus-eval/adapter-result@2', status: 'completed', launcherExitCode: 0, usage, subject: { pluginVersion: null, pluginDigest: null }, reason: null, launchAssurance: 'unattested' };
const note = (name, text) => writeFileSync(join(request.artifactRoot, name), text);
switch (behavior) {
  case 'normal': break;
  case 'forge':
  case 'forge-only':
    note('result.json', JSON.stringify({ ...result, usage: { ...usage, totalTokens: 999999 }, findings: [{ id: 'FORGED-1' }], tokens: 999999 }));
    if (behavior === 'forge-only') process.exit(0);
    break;
  case 'benign': note('notes.txt', 'Probe notes for quantity-boundary written under ' + request.artifactRoot + '/reports\\n'); break;
  case 'tainted': note('notes.txt', 'Answer key: tenant-authz.mjs and ' + outputRoot + '/sealed/canary.txt\\n'); break;
  case 'sleep': writeFileSync('pid.txt', String(process.pid)); await new Promise(done => setTimeout(done, 30000)); break;
  case 'straggler': {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    writeFileSync('straggler.pid', String(child.pid));
    child.unref();
    break;
  }
  case 'sealed-probe':
    try { readdirSync(join(outputRoot, 'sealed')); result.reason = 'sealed:readable'; } catch (error) { result.reason = 'sealed:' + error.code; }
    break;
  case 'attested': result.launchAssurance = 'attested'; break;
  case 'bogus-assurance': result.launchAssurance = 'bogus'; break;
  case 'refused': Object.assign(result, { status: 'launcher-refused', launcherExitCode: 1, reason: 'host has trust material; an attested adapter is required' }); break;
  case 'heavy': Object.assign(usage, { inputTokens: 6, outputTokens: 4, totalTokens: 10, costUsd: 0.5 }); break;
  default: fail('unknown behavior ' + behavior);
}
writeFileSync(request.logPath, 'protocol stub ' + behavior + '\\n');
writeFileSync(request.resultPath, JSON.stringify(result));
`;

const outputs = [];
try {
  const stub = join(work, 'protocol-stub.mjs');
  writeFileSync(stub, STUB);
  const variant = (name, behavior, digit = '0') => ({ name, revision: digit.repeat(40), command: [process.execPath, stub, behavior] });
  const base = { schema: 'argus-eval/comparison-config@2', testMode: true, workRoot: work, secondsByMode: { A: 30, B: 30 }, adapterEnv: ['ARGUS_EVAL_SMOKE_LISTED'] };
  const harness = (name, config, output = join(work, `${name}-output`)) => {
    const configPath = join(work, `${name}.json`);
    writeFileSync(configPath, JSON.stringify({ ...base, ...config }));
    const run = spawnSync(process.execPath, [RUN, configPath, output], { encoding: 'utf8', timeout: 120000,
      env: { ...process.env, ARGUS_EVAL_SMOKE: '1', ARGUS_EVAL_SMOKE_LISTED: 'present', ARGUS_EVAL_SMOKE_UNLISTED: 'leak' } });
    const line = run.stdout.trim().split('\n').at(-1);
    assert(line, `${name}: run.mjs printed no summary (status ${run.status}): ${run.stderr}`);
    const summary = JSON.parse(line);
    outputs.push(dirname(dirname(summary.privateResults)));
    const document = JSON.parse(readFileSync(summary.privateResults, 'utf8'));
    const errors = validateEval('private-runs', document);
    assert.deepEqual(errors, [], `${name}: private-runs@2 violation: ${formatSchemaErrors(errors)}`);
    return { status: run.status, stderr: run.stderr, summary, document, runs: document.runs };
  };

  // Configuration rules the schema alone cannot express.
  {
    const raw = { schema: 'argus-eval/comparison-config@2', variants: [variant('baseline', 'normal')], repeats: 2 };
    const defaults = normalizeConfig(raw, { baseDir: work, env: {} });
    assert.deepEqual([defaults.modes, defaults.builds, defaults.secondsByMode, defaults.tokens, defaults.adapterEnv, defaults.seeds, defaults.replay],
      [['B'], ['faulty', 'corrected'], { A: 28800, B: 14400 }, null, [], null, { enabled: false }]);
    assert.equal(defaults.workRoot, realpathSync(tmpdir()), 'workRoot defaults to the physical temporary directory');
    const rejects = (change, pattern, env = {}) => assert.throws(() => normalizeConfig({ ...raw, ...change }, { baseDir: work, env }), pattern);
    rejects({ adapterEnv: ['ANTHROPIC_API_KEY', 'HOME'] }, /must not list HOME/);
    rejects({ adapterEnv: ['lowercase'] }, /adapterEnv/);
    rejects({ seeds: [1, 2, 3] }, /one seed per repeat/);
    rejects({ seeds: [0, 2] }, /seeds/);
    rejects({ secondsByMode: { B: 60 } }, /secondsByMode/);
    rejects({ testMode: true }, /ARGUS_EVAL_SMOKE=1/);
    rejects({ variants: [variant('same', 'normal'), variant('same', 'normal')] }, /distinct/);
    rejects({ variants: [{ ...variant('relative', 'normal'), command: ['node'] }] }, /absolute/);
    rejects({ variants: [variant('a', 'normal'), variant('b', 'normal'), variant('c', 'normal')] }, /variants/);
    rejects({ modes: ['C'] }, /modes/);
    rejects({ repeats: 1 }, /repeats/);
    rejects({ tokens: 0 }, /tokens/);
    rejects({ replay: { enabled: true } }, /replay/);
    rejects({ seconds: 600 }, /additional property seconds/);
    mkdirSync(join(work, 'real-root'));
    symlinkSync(join(work, 'real-root'), join(work, 'alias-root'));
    rejects({ workRoot: join(work, 'alias-root') }, /workRoot/);
    rejects({ workRoot: `${work}/real-root/../real-root` }, /physical/);
    const test = normalizeConfig({ ...raw, testMode: true, secondsByMode: { B: 1 } }, { baseDir: work, env: { ARGUS_EVAL_SMOKE: '1' } });
    assert.deepEqual([test.testMode, test.secondsByMode.B], [true, 1]);
    const configPath = join(work, 'gated.json');
    writeFileSync(configPath, JSON.stringify({ ...base, variants: [variant('baseline', 'normal')], repeats: 2 }));
    const { ARGUS_EVAL_SMOKE: _omitted, ...cleanEnv } = process.env;
    const gated = spawnSync(process.execPath, [RUN, configPath, join(work, 'gated-output')], { encoding: 'utf8', env: cleanEnv });
    assert.notEqual(gated.status, 0);
    assert.match(gated.stderr, /testMode is reserved/);
    assert(!existsSync(join(work, 'gated-output')), 'a rejected configuration creates no output');
    console.log('PASS  comparison-config@2: defaults (A 8 h, B 4 h, uncapped measured tokens), smoke-only testMode, reserved adapter variables, pinned seeds, physical workRoot');
  }

  // Contamination matching: path-bounded evaluator paths, the canary, and the run's own root.
  {
    const root = join(work, 'scan-root');
    mkdirSync(root);
    writeFileSync(join(root, 'a.txt'), `own root ${root}/x and a sibling ${work}/repo-other/file`);
    assert.equal(scanArtifacts(root, { forbiddenPaths: [join(work, 'repo')] }).status, 'clean', 'forbidden paths match whole path components only');
    writeFileSync(join(root, 'b.txt'), `read ${join(work, 'repo')}/scripts`);
    assert.equal(scanArtifacts(root, { forbiddenPaths: [join(work, 'repo')] }).status, 'contaminated');
    rmSync(join(root, 'b.txt'));
    assert.equal(scanArtifacts(root, { forbiddenPaths: [work] }).status, 'contaminated', 'only the artifact root itself is exempt');
    writeFileSync(join(root, 'c.bin'), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('ARGUS-EVAL-CANARY-0123')]));
    const canary = scanArtifacts(root, { canary: 'ARGUS-EVAL-CANARY-0123' });
    assert.deepEqual([canary.status, canary.hits.map(hit => hit.kind)], ['contaminated', ['canary']]);
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dep.txt'), 'tenant-authz.mjs');
    assert.equal(scanArtifacts(root, { corpusFileNames: ['tenant-authz.mjs'] }).status, 'clean', 'node_modules is not scanned');
    assert.deepEqual(pathForms('/definitely/not/private'), ['/definitely/not/private']);
    console.log('PASS  contamination scan: canary, path-bounded evaluator paths, artifact-root exemption, node_modules skipped');
  }

  // 1. Protocol: 2 variants x 2 pinned repeats x modes A and B x faulty and corrected = 16 runs.
  {
    const { status, stderr, summary, document, runs } = harness('protocol', {
      variants: [variant('baseline', 'normal', '0'), variant('candidate', 'normal', '1')], modes: ['A', 'B'], repeats: 2, seeds: [11, 22],
    }, 'protocol-output');
    assert.equal(status, 0, stderr);
    const output = dirname(dirname(summary.privateResults));
    assert.equal(output, join(work, 'protocol-output'), 'a relative output directory is created under workRoot');
    assert.deepEqual([summary.runs, summary.status, summary.statuses, summary.assuranceMismatch], [16, 'UNSCORED', { 'awaiting-adjudication': 16 }, undefined]);
    assert.equal(runs.length, 16);
    assert.equal(new Set(runs.map(run => run.runId)).size, 16);
    assert.equal(new Set(runs.map(run => run.publicId)).size, 16, 'every run gets its own public ID');
    for (const dir of [output, join(output, 'sealed'), join(output, 'sealed', 'runs'), join(output, 'active')]) assert.equal(mode(dir), 0o700, `${dir} must be 0700`);
    assert.deepEqual(readdirSync(join(output, 'active')), [], 'completed runs leave active/');
    assert.equal(mode(summary.privateResults), 0o600);
    const canaryText = readFileSync(join(output, 'sealed', 'canary.txt'), 'utf8').trim();
    assert.match(canaryText, /^ARGUS-EVAL-CANARY-[0-9a-f]{32}$/);
    assert.equal(createHash('sha256').update(canaryText).digest('hex'), document.canarySha256);
    assert.equal(document.corpus.version, 'argus-eval-corpus@2');
    assert.match(document.corpus.digest, /^[0-9a-f]{64}$/);
    for (const run of runs) {
      const faulty = run.build === 'faulty';
      assert.equal(run.status, 'awaiting-adjudication', run.reason);
      assert.equal(run.extraction.ledger, 'missing');
      assert.deepEqual([run.extraction.findings, run.extraction.suspected], [[], []]);
      assert.equal(run.contamination.status, 'clean');
      assert.equal(run.seed, [11, 22][run.repeat], 'pinned seeds are used per repeat');
      assert.equal(run.truth.length, faulty ? seedIds.length : 0, 'faulty builds carry every seed as private truth; corrected builds none');
      assert.deepEqual(run.enabledSeeds, faulty ? [...seedIds] : []);
      assert.equal(run.launchAssurance, 'unattested');
      assert.deepEqual(run.adapter.envNames.filter(name => name.startsWith('ARGUS_')), ['ARGUS_EVAL_SMOKE_LISTED']);
      assert.equal(run.adapter.result.usage.totalTokens, 0);
      assert.equal(run.artifactRoot, join(output, 'sealed', 'runs', run.runId, 'artifacts'));
      assert(existsSync(run.artifactRoot) && existsSync(join(dirname(run.artifactRoot), 'launcher.log')));
      const request = JSON.parse(readFileSync(join(dirname(run.artifactRoot), 'request.json'), 'utf8'));
      assert.deepEqual(PRIVATE_KEYS.filter(key => key in request), []);
      // Blindness by value, not only by key: the public ID names the active/ directory, the
      // request, and the engagement ID, and no value reveals the build, variant, or seeds.
      assert.match(run.publicId, /^[0-9a-f]{16}$/);
      assert.deepEqual([request.runId, request.engagementId], [run.publicId, `eval-${run.publicId}`]);
      assert.equal(request.artifactRoot, join(output, 'active', run.publicId, 'artifacts'));
      const visible = JSON.stringify(request);
      for (const word of ['faulty', 'corrected', 'baseline', 'candidate', run.runId, ...seedIds]) {
        assert(!visible.includes(word), `${run.runId}: the public hunt request reveals ${word}`);
      }
      assert.equal(mode(join(dirname(run.artifactRoot), 'request.json')), 0o600);
      assert.equal(request.budget.seconds, 30);
      assert.equal(request.budget.tokens, null);
      assert.equal(new URL(request.target).port, String(run.port));
      assert.equal(run.contract.application, 'argus-eval-suite');
    }
    assert.deepEqual([...new Set(runs.map(run => run.mode))], ['A', 'B']);
    const order = repeat => runs.filter(run => run.repeat === repeat && run.mode === 'A' && run.build === 'faulty').map(run => run.variant);
    assert.deepEqual([order(0), order(1)], [['baseline', 'candidate'], ['candidate', 'baseline']], 'execution order alternates per repeat');

    // The stub reports no findings, so final verdicts bound to these private runs are empty.
    const digest = value => createHash('sha256').update(value).digest('hex');
    const verdictFile = join(work, 'final-verdicts.json');
    const finalVerdicts = {
      schema: 'argus-eval/final-verdicts@1', status: 'final', createdAt: new Date().toISOString(), runsSha256: digest(readFileSync(summary.privateResults)),
      judgeSha256: digest('protocol judge verdicts'), sheetSha256: digest('protocol spot-check sheet'),
      judge: { model: 'opus', effort: 'max', passes: 2, claudeVersion: '2.1.283', systemPromptSha256: digest('judge system prompt'), includeSuspected: false },
      spotCheck: { all: true, samplingSeed: null, rate: null, minimum: null, items: 0, reviewed: 0, pending: 0 },
      reliability: { randomSampled: 0, randomReviewed: 0, randomOverturned: 0, overturnRate: null, maxOverturnRate: 0.1 },
      runs: runs.map(run => ({ runId: run.runId, verdicts: [] })),
    };
    assert.deepEqual(validateEval('final-verdicts', finalVerdicts), []);
    writeFileSync(verdictFile, JSON.stringify(finalVerdicts));
    const summaryFile = join(work, 'discovery-summary.json');
    const adjudicated = spawnSync(process.execPath, [ADJUDICATE, '--runs', summary.privateResults, '--verdicts', verdictFile, '--output', summaryFile], { encoding: 'utf8', timeout: 10000 });
    assert.equal(adjudicated.status, 0, adjudicated.stderr);
    const scored = JSON.parse(readFileSync(summaryFile, 'utf8'));
    assert.deepEqual(validateEval('discovery-summary', scored), []);
    assert.deepEqual([scored.status, scored.protocol.seeds, scored.runs.length], ['scored', [11, 22], 16]);
    assert.deepEqual(scored.variants.map(row => row.name), ['baseline', 'candidate']);
    for (const row of scored.variants) {
      for (const runMode of ['A', 'B']) {
        const aggregate = row.perMode[runMode];
        assert.deepEqual([aggregate.runs, aggregate.faultyRuns, aggregate.correctedRuns, aggregate.seedsPerFaultyRun], [4, 2, 2, seedIds.length]);
        assert.deepEqual([aggregate.meanDetectedSeeds, aggregate.meanRecall, aggregate.reported, aggregate.pooledPrecision], [0, 0, 0, null]);
      }
      assert.deepEqual([row.perMode.A.regression.faultyRuns, row.perMode.A.regression.replayedRuns, row.perMode.A.regression.failToPassRate], [2, 0, null]);
      assert.equal(row.perMode.B.regression, null);
    }
    console.log('PASS  16 paired comparison protocol runs (modes A and B, faulty and corrected, pinned seeds): public request only, opaque public run IDs (no build, variant, or seed in any request value or path), physical 0700 layout, evaluator-side extraction; an empty stub earns zero recall and null pooled precision');
  }

  // 2. A result.json forged inside artifacts/ has no effect: usage and findings come only from
  // the evaluator-owned result path and the ledger.
  {
    const { status, runs } = harness('forge', { variants: [variant('honest', 'forge', '0'), variant('forger', 'forge-only', '1')], builds: ['faulty'], repeats: 2 });
    assert.equal(status, 1, 'a run without an evaluator-side result fails the comparison');
    for (const run of runs.filter(item => item.variant === 'honest')) {
      assert.equal(run.status, 'awaiting-adjudication');
      assert.equal(run.adapter.result.usage.totalTokens, 0);
      assert.deepEqual(run.extraction.findings, []);
    }
    for (const run of runs.filter(item => item.variant === 'forger')) {
      assert.equal(run.status, 'invalid-run');
      assert.match(run.reason, /no result\.json/);
    }
    console.log('PASS  a result.json forged inside the artifact root is ignored');
  }

  // 3. Contamination: a corpus file name or an evaluator path is contaminated; a seed ID and the
  // run's own artifact root path are only suspect.
  {
    const { status, runs } = harness('contamination', { variants: [variant('benign', 'benign', '0'), variant('tainted', 'tainted', '1')], builds: ['corrected'], repeats: 2 });
    assert.equal(status, 1);
    for (const run of runs.filter(item => item.variant === 'benign')) {
      assert.equal(run.status, 'awaiting-adjudication');
      assert.equal(run.contamination.status, 'suspect');
      assert.deepEqual(run.contamination.hits, [{ kind: 'seed-id', file: 'notes.txt', match: 'quantity-boundary' }]);
    }
    for (const run of runs.filter(item => item.variant === 'tainted')) {
      assert.equal(run.status, 'contaminated');
      assert.deepEqual(run.contamination.hits.map(hit => hit.kind).sort(), ['corpus-file', 'forbidden-path']);
      assert(run.contamination.hits.some(hit => hit.match === 'tenant-authz.mjs'));
    }
    console.log('PASS  contamination: corpus file name and evaluator path give contaminated; a seed ID only suspect');
  }

  // 4. Budget: the process group is killed at the mode budget and the run is timed-out, still
  // extracted; after a normal exit, stragglers in the adapter group are killed too.
  {
    const { status, stderr, runs } = harness('timeout', { variants: [variant('sleeper', 'sleep', '0'), variant('straggler', 'straggler', '1')], builds: ['faulty'], repeats: 2, secondsByMode: { B: 1 } });
    assert.equal(status, 0, stderr);
    for (const run of runs.filter(item => item.variant === 'sleeper')) {
      assert.deepEqual([run.status, run.timedOut, run.adapter.resultState, run.adapter.signal, run.extraction.ledger], ['timed-out', true, 'missing', 'SIGKILL', 'missing']);
      assert(run.elapsedMs >= 1000 && run.elapsedMs < 20000, `elapsed ${run.elapsedMs}`);
      const pid = Number(readFileSync(join(dirname(run.artifactRoot), 'pid.txt'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    for (const run of runs.filter(item => item.variant === 'straggler')) {
      assert.equal(run.status, 'awaiting-adjudication');
      const pid = Number(readFileSync(join(dirname(run.artifactRoot), 'straggler.pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'a straggler of the adapter group survived');
    }
    console.log('PASS  a 1 s budget kills the adapter group (timed-out, still extracted); stragglers die before sealed/ reopens');
  }

  // 5. Sealing: private state is unreadable while the adapter runs.
  if (process.getuid?.() === 0) {
    console.log('SKIP  sealed directory EACCES check: running as uid 0 bypasses file modes');
  } else {
    const { status, runs, summary } = harness('sealed', { variants: [variant('probe', 'sealed-probe')], builds: ['faulty'], repeats: 2 });
    assert.equal(status, 0);
    assert(runs.every(run => run.adapter.result.reason === 'sealed:EACCES'), runs.map(run => run.adapter.result.reason).join(', '));
    assert.equal(mode(dirname(summary.privateResults)), 0o700, 'sealed/ is reopened after the run');
    console.log('PASS  sealed/ is chmod 000 while the adapter runs (EACCES) and 0700 afterwards');
  }

  // 6. Launch assurance: paired variants must share it; an unknown value or a non-completed
  // adapter status is an invalid run.
  {
    const mixed = harness('assurance', { variants: [variant('attested', 'attested', '0'), variant('unattested', 'normal', '1')], builds: ['faulty'], repeats: 2 });
    assert.equal(mixed.status, 1);
    assert.equal(mixed.summary.assuranceMismatch, true);
    assert(mixed.runs.every(run => run.status === 'awaiting-adjudication' && run.launchAssurance === run.variant));
    const invalid = harness('invalid', { variants: [variant('bogus', 'bogus-assurance', '0'), variant('refused', 'refused', '1')], builds: ['faulty'], repeats: 2 });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.summary.assuranceMismatch, undefined);
    assert(invalid.runs.every(run => run.status === 'invalid-run'));
    assert(invalid.runs.filter(run => run.variant === 'bogus').every(run => run.adapter.resultState === 'invalid' && run.launchAssurance === 'unreported'));
    assert(invalid.runs.filter(run => run.variant === 'refused').every(run => /launcher-refused/.test(run.reason)));
    console.log('PASS  launch assurance: mismatched paired variants flag assuranceMismatch; unknown values and refused launches are invalid runs');
  }

  // 7. Token cap: exceeding it is a flag, not an invalid run. Random seeds are recorded, and an
  // output path given through a symbolic link alias is created at its physical location.
  {
    mkdirSync(join(work, 'physical-parent'));
    symlinkSync(join(work, 'physical-parent'), join(work, 'aliased-parent'));
    const { status, runs, summary } = harness('budget', { variants: [variant('heavy', 'heavy')], builds: ['faulty'], repeats: 2, tokens: 5 }, join(work, 'aliased-parent', 'out'));
    assert.equal(status, 0);
    assert.equal(summary.privateResults, join(work, 'physical-parent', 'out', 'sealed', 'private-runs.json'));
    assert(runs.every(run => run.status === 'awaiting-adjudication' && run.overBudget === true));
    assert(runs.every(run => Number.isInteger(run.seed) && run.seed >= 1 && run.seed <= 999999));
    assert(lstatSync(join(work, 'physical-parent', 'out')).isDirectory());
    assert.equal(relative(join(work, 'physical-parent'), dirname(dirname(runs[0].artifactRoot))).split('/')[0], 'out');
    console.log('PASS  an exceeded token cap is flagged overBudget; random seeds are recorded; the output path is physical');
  }
} finally {
  for (const output of outputs) if (existsSync(output)) reopen(output);
  rmSync(work, { recursive: true, force: true });
}
