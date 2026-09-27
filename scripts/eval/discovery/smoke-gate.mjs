#!/usr/bin/env node
// Recorded-baseline gate smoke: the committed not-recorded baseline, record-baseline.mjs refusals
// and recording, and every gate.mjs outcome (SKIP, PASS, WARN under a waiver, invalid or loosened
// baselines, a changed corpus, a changed plugin without an evaluation, incomparable candidates,
// threshold failures, and the exact threshold boundaries). Everything runs against temporary
// trees through the test-only --root, --plugin-root, and --corpus-digest flags, with synthetic
// discovery summaries; no model is called and no Argus score is claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusDigest, corpusVersion } from './corpus/index.mjs';
import { pluginDigest } from './lib/plugin-digest.mjs';
import { formatSchemaErrors, validateEval } from './lib/schemas.mjs';

const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('./record-baseline.mjs', import.meta.url));
const COMMITTED = fileURLToPath(new URL('./baseline.json', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULTS = Object.freeze({ maxMeanDetectedSeedDrop: 1, maxPrecisionDrop: 0.05, maxRegressionFailToPassDrop: 0.05 });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const CORPUS = corpusDigest();
const BASE_REVISION = 'a'.repeat(40);
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-gate-smoke-')));
const smokeEnv = { ...process.env, ARGUS_EVAL_SMOKE: '1' };
const releaseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ARGUS_EVAL_SMOKE'));
let sequence = 0;

function assertValid(schemaName, document) {
  const errors = validateEval(schemaName, document);
  assert.deepEqual(errors, [], `${schemaName} violation: ${formatSchemaErrors(errors)}`);
}

// A stub Argus plugin root; its digest changes with `content`.
function plugin(name, content) {
  const root = join(work, name);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'argus', version: '5.0.0' })}\n`);
  writeFileSync(join(root, 'agents', 'odysseus.md'), content);
  return { root, digest: pluginDigest(root) };
}

const BASE = plugin('plugin-base', 'Baseline controller prompt.\n');
const NEXT = plugin('plugin-next', 'Changed controller prompt.\n');
const RELIABLE = Object.freeze({ randomSampled: 6, randomReviewed: 6, randomOverturned: 0, overturnRate: 0, maxOverturnRate: 0.1 });

// A discovery-summary@1 per-mode aggregate with the gated values under test.
function aggregate(mode, { seeds = 6, precision = 0.8, failToPass = 0.5, invalidRuns = 0, contaminatedRuns = 0, reliability = RELIABLE } = {}) {
  const measure = { runs: 6, total: 6, mean: 1 };
  return {
    runs: 6, faultyRuns: 3, correctedRuns: 3, seedsPerFaultyRun: 22, meanDetectedSeeds: seeds, meanRecall: seeds / 22, meanCriticalRecall: 0.25,
    perSurfaceRecall: { api: { seeded: 9, detected: 3, recall: 1 / 3 }, authz: { seeded: 15, detected: 6, recall: 0.4 } },
    reported: 10, real: 8, pooledPrecision: precision, falsePositivesOnCorrected: 1, meanRealUnseeded: 0.5, suspectedSeedHits: 0, independentReproduction: 0.5,
    regression: mode === 'A' ? { faultyRuns: 3, replayedRuns: 3, detectedSeeds: 18, withWiredRegression: 12, failToPass: 9, specific: 5, flaky: 1,
      failToPassRate: failToPass, specificRate: 5 / 18, flakyRate: 1 / 18, falseAlarms: 0, baselineGreenOnFixRate: 1 } : null,
    perLane: {}, deliveryDefects: { ledgerMissing: 0, ledgerInvalid: 0, unledgeredReports: 0 },
    usage: { tokens: measure, cost: measure, numTurns: measure, elapsedMs: measure },
    timedOutRuns: 0, overBudgetRuns: 0, controllerTurnCapHits: 0, invalidRuns, contaminatedRuns, judgeReliability: reliability,
  };
}

// A schema-valid discovery-summary@1. Each entry of `variants` is {name, digest, revision?,
// metrics?: {A?, B?}}, where metrics holds the aggregate() options per mode.
function summary({ variants, status = 'scored', modes = ['B'], builds = ['faulty', 'corrected'], seeds = [11, 22, 33], corpus = CORPUS,
  secondsByMode = { A: 28800, B: 14400 }, judge = {}, spotCheck = {}, isolation = 'separate-user', testMode = false, excludedRuns = [],
  createdAt = '2026-09-01T10:00:00.000Z' }) {
  const reasons = { scored: [], 'scored-provisional': [{ code: 'provisional-verdicts', variant: null, runId: null, findingIds: [] }],
    UNSCORED: [{ code: 'mixed-plugin-digest', variant: variants[0].name, runId: null, findingIds: [] }] }[status];
  const document = {
    schema: 'argus-eval/discovery-summary@1', status, reasons, createdAt, corpus: { version: corpusVersion, digest: corpus },
    protocol: {
      modes, builds, repeats: seeds.length, seeds, secondsByMode, tokens: null,
      replay: modes.includes('A') ? { enabled: true, repeats: 2, perSeedMatrix: true, secondsPerRunner: 1800 } : { enabled: false }, testMode,
      judge: { model: 'opus', effort: 'max', passes: 2, systemPromptSha256: sha256('judge system prompt'), claudeVersion: '2.1.283', includeSuspected: true, ...judge },
      spotCheck: { all: false, rate: 0.2, minimum: 5, items: 12, reviewed: 12, pending: 0, ...spotCheck },
    },
    variants: variants.map(variant => ({ name: variant.name, revision: variant.revision ?? 'b'.repeat(40), subject: { pluginVersion: '5.0.0', pluginDigest: variant.digest },
      perMode: status === 'UNSCORED' ? null : Object.fromEntries(modes.map(mode => [mode, aggregate(mode, variant.metrics?.[mode])])) })),
    runs: [], excludedRuns, isolation: { declared: isolation },
    sources: { runsSha256: sha256('runs'), verdictsSha256: sha256('verdicts'), judgeSha256: sha256('judge'), sheetSha256: sha256('sheet') },
  };
  assertValid('discovery-summary', document);
  return document;
}

const baselineSummary = ({ metrics, ...fields } = {}) => summary({ variants: [{ name: 'baseline', digest: BASE.digest, revision: BASE_REVISION, metrics }], ...fields });
const candidateSummary = ({ metrics, ...fields } = {}) => summary({ variants: [{ name: 'candidate', digest: NEXT.digest, metrics }], createdAt: '2026-09-20T10:00:00.000Z', ...fields });

function node(script, args, env = smokeEnv) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8', env, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
}

function expectExit(result, status, pattern, label) {
  assert.equal(result.status, status, `${label}: exit ${result.status}, expected ${status}\n${result.output}`);
  if (pattern) assert.match(result.output, pattern, label);
}

function writeJson(path, document) {
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// A discovery tree holding a copy of the committed not-recorded baseline.
function tree(name) {
  const root = join(work, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'baseline.json'), readFileSync(COMMITTED));
  return root;
}

function record(root, document, { pluginRoot = BASE.root, write = true, variant = document.variants[0].name, extra = [] } = {}) {
  const path = writeJson(join(work, `${basename(root)}-summary-${sequence++}.json`), document);
  return { path, result: node(RECORD, ['--summary', path, '--variant', variant, ...(write ? ['--write'] : []), '--root', root, '--plugin-root', pluginRoot, ...extra]) };
}

// A tree whose recorded baseline measured the BASE plugin.
function recordedTree(name, fields = {}) {
  const root = tree(name);
  const { result } = record(root, baselineSummary(fields));
  expectExit(result, 0, /^PASS {2}record-baseline: recorded argus 5\.0\.0/m, `record ${name}`);
  return root;
}

function addEvaluation(root, name, document) {
  mkdirSync(join(root, 'evaluations'), { recursive: true });
  return writeJson(join(root, 'evaluations', name), document);
}

const gate = (root, { pluginRoot = NEXT.root, args = ['--check'], extra = [], env } = {}) => node(GATE, [...args, '--root', root, '--plugin-root', pluginRoot, ...extra], env);
const editBaseline = (root, edit) => {
  const path = join(root, 'baseline.json');
  const document = readJson(path);
  edit(document);
  writeJson(path, document);
};

try {
  // 1. The committed baseline is schema-valid and never loosens the defaults; while it is not
  // recorded, the real release gate prints SKIP with its reason and passes. A not-recorded
  // temporary tree does the same.
  {
    const committed = readJson(COMMITTED);
    assertValid('discovery-baseline', committed);
    for (const [name, limit] of Object.entries(DEFAULTS)) assert(committed.thresholds[name] <= limit, `the committed ${name} is looser than ${limit}`);
    if (committed.status === 'not-recorded') {
      assert.deepEqual(committed, {
        schema: 'argus-eval/discovery-baseline@1', status: 'not-recorded',
        reason: 'No adjudicated Argus engagement has been recorded against argus-eval-corpus@2; the model-quality gate is inactive until record-baseline.mjs writes a recorded baseline.',
        thresholds: DEFAULTS, waivers: [],
      });
      const release = node(GATE, ['--check'], releaseEnv);
      expectExit(release, 0, /^SKIP {2}discovery gate inactive: baseline not recorded \(No adjudicated Argus engagement has been recorded against argus-eval-corpus@2;/m, 'committed baseline');
    }
    const skipped = gate(tree('not-recorded'));
    expectExit(skipped, 0, /^SKIP {2}discovery gate inactive: baseline not recorded \(/m, 'not-recorded tree');
    const compared = gate(tree('not-recorded-compare'), { args: ['--compare', writeJson(join(work, 'any-summary.json'), candidateSummary())] });
    expectExit(compared, 0, /^SKIP {2}discovery gate inactive/m, 'not-recorded --compare');
    console.log('PASS  gate: the committed baseline is not recorded and valid; a not-recorded baseline prints SKIP and exits 0, never silently');
  }

  // 2. An invalid baseline exits 1: a threshold looser than the default, a recorded-only field
  // in a not-recorded baseline, a missing or symbolically linked file. A tighter threshold is
  // accepted.
  {
    const looser = tree('looser-threshold');
    editBaseline(looser, document => { document.thresholds.maxPrecisionDrop = 0.1; });
    expectExit(gate(looser), 1, /loosens the gate thresholds[\s\S]*maxPrecisionDrop 0\.1 is looser than the default 0\.05/, 'looser threshold');
    const seedLooser = tree('looser-seed-threshold');
    editBaseline(seedLooser, document => { document.thresholds.maxMeanDetectedSeedDrop = 1.5; });
    expectExit(gate(seedLooser), 1, /maxMeanDetectedSeedDrop 1\.5 is looser than the default 1/, 'looser seed threshold');
    const tighter = tree('tighter-threshold');
    editBaseline(tighter, document => { document.thresholds.maxPrecisionDrop = 0.02; });
    expectExit(gate(tighter), 0, /^SKIP {2}/m, 'tighter threshold');
    const extra = tree('not-recorded-extra');
    editBaseline(extra, document => { document.recordedAt = '2026-09-01T10:00:00.000Z'; });
    expectExit(gate(extra), 1, /violates argus-eval\/discovery-baseline@1: .*additional property recordedAt/, 'recorded-only field');
    const noReason = tree('not-recorded-no-reason');
    editBaseline(noReason, document => { delete document.reason; });
    expectExit(gate(noReason), 1, /must have required property reason/, 'missing reason');
    const missing = join(work, 'missing-baseline');
    mkdirSync(missing);
    expectExit(gate(missing), 1, /baseline .*baseline\.json does not exist/, 'missing baseline');
    const linked = join(work, 'linked-baseline');
    mkdirSync(linked);
    symlinkSync(COMMITTED, join(linked, 'baseline.json'));
    expectExit(gate(linked), 1, /must be a regular file/, 'symbolically linked baseline');
    console.log('PASS  gate: a looser threshold, a schema violation, and a missing or linked baseline exit 1; a tighter threshold is accepted');
  }

  // 3. record-baseline.mjs: check mode prints the plan and writes nothing; --write copies the
  // summary byte for byte, rewrites baseline.json (keeping its thresholds, dropping waivers), and
  // the gate then passes for the unchanged plugin. The same summary records again; a different
  // summary never replaces the evaluation copy.
  {
    const root = tree('record');
    editBaseline(root, document => {
      document.thresholds.maxPrecisionDrop = 0.03;
      document.waivers.push({ pluginDigest: sha256('old plugin'), reason: 'Superseded waiver.', approvedBy: 'maintainer-a', createdAt: '2026-08-01T10:00:00.000Z' });
    });
    const before = readFileSync(join(root, 'baseline.json'));
    const document = baselineSummary({ modes: ['A', 'B'], metrics: { A: { seeds: 7, failToPass: 0.6 } } });
    const planned = record(root, document, { write: false });
    expectExit(planned.result, 0, /^PLAN {2}record-baseline: would copy .* and rewrite .*baseline\.json, dropping 1 waiver\(s\) of the previous baseline; pass --write to record/m, 'check mode');
    const plan = JSON.parse(planned.result.stdout);
    assertValid('discovery-baseline', plan);
    assert.deepEqual(readFileSync(join(root, 'baseline.json')), before, 'check mode leaves baseline.json unchanged');
    assert(!existsSync(join(root, 'evaluations')), 'check mode writes no evaluation');

    const written = record(root, document);
    expectExit(written.result, 0, /^PASS {2}record-baseline: recorded argus 5\.0\.0, plugin [a-f0-9]{12} \(variant baseline, revision a{12}\); evaluations\/argus-5\.0\.0-[a-f0-9]{12}\.json copied, dropping 1 waiver/m, 'write');
    const baseline = readJson(join(root, 'baseline.json'));
    assertValid('discovery-baseline', baseline);
    const evaluation = `evaluations/argus-5.0.0-${BASE.digest.slice(0, 12)}.json`;
    assert.deepEqual(readFileSync(join(root, evaluation)), readFileSync(written.path), 'the evaluation is a byte-for-byte copy of the summary');
    assert.deepEqual({ ...baseline, recordedAt: null }, {
      schema: 'argus-eval/discovery-baseline@1', status: 'recorded', recordedAt: null,
      subject: { argusVersion: '5.0.0', pluginDigest: BASE.digest, revision: BASE_REVISION },
      corpus: { version: corpusVersion, digest: CORPUS }, protocol: document.protocol,
      metrics: { perMode: {
        A: { faultyRuns: 3, seedsPerFaultyRun: 22, meanDetectedSeeds: 7, meanRecall: 7 / 22, meanCriticalRecall: 0.25, pooledPrecision: 0.8,
          perSurfaceRecall: document.variants[0].perMode.A.perSurfaceRecall, regression: { failToPassRate: 0.6, specificRate: 5 / 18, flakyRate: 1 / 18 } },
        B: { faultyRuns: 3, seedsPerFaultyRun: 22, meanDetectedSeeds: 6, meanRecall: 6 / 22, meanCriticalRecall: 0.25, pooledPrecision: 0.8,
          perSurfaceRecall: document.variants[0].perMode.B.perSurfaceRecall },
      } },
      summary: { path: evaluation, sha256: sha256(readFileSync(written.path)) }, isolation: { declared: 'separate-user' },
      thresholds: { ...DEFAULTS, maxPrecisionDrop: 0.03 }, waivers: [],
    });
    assert.deepEqual(plan.metrics, baseline.metrics, 'check mode printed the baseline it later wrote');
    expectExit(gate(root, { pluginRoot: BASE.root }), 0, /^PASS {2}discovery gate: plugin unchanged since baseline \(argus 5\.0\.0, plugin [a-f0-9]{12}, recorded /m, 'same digest');

    writeFileSync(join(work, 'record-again.json'), readFileSync(written.path));
    const again = node(RECORD, ['--summary', join(work, 'record-again.json'), '--variant', 'baseline', '--write', '--root', root, '--plugin-root', BASE.root]);
    expectExit(again, 0, /already present/, 'recording the same summary again');
    const other = record(root, baselineSummary({ modes: ['A', 'B'], createdAt: '2026-09-02T10:00:00.000Z' }));
    expectExit(other.result, 1, /already exists with other content; it is never replaced/, 'a different summary for the same plugin');
    console.log('PASS  record-baseline: check mode plans without writing; --write copies the summary, keeps the thresholds, drops old waivers, and never replaces a different evaluation; the gate passes for the same digest');
  }

  // 4. record-baseline.mjs refusals (exit 1, nothing written): provisional, UNSCORED,
  // contaminated, fewer than 3 repeats, testMode, no faulty build, undeclared isolation, too few
  // random spot-check items, a high overturn rate, another plugin, another corpus, and an
  // unknown variant. A complete census satisfies the judge requirement; a same-user isolation
  // records with a warning.
  {
    const root = tree('refusals');
    const before = readFileSync(join(root, 'baseline.json'));
    const refuse = (label, document, pattern, options = {}) => {
      const { result } = record(root, document, options);
      expectExit(result, 1, /^FAIL {2}record-baseline: refusing to record variant baseline of /m, label);
      assert.match(result.output, pattern, label);
      assert.deepEqual(readFileSync(join(root, 'baseline.json')), before, `${label}: baseline.json is unchanged`);
      assert(!existsSync(join(root, 'evaluations')), `${label}: no evaluation is written`);
    };
    refuse('provisional', baselineSummary({ status: 'scored-provisional' }), /the summary is scored-provisional; only a scored summary/);
    refuse('unscored', baselineSummary({ status: 'UNSCORED' }), /the summary is UNSCORED/);
    refuse('contaminated', baselineSummary({ metrics: { B: { contaminatedRuns: 1 } }, excludedRuns: ['r1-B-corrected-baseline'] }),
      /excludes contaminated runs \(r1-B-corrected-baseline\)[\s\S]*mode B has 1 contaminated run\(s\)/);
    refuse('invalid run', baselineSummary({ metrics: { B: { invalidRuns: 1 } } }), /mode B has 1 invalid run\(s\)/);
    refuse('two repeats', baselineSummary({ seeds: [11, 22] }), /ran 2 repeats; a baseline needs at least 3/);
    refuse('test mode', baselineSummary({ testMode: true }), /ran in testMode/);
    refuse('no faulty build', baselineSummary({ builds: ['corrected'] }), /ran no faulty build/);
    refuse('undeclared isolation', baselineSummary({ isolation: null }), /declares no isolation/);
    refuse('small random sample', baselineSummary({ metrics: { B: { reliability: { ...RELIABLE, randomSampled: 3, randomReviewed: 3 } } } }), /sampled 3 random item\(s\); a baseline needs at least 5/);
    refuse('high overturn rate', baselineSummary({ metrics: { B: { reliability: { ...RELIABLE, randomOverturned: 1, overturnRate: 0.2, randomSampled: 5, randomReviewed: 5 } } } }),
      /judge overturn rate 0\.2 is above 0\.1/);
    refuse('other plugin', baselineSummary(), /measured plugin [a-f0-9]{64}, not this working tree's [a-f0-9]{64}/, { pluginRoot: NEXT.root });
    refuse('other corpus', baselineSummary(), /is not the built-in corpus digest/, { extra: ['--corpus-digest', sha256('another corpus')] });
    const unknown = record(root, baselineSummary(), { variant: 'nobody' });
    expectExit(unknown.result, 1, /has no variant nobody \(variants: baseline\)/, 'unknown variant');
    const census = record(root, baselineSummary({ spotCheck: { all: true, rate: null, minimum: null },
      metrics: { B: { reliability: { randomSampled: 0, randomReviewed: 0, randomOverturned: 0, overturnRate: null, maxOverturnRate: 0.1 } } } }), { write: false });
    expectExit(census.result, 0, /^PLAN {2}record-baseline/m, 'census');
    const sameUser = record(root, baselineSummary({ isolation: 'same-user' }), { write: false });
    expectExit(sameUser.result, 0, /^WARN {2}record-baseline: isolation same-user/m, 'same-user isolation');
    const boundary = record(root, baselineSummary({ metrics: { B: { reliability: { ...RELIABLE, randomSampled: 10, randomReviewed: 10, randomOverturned: 1, overturnRate: 0.1 } } } }), { write: false });
    expectExit(boundary.result, 0, /^PLAN {2}/m, 'an overturn rate of exactly 0.10');
    expectExit(node(RECORD, ['--summary', 'x.json']), 64, /missing --variant/, 'record usage');
    expectExit(node(RECORD, ['--summary', 'x.json', '--variant', 'baseline', '--root', root], releaseEnv), 64, /--root is a test-only flag, honored only with ARGUS_EVAL_SMOKE=1/, 'record test-only flag');
    console.log('PASS  record-baseline: refuses provisional, UNSCORED, contaminated, invalid, fewer than 3 repeats, testMode, no faulty build, undeclared isolation, an unreliable judge, another plugin or corpus; accepts a census and an overturn rate of exactly 0.10');
  }

  // 5. A plugin change: exit 3 without an evaluation, WARN and exit 0 under a waiver for that
  // digest (a waiver for another digest does not apply), and invalid or unscored evaluations are
  // named and ignored.
  {
    const root = recordedTree('changed');
    expectExit(gate(root), 3, /^FAIL {2}discovery gate: Argus plugin content changed since the recorded baseline; run the discovery evaluation and commit its summary/m, 'changed digest');
    writeFileSync(join(root, 'evaluations', 'broken.json'), '{"schema":');
    addEvaluation(root, 'provisional.json', candidateSummary({ status: 'scored-provisional' }));
    const ignored = gate(root);
    expectExit(ignored, 3, /^WARN {2}discovery gate: ignoring evaluations\/broken\.json: .*not valid JSON/m, 'broken evaluation');
    assert.match(ignored.output, /^WARN {2}discovery gate: ignoring evaluations\/provisional\.json: it measured plugin [a-f0-9]{12} but is scored-provisional, not scored/m);
    editBaseline(root, document => {
      document.waivers.push({ pluginDigest: sha256('unrelated plugin'), reason: 'Unrelated.', approvedBy: 'maintainer-a', createdAt: '2026-09-10T10:00:00.000Z' });
    });
    expectExit(gate(root), 3, /Argus plugin content changed/, 'a waiver for another digest');
    editBaseline(root, document => {
      document.waivers.push({ pluginDigest: NEXT.digest, reason: 'Wording-only prompt fix; evaluation scheduled.', approvedBy: 'maintainer-b', createdAt: '2026-09-11T10:00:00.000Z' });
    });
    expectExit(gate(root), 0, /^WARN {2}discovery gate: plugin [a-f0-9]{12} changed since the baseline .* and has no discovery evaluation; waived by maintainer-b on 2026-09-11T10:00:00\.000Z: Wording-only prompt fix/m, 'waiver');
    addEvaluation(root, 'candidate.json', candidateSummary({ metrics: { B: { seeds: 4.5 } } }));
    expectExit(gate(root), 4, /B meanDetectedSeeds: .* FAIL/, 'a waiver never overrides a failing evaluation');
    console.log('PASS  gate: a changed plugin without an evaluation exits 3; a waiver for its digest gives WARN and exit 0; invalid and unscored evaluations are named and ignored');
  }

  // 6. Threshold checks against a committed evaluation of the changed plugin: a 1.5-seed drop, a
  // 0.06 precision drop, a null candidate precision, and a Mode A fail-to-pass drop of 0.1 exit 4
  // with one delta line per metric; drops of exactly 1.0 seed and 0.05 precision pass (0.75 - 0.7
  // is not exactly 0.05 in floating point); improvements pass; the baseline's tighter threshold
  // applies.
  {
    const check = (name, { baseline = {}, candidate = {}, status, patterns = [] }) => {
      const root = recordedTree(name, baseline);
      addEvaluation(root, 'candidate.json', candidateSummary(candidate));
      const result = gate(root);
      expectExit(result, status, null, name);
      for (const pattern of patterns) assert.match(result.output, pattern, name);
      return result;
    };
    check('seed-drop', { candidate: { metrics: { B: { seeds: 4.5 } } }, status: 4, patterns: [
      /^ {2}B meanDetectedSeeds: baseline 6, candidate 4\.5, delta -1\.5 \(max drop 1\) FAIL$/m,
      /^ {2}B pooledPrecision: baseline 0\.8, candidate 0\.8, delta 0 \(max drop 0\.05\) ok$/m,
      /^FAIL {2}discovery gate: 1 discovery metric dropped beyond the recorded baseline thresholds$/m,
    ] });
    check('precision-drop', { candidate: { metrics: { B: { precision: 0.74 } } }, status: 4, patterns: [
      /^ {2}B pooledPrecision: baseline 0\.8, candidate 0\.74, delta -0\.06 \(max drop 0\.05\) FAIL$/m,
    ] });
    assert(0.75 - 0.7 > 0.05, 'the boundary case exercises floating-point error');
    check('boundary', { baseline: { metrics: { B: { precision: 0.75 } } }, candidate: { metrics: { B: { seeds: 5, precision: 0.7 } } }, status: 0, patterns: [
      /^ {2}B meanDetectedSeeds: baseline 6, candidate 5, delta -1 \(max drop 1\) ok$/m,
      /^ {2}B pooledPrecision: baseline 0\.75, candidate 0\.7, delta -0\.05 \(max drop 0\.05\) ok$/m,
      /^PASS {2}discovery gate: evaluations\/candidate\.json is within the recorded baseline thresholds$/m,
    ] });
    check('improvement', { candidate: { metrics: { B: { seeds: 9, precision: 0.95 } } }, status: 0, patterns: [
      /^ {2}B meanDetectedSeeds: baseline 6, candidate 9, delta \+3 \(max drop 1\) ok$/m,
    ] });
    check('null-candidate-precision', { candidate: { metrics: { B: { precision: null } } }, status: 4, patterns: [
      /^ {2}B pooledPrecision: baseline 0\.8, candidate null, delta n\/a \(max drop 0\.05\) FAIL \(no candidate value\)$/m,
    ] });
    check('null-baseline-precision', { baseline: { metrics: { B: { precision: null } } }, candidate: { metrics: { B: { precision: 0.1 } } }, status: 0, patterns: [
      /^ {2}B pooledPrecision: baseline null, candidate 0\.1, delta n\/a \(max drop 0\.05\) ok \(no baseline value\)$/m,
    ] });
    check('mode-a-fail-to-pass', { baseline: { modes: ['A', 'B'] }, candidate: { modes: ['A', 'B'], metrics: { A: { failToPass: 0.4 } } }, status: 4, patterns: [
      /^ {2}A regression\.failToPassRate: baseline 0\.5, candidate 0\.4, delta -0\.1 \(max drop 0\.05\) FAIL$/m,
      /^ {2}A meanDetectedSeeds: baseline 6, candidate 6, delta 0 \(max drop 1\) ok$/m,
      /^ {2}B meanDetectedSeeds: baseline 6, candidate 6, delta 0 \(max drop 1\) ok$/m,
    ] });
    check('mode-a-boundary', { baseline: { modes: ['A', 'B'] }, candidate: { modes: ['A', 'B'], metrics: { A: { failToPass: 0.45 } } }, status: 0 });
    const tight = recordedTree('tighter-recorded');
    editBaseline(tight, document => { document.thresholds.maxPrecisionDrop = 0.03; });
    addEvaluation(tight, 'candidate.json', candidateSummary({ metrics: { B: { precision: 0.76 } } }));
    expectExit(gate(tight), 4, /B pooledPrecision: baseline 0\.8, candidate 0\.76, delta -0\.04 \(max drop 0\.03\) FAIL/, 'a tighter baseline threshold');
    console.log('PASS  gate: 1.5-seed, 0.06 precision, null-precision, and Mode A 0.1 fail-to-pass drops exit 4 with every delta printed; exact 1.0 and 0.05 drops and improvements pass; tighter thresholds apply');
  }

  // 7. Corpus and comparability: a corpus changed since the baseline exits 2 before anything
  // else; a candidate with other seeds, fewer repeats, a missing mode or build, another budget,
  // judge, or testMode exits 2 with one line per problem; more repeats that begin with the
  // baseline seeds stay comparable; the newest matching evaluation is compared.
  {
    const corpus = recordedTree('corpus-changed');
    expectExit(gate(corpus, { extra: ['--corpus-digest', sha256('another corpus')] }), 2, /^FAIL {2}discovery gate: corpus changed since baseline; re-record$/m, 'corpus mismatch');
    expectExit(gate(corpus, { pluginRoot: BASE.root, extra: ['--corpus-digest', sha256('another corpus')] }), 2, /corpus changed since baseline/, 'corpus mismatch with the same plugin');

    const seeds = recordedTree('seeds-mismatch');
    addEvaluation(seeds, 'candidate.json', candidateSummary({ seeds: [11, 22, 44] }));
    expectExit(gate(seeds), 2, /^FAIL {2}discovery gate: incomparable: evaluations\/candidate\.json does not follow the baseline protocol\n {2}seeds \[11, 22, 44\] do not begin with the baseline seeds \[11, 22, 33\]$/m, 'seeds mismatch');

    const protocol = recordedTree('protocol-mismatch', { modes: ['A', 'B'] });
    addEvaluation(protocol, 'candidate.json', candidateSummary({ modes: ['B'], builds: ['faulty'], seeds: [11, 22], secondsByMode: { A: 28800, B: 7200 },
      judge: { passes: 1, systemPromptSha256: sha256('another prompt') }, testMode: true, corpus: sha256('another corpus') }));
    const incomparable = gate(protocol);
    expectExit(incomparable, 2, /incomparable/, 'protocol mismatch');
    for (const pattern of [/corpus digest [a-f0-9]{12} differs from the baseline's/, /modes \[B\] lack the baseline's \[A\]/, /builds \[faulty\] lack the baseline's \[corrected\]/,
      /2 repeats, fewer than the baseline's 3/, /seeds \[11, 22\] do not begin/, /secondsByMode .* differs/, /judge passes 1 differs from the baseline's 2/,
      /judge systemPromptSha256 [a-f0-9]{64} differs/, /the candidate is a testMode comparison/]) {
      assert.match(incomparable.output, pattern);
    }

    const longer = recordedTree('more-repeats');
    addEvaluation(longer, 'candidate.json', candidateSummary({ seeds: [11, 22, 33, 44] }));
    expectExit(gate(longer), 0, /^PASS {2}discovery gate/m, 'more repeats beginning with the baseline seeds');

    const newest = recordedTree('newest');
    addEvaluation(newest, 'a-old.json', candidateSummary({ metrics: { B: { seeds: 4 } }, createdAt: '2026-09-10T10:00:00.000Z' }));
    addEvaluation(newest, 'b-new.json', candidateSummary({ createdAt: '2026-09-15T10:00:00.000Z' }));
    const picked = gate(newest);
    expectExit(picked, 0, /2 scored evaluations measured plugin [a-f0-9]{12}; comparing the newest, evaluations\/b-new\.json/, 'newest evaluation');
    console.log('PASS  gate: a changed corpus and every protocol mismatch exit 2; more repeats beginning with the baseline seeds stay comparable; the newest matching evaluation is compared');
  }

  // 8. The recorded summary guards baseline.json: hand-edited metrics, a missing or altered
  // summary, and metrics for modes the protocol lacks exit 1.
  {
    const edited = recordedTree('edited-metrics');
    editBaseline(edited, document => { document.metrics.perMode.B.meanDetectedSeeds = 2; });
    expectExit(gate(edited, { pluginRoot: BASE.root }), 1, /does not match its recorded summary .*; record it again with record-baseline\.mjs/, 'edited metrics');
    const removed = recordedTree('removed-summary');
    rmSync(join(removed, 'evaluations'), { recursive: true });
    expectExit(gate(removed, { pluginRoot: BASE.root }), 1, /recorded summary .* does not exist/, 'removed summary');
    const altered = recordedTree('altered-summary');
    const path = join(altered, readJson(join(altered, 'baseline.json')).summary.path);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    expectExit(gate(altered, { pluginRoot: BASE.root }), 1, /has SHA-256 [a-f0-9]{64}, not the baseline's/, 'altered summary');
    const modes = recordedTree('mode-mismatch');
    editBaseline(modes, document => { document.protocol.modes = ['A', 'B']; });
    expectExit(gate(modes, { pluginRoot: BASE.root }), 1, /records metrics for modes \[B\], not for its protocol modes \[A, B\]/, 'metrics without their protocol modes');
    console.log('PASS  gate: hand-edited metrics, a missing or altered recorded summary, and inconsistent modes exit 1');
  }

  // 9. --compare: a scored summary is compared directly; a two-variant summary needs --variant;
  // an unscored summary exits 1. A plugin tree the digest refuses exits 1. Usage errors and
  // test-only flags without ARGUS_EVAL_SMOKE=1 exit 64.
  {
    const root = recordedTree('compare');
    const failing = writeJson(join(work, 'compare-failing.json'), candidateSummary({ metrics: { B: { seeds: 4.5 } } }));
    expectExit(gate(root, { args: ['--compare', failing] }), 4, /candidate: .*compare-failing\.json, variant candidate[\s\S]*B meanDetectedSeeds: .* FAIL/, 'compare');
    const paired = writeJson(join(work, 'compare-paired.json'), summary({ variants: [{ name: 'baseline', digest: BASE.digest, revision: BASE_REVISION },
      { name: 'candidate', digest: NEXT.digest, metrics: { B: { precision: 0.78 } } }] }));
    expectExit(gate(root, { args: ['--compare', paired] }), 64, /has 2 variants; name one with --variant/, 'compare without --variant');
    expectExit(gate(root, { args: ['--compare', paired, '--variant', 'candidate'] }), 0, /^PASS {2}discovery gate: .*compare-paired\.json is within/m, 'compare with --variant');
    expectExit(gate(root, { args: ['--compare', paired, '--variant', 'nobody'] }), 1, /has no variant nobody/, 'compare with an unknown variant');
    const provisional = writeJson(join(work, 'compare-provisional.json'), candidateSummary({ status: 'scored-provisional' }));
    expectExit(gate(root, { args: ['--compare', provisional] }), 1, /is scored-provisional; only a scored summary can be compared/, 'compare provisional');

    const broken = plugin('plugin-linked', 'Linked prompt.\n');
    symlinkSync(join(broken.root, 'agents', 'odysseus.md'), join(broken.root, 'agents', 'alias.md'));
    expectExit(gate(root, { pluginRoot: broken.root }), 1, /cannot digest the Argus plugin root .* is not a regular file or directory/, 'plugin tree with a symbolic link');

    for (const [args, pattern] of [[[], /pass exactly one of --check and --compare/], [['--check', '--compare', failing], /pass exactly one/],
      [['--check', '--variant', 'candidate'], /--variant applies only to --compare/], [['--check', '--check'], /--check was given twice/],
      [['--frobnicate'], /unknown argument --frobnicate/], [['--compare'], /--compare requires a value/],
      [['--check', '--corpus-digest', 'XYZ'], /--corpus-digest must be a lowercase hex SHA-256/]]) {
      expectExit(node(GATE, args), 64, pattern, `usage ${args.join(' ')}`);
    }
    for (const flag of [['--root', root], ['--plugin-root', BASE.root], ['--corpus-digest', CORPUS]]) {
      expectExit(node(GATE, ['--check', ...flag], releaseEnv), 64, new RegExp(`${flag[0]} is a test-only flag, honored only with ARGUS_EVAL_SMOKE=1`), `${flag[0]} without ARGUS_EVAL_SMOKE`);
    }
    console.log('PASS  gate: --compare checks one summary (naming a variant when there are two); an unscored summary or an undigestable plugin exits 1; usage errors and test-only flags outside smoke tests exit 64');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
