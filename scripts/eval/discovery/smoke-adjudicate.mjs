#!/usr/bin/env node
// Adjudication and scoring v2 smoke: per-run metrics (recall, critical recall, per-surface and
// per-lane counts, precision with false positives and duplicates, suspected seed hits,
// reproduction), regression fidelity from a synthetic replay, pooled aggregates, and the
// adjudicate.mjs CLI contract (bindings, evidence containment, UNSCORED, provisional, contaminated
// and invalid runs, mixed plugin digests). Synthetic private runs and final verdicts only; no
// model is called and no Argus score is claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusDigest, corpusVersion, seedIds, truthFor } from './corpus/index.mjs';
import { planReplayCases, summarizeReplay } from './lib/replay.mjs';
import { formatSchemaErrors, validateEval } from './lib/schemas.mjs';
import { aggregateRuns, scoreRun } from './score.mjs';

const ADJUDICATE = fileURLToPath(new URL('./adjudicate.mjs', import.meta.url));
const STARTED = Date.UTC(2026, 0, 1, 12, 0, 0);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const DIGEST = sha256('synthetic plugin tree');
const OTHER_DIGEST = sha256('another plugin tree');
// Seeds credited below, with their corpus surface and severity.
const S1 = 'quantity-boundary'; // api, Critical
const S2 = 'cross-owner-read'; // authz, Critical
const S3 = 'event-duplicate-emission'; // events, Major
const S4 = 'event-missing-on-cancel'; // events, Major
const S5 = 'ui-cart-total'; // ui, Major
const SB = 'a11y-missing-label'; // a11y, Major
const TEXT_MARKERS = ['Synthetic finding', 'Judge reason', 'Human reason', 'bugs/'];
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-adjudicate-smoke-')));
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} is not ${expected}`);

function row(number, { lane = 'atalanta', status = 'confirmed', wired = false } = {}) {
  const id = `BUG-${String(number).padStart(4, '0')}`;
  const origin = `${lane.slice(0, 3).toUpperCase()}-${String(number).padStart(3, '0')}`;
  return { id, origin: [origin], lane, severity: 'Major', status, wired, testId: wired ? `REG-${id.slice(4)}` : null,
    title: `Synthetic finding ${id}`, reportPath: `bugs/${origin}.md`, evidenceIds: [], confirmedAtMs: 1000 + number };
}

const judge = (finding, outcome, { seedId = null, duplicateOf = null, confidence = 'high' } = {}) => ({
  findingId: finding.id, status: finding.status, outcome, seedId, duplicateOf, source: 'judge', confidence,
  reason: `Judge reason for ${finding.id}.`, evidenceRef: null, humanReproduced: null, reviewer: null, overturned: null,
});

// `evidence` names a file the fixture creates: 'artifact:<name>' inside the run's artifact root or
// 'repro:<name>' inside <runsDir>/repro/.
const human = (finding, outcome, { seedId = null, duplicateOf = null, reproduced = false, evidence = null } = {}) => ({
  findingId: finding.id, status: finding.status, outcome, seedId, duplicateOf, source: 'human', confidence: null,
  reason: `Human reason for ${finding.id}.`, evidenceRef: evidence, humanReproduced: reproduced, reviewer: 'reviewer-a', overturned: false,
});

const usage = (fields = {}) => ({ source: 'claude-cli-result-json', inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 1000, costUsd: 2.5, numTurns: 40, controllerTurnCapHit: false, ...fields });

// A completed replay over the planned cases (2 repeats, per-seed matrix); `outcomes(plan)` gives
// each case's per-bug outcomes, and a case catching any bug exits 1.
function replayFor(artifactRoot, truth, outcomes) {
  const cases = planReplayCases(truth, { repeats: 2, perSeedMatrix: true }).map(plan => {
    const bugs = outcomes(plan);
    return { case: plan.case, k: plan.k, runnerMode: plan.runnerMode, exitCode: Object.values(bugs).includes('caught') ? 1 : 0, timedOut: false,
      status: 'completed', bugs, infrastructureFailures: 0, sandbox: 'macos-sandbox-exec', reason: null };
  });
  return { status: 'completed', frameworkRoot: join(artifactRoot, 'qa'), reason: null, cases };
}

// r0-A-faulty: BUG-0001 fails on every faulty repeat, passes on the fix and is specific to S1;
// BUG-0002 fails everywhere (a false alarm); BUG-0003 flips between faulty repeats (flaky);
// BUG-0005 is fail-to-pass but also caught by the S4-only build (not specific).
const onlySeed = plan => (plan.case.startsWith('only-') ? plan.case.slice('only-'.length) : null);
const r0Outcomes = plan => ({
  'BUG-0001': plan.case === 'all-on' || onlySeed(plan) === S1 ? 'caught' : 'passed',
  'BUG-0002': 'caught',
  'BUG-0003': (plan.case === 'all-on' && plan.k === 0) || onlySeed(plan) === S2 ? 'caught' : 'passed',
  'BUG-0005': plan.case === 'all-on' || [S3, S4].includes(onlySeed(plan)) ? 'caught' : 'passed',
  'BUG-0006': 'passed',
});

// One variant, modes A and B, both builds, two repeats. Each plan lists its ledger rows and their
// final verdicts.
function plans() {
  const a = [row(1, { wired: true }), row(2), row(3, { lane: 'proteus', wired: true }), row(4, { lane: 'proteus' }), row(5, { lane: 'proteus' }),
    row(6, { lane: 'ariadne' }), row(7, { lane: 'ariadne', status: 'suspected' }), row(8, { lane: 'ariadne', status: 'needs-oracle' })];
  const c = [row(1), row(2, { lane: 'proteus' })];
  const b = [row(1, { lane: 'metis' }), row(2, { lane: 'metis' })];
  const t = [row(1, { lane: 'metis' })];
  return [
    { runId: 'r0-A-faulty-baseline', rows: a, replay: r0Outcomes, verdicts: [
      human(a[0], 'real', { seedId: S1, reproduced: true, evidence: 'artifact:repro-BUG-0001.txt' }),
      human(a[1], 'real', { evidence: 'repro:r0-A-faulty-baseline-BUG-0002.txt' }),
      judge(a[2], 'real', { seedId: S2 }),
      judge(a[3], 'duplicate', { duplicateOf: 'BUG-0001' }),
      judge(a[4], 'real', { seedId: S3, confidence: 'medium' }),
      judge(a[5], 'false-positive'),
      judge(a[6], 'real', { seedId: S5 }),
      judge(a[7], 'real', { seedId: S1 }),
    ] },
    { runId: 'r0-A-corrected-baseline', rows: c, verdicts: [judge(c[0], 'false-positive'), human(c[1], 'real', { reproduced: true, evidence: 'artifact:repro-BUG-0002.txt' })] },
    { runId: 'r1-A-faulty-baseline', rows: [], replay: () => ({}), usage: usage({ controllerTurnCapHit: true }), verdicts: [] },
    { runId: 'r1-A-corrected-baseline', rows: [], verdicts: [] },
    { runId: 'r0-B-faulty-baseline', rows: b, verdicts: [judge(b[0], 'real', { seedId: SB }), judge(b[1], 'real', { seedId: S1 })] },
    { runId: 'r0-B-corrected-baseline', rows: [], verdicts: [] },
    { runId: 'r1-B-faulty-baseline', status: 'timed-out', rows: t, verdicts: [judge(t[0], 'real', { seedId: SB })] },
    { runId: 'r1-B-corrected-baseline', rows: [], verdicts: [] },
  ];
}

function makeRun(sealed, plan) {
  const [, repeat, mode, build, variant] = /^r([0-9]+)-([AB])-(faulty|corrected)-(.+)$/.exec(plan.runId);
  const status = plan.status ?? 'awaiting-adjudication';
  const enabledSeeds = build === 'faulty' ? [...seedIds] : [];
  const truth = truthFor(enabledSeeds);
  const artifactRoot = join(sealed, 'runs', plan.runId, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const reported = status !== 'timed-out' && status !== 'invalid-run';
  const result = reported ? { schema: 'argus-eval/adapter-result@2', status: 'completed', launcherExitCode: 0, usage: plan.usage ?? usage(),
    subject: { pluginVersion: '5.0.0', pluginDigest: plan.digest ?? DIGEST }, reason: null, launchAssurance: 'unattested' } : null;
  return {
    runId: plan.runId, variant, revision: 'a'.repeat(40), repeat: Number(repeat), seed: 100 + Number(repeat), mode, build, enabledSeeds, truth,
    url: 'http://127.0.0.1:40000', port: 40000, contract: { rules: ['Synthetic public rule.'] }, status,
    reason: status === 'awaiting-adjudication' ? null : `smoke fixture: ${status}`, launchAssurance: 'unattested',
    startedAt: new Date(STARTED).toISOString(), elapsedMs: 60_000, timedOut: status === 'timed-out', overBudget: false, artifactRoot,
    adapter: { envNames: ['HOME', 'PATH', 'TMPDIR'], exitCode: reported ? 0 : null, signal: status === 'timed-out' ? 'SIGKILL' : null,
      spawnError: status === 'invalid-run' ? 'smoke fixture: no adapter' : null, resultState: reported ? 'valid' : 'missing', resultErrors: [], result },
    extraction: { ledger: 'present', ledgerErrors: [], findings: plan.rows.filter(item => item.status === 'confirmed'),
      suspected: plan.rows.filter(item => item.status !== 'confirmed'), unledgeredReports: build === 'corrected' && mode === 'A' ? ['bugs/stray.md'] : [],
      framework: { root: plan.replay ? 'qa' : null, candidates: plan.replay ? 1 : 0 } },
    contamination: { status: status === 'contaminated' ? 'contaminated' : 'clean', hits: [], totalHits: 0, scannedFiles: 3, skippedFiles: 0 },
    replay: plan.replay ? replayFor(artifactRoot, truth, plan.replay) : null,
  };
}

function finalVerdicts(runsSha256, runs, fields = {}) {
  return {
    schema: 'argus-eval/final-verdicts@1', status: 'final', createdAt: new Date(STARTED + 86_400_000).toISOString(), runsSha256,
    judgeSha256: sha256('synthetic judge verdicts'), sheetSha256: sha256('synthetic spot-check sheet'),
    judge: { model: 'opus', effort: 'max', passes: 2, claudeVersion: '2.1.283', systemPromptSha256: sha256('judge system prompt'), includeSuspected: true },
    spotCheck: { all: false, samplingSeed: 12345, rate: 0.2, minimum: 5, items: 8, reviewed: 8, pending: 0 },
    reliability: { randomSampled: 5, randomReviewed: 5, randomOverturned: 0, overturnRate: 0, maxOverturnRate: 0.1 },
    runs, ...fields,
  };
}

function assertValid(schemaName, document) {
  const errors = validateEval(schemaName, document);
  assert.deepEqual(errors, [], `${schemaName} violation: ${formatSchemaErrors(errors)}`);
}

// Builds and writes one fixture under work/<name>. `adjust.plans(plans)` edits the plans before
// the runs are built; `adjust.runs(runs)` and `adjust.verdicts(document)` edit the documents
// before they are written (the private-runs bytes are hashed after adjust.runs).
function fixture(name, adjust = {}) {
  const root = join(work, name);
  const sealed = join(root, 'sealed');
  mkdirSync(join(sealed, 'repro'), { recursive: true, mode: 0o700 });
  const planList = plans();
  adjust.plans?.(planList);
  const runs = planList.map(plan => makeRun(sealed, plan));
  const verdictRuns = planList.map((plan, index) => ({
    runId: plan.runId,
    verdicts: plan.verdicts.map(verdict => {
      if (verdict.evidenceRef === null) return { ...verdict };
      const [where, file] = verdict.evidenceRef.split(':');
      const path = where === 'artifact' ? join(runs[index].artifactRoot, file) : join(sealed, 'repro', file);
      writeFileSync(path, `Independent reproduction record for ${verdict.findingId}.\n`);
      return { ...verdict, evidenceRef: path };
    }),
  }));
  adjust.runs?.(runs, sealed);
  const privateRuns = {
    schema: 'argus-eval/private-runs@2', createdAt: new Date(STARTED).toISOString(),
    config: { schema: 'argus-eval/comparison-config@2', variants: [{ name: 'baseline', revision: 'a'.repeat(40), command: ['/bin/true'] }],
      modes: ['A', 'B'], builds: ['faulty', 'corrected'], repeats: 2, seeds: [100, 101], secondsByMode: { A: 28800, B: 14400 }, tokens: null,
      workRoot: work, adapterEnv: ['ANTHROPIC_API_KEY'], replay: { enabled: true, repeats: 2, perSeedMatrix: true, secondsPerRunner: 1800 },
      corpusModule: null, testMode: false },
    corpus: { version: corpusVersion, digest: corpusDigest() }, canarySha256: sha256('smoke canary'), runs,
  };
  assertValid('private-runs', privateRuns);
  const runsPath = join(sealed, 'private-runs.json');
  const runsBytes = `${JSON.stringify(privateRuns, null, 2)}\n`;
  writeFileSync(runsPath, runsBytes, { mode: 0o600 });
  const verdicts = finalVerdicts(sha256(runsBytes), verdictRuns);
  adjust.verdicts?.(verdicts, sealed);
  assertValid('final-verdicts', verdicts);
  const verdictsPath = join(root, 'final-verdicts.json');
  writeFileSync(verdictsPath, `${JSON.stringify(verdicts, null, 2)}\n`, { mode: 0o600 });
  return { root, sealed, runsPath, verdictsPath, runs, verdicts, output: join(root, 'discovery-summary.json') };
}

function adjudicate(args) {
  const result = spawnSync(process.execPath, [ADJUDICATE, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function run(fx, extra = []) {
  const result = adjudicate(['--runs', fx.runsPath, '--verdicts', fx.verdictsPath, '--output', fx.output, ...extra]);
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(fx.output, 'utf8'));
  } catch {
    // No output was written.
  }
  if (summary) assertValid('discovery-summary', summary);
  return { ...result, summary };
}

const verdictsFor = (fx, runId) => fx.verdicts.runs.find(entry => entry.runId === runId).verdicts;
const runOf = (fx, runId) => fx.runs.find(entry => entry.runId === runId);

try {
  // 1. scoreRun: the real seeded finding, the real unseeded finding (not penalized), a false
  // positive, a duplicate, suspected seed hits excluded from recall, per-surface and per-lane
  // counts, reproduction, and regression fidelity from the synthetic replay.
  {
    const fx = fixture('unit');
    const faulty = runOf(fx, 'r0-A-faulty-baseline');
    const replay = summarizeReplay(faulty.replay);
    assert.deepEqual(replay.bugs['BUG-0001'], { failsOnFaulty: true, passesOnFix: true, flaky: false, specificTo: [S1], falseAlarm: false });
    assert.deepEqual(replay.bugs['BUG-0005'].specificTo, [S3, S4]);
    const scored = scoreRun(faulty, verdictsFor(fx, faulty.runId), replay);
    assert.equal(scored.status, 'scored');
    const m = scored.metrics;
    assert.deepEqual([m.seeded, m.detectedSeeds, m.detectedSeedIds], [22, 3, [S1, S2, S3]]);
    near(m.recall, 3 / 22, 'recall');
    assert.deepEqual([m.criticalSeeded, m.criticalRecall], [8, 2 / 8]);
    assert.deepEqual(m.perSurface, { a11y: { seeded: 4, detected: 0 }, api: { seeded: 3, detected: 1 }, authz: { seeded: 5, detected: 1 },
      events: { seeded: 4, detected: 1 }, perf: { seeded: 3, detected: 0 }, ui: { seeded: 3, detected: 0 } });
    assert.deepEqual([m.reported, m.real, m.realUnseeded, m.falsePositive, m.duplicate], [6, 4, 1, 1, 1], 'the unseeded real finding counts as real');
    near(m.precision, 4 / 6, 'precision');
    assert.deepEqual([m.suspected, m.suspectedSeedHits], [2, 1], 'only the seed credited solely through a suspected row is a suspected seed hit');
    assert(!m.detectedSeedIds.includes(S5), 'a suspected seed hit is excluded from recall');
    assert.deepEqual(m.perLane, {
      ariadne: { reported: 1, real: 0, falsePositive: 1, duplicate: 0, seedsDetected: 0 },
      atalanta: { reported: 2, real: 2, falsePositive: 0, duplicate: 0, seedsDetected: 1 },
      proteus: { reported: 3, real: 2, falsePositive: 0, duplicate: 1, seedsDetected: 2 },
    });
    assert.deepEqual(m.reproduction, { human: 1, replay: 1, none: 2, byFinding: { 'BUG-0001': 'human', 'BUG-0002': 'none', 'BUG-0003': 'none', 'BUG-0005': 'replay' } });
    assert.equal(m.independentReproduction, 0.5);
    assert.deepEqual(m.regression, {
      replayStatus: 'completed',
      seeds: {
        [S1]: { bugs: ['BUG-0001'], hasWiredRegression: true, failToPass: true, specific: true, flaky: false },
        [S2]: { bugs: ['BUG-0003'], hasWiredRegression: true, failToPass: false, specific: false, flaky: true },
        [S3]: { bugs: ['BUG-0005'], hasWiredRegression: false, failToPass: true, specific: false, flaky: false },
      },
      falseAlarms: 1,
      baselineGreenOnFix: false,
    });
    assert.deepEqual(m.usage, { tokens: 1000, cost: 2.5, numTurns: 40, controllerTurnCapHit: false, elapsedMs: 60_000, timedOut: false, overBudget: false });
    assert.deepEqual(m.deliveryDefects, { ledger: 'present', unledgeredReports: 0 });
    const hostile = structuredClone(faulty);
    hostile.extraction.findings[5].lane = 'constructor';
    const hostileRun = { status: hostile.status, build: hostile.build, scoring: 'scored', metrics: scoreRun(hostile, verdictsFor(fx, faulty.runId), replay).metrics };
    assert.deepEqual(hostileRun.metrics.perLane.constructor, { reported: 1, real: 0, falsePositive: 1, duplicate: 0, seedsDetected: 0 });
    assert.equal(aggregateRuns([hostileRun], { mode: 'A', judgeReliability: fx.verdicts.reliability }).perLane.constructor.precision, 0);
    assert.equal(Object.prototype.reported, undefined, 'a lane name from the ledger never reaches Object.prototype');

    const empty = scoreRun(runOf(fx, 'r1-A-faulty-baseline'), [], summarizeReplay(runOf(fx, 'r1-A-faulty-baseline').replay)).metrics;
    assert.deepEqual([empty.reported, empty.precision, empty.recall, empty.independentReproduction], [0, null, 0, null], 'a zero-report run has null precision');
    assert.deepEqual([empty.regression.seeds, empty.regression.baselineGreenOnFix], [{}, true]);
    const timedOut = scoreRun(runOf(fx, 'r1-B-faulty-baseline'), verdictsFor(fx, 'r1-B-faulty-baseline'), null);
    assert.equal(timedOut.status, 'scored', 'a timed-out run without measured usage stays scorable');
    assert.deepEqual([timedOut.metrics.usage.tokens, timedOut.metrics.usage.timedOut, timedOut.metrics.regression], [null, true, null]);

    const missing = scoreRun(faulty, verdictsFor(fx, faulty.runId).filter(verdict => verdict.findingId !== 'BUG-0003'), replay);
    assert.deepEqual(missing, { status: 'unscored', reason: 'missing-verdict', missingVerdicts: ['BUG-0003'] });
    const withoutSuspected = scoreRun(faulty, verdictsFor(fx, faulty.runId).filter(verdict => verdict.status === 'confirmed'), replay);
    assert.deepEqual([withoutSuspected.status, withoutSuspected.metrics.suspectedSeedHits], ['scored', 0], 'unjudged suspected rows do not block scoring');
    const base = verdictsFor(fx, faulty.runId);
    const edit = (index, fields) => base.map((verdict, position) => (position === index ? { ...verdict, ...fields } : verdict));
    assert.throws(() => scoreRun(faulty, [...base, base[0]], replay), /more than one verdict/);
    assert.throws(() => scoreRun(faulty, edit(0, { findingId: 'BUG-0099' }), replay), /no extracted ledger row/);
    assert.throws(() => scoreRun(faulty, edit(0, { status: 'suspected' }), replay), /ledger row is confirmed/);
    assert.throws(() => scoreRun(runOf(fx, 'r0-A-corrected-baseline'), [{ ...verdictsFor(fx, 'r0-A-corrected-baseline')[1], seedId: S1 }], null), /unknown seed/);
    assert.throws(() => scoreRun(faulty, edit(5, { seedId: S1 }), replay), /only a real outcome/);
    assert.throws(() => scoreRun(faulty, edit(3, { duplicateOf: 'BUG-0004' }), replay), /duplicateOf/);

    // Pooled precision is sum(real) / sum(reported): 5 of 8 here, not the 0.583 mean of the two
    // runs that reported anything.
    const results = fx.runs.filter(entry => entry.mode === 'A').map(entry => {
      const outcome = scoreRun(entry, verdictsFor(fx, entry.runId), summarizeReplay(entry.replay));
      return { status: entry.status, build: entry.build, scoring: 'scored', metrics: outcome.metrics };
    });
    const aggregate = aggregateRuns(results, { mode: 'A', judgeReliability: fx.verdicts.reliability });
    assert.deepEqual([aggregate.reported, aggregate.real, aggregate.pooledPrecision], [8, 5, 5 / 8]);
    near(results.filter(entry => entry.metrics.precision !== null).reduce((sum, entry) => sum + entry.metrics.precision, 0) / 2, 7 / 12, 'mean per-run precision');
    console.log('PASS  scoreRun: seeded, unseeded (not penalized), false-positive and duplicate findings, suspected seed hits outside recall, per-surface and per-lane counts, reproduction, fail-to-pass, specific, flaky and false-alarm regressions, pooled precision');
  }

  // 2. The CLI on a complete, final comparison: exit 0 and a schema-valid discovery-summary@1
  // with pooled per-mode aggregates and IDs and counts only.
  {
    const fx = fixture('scored');
    const result = run(fx, ['--isolation', 'separate-user']);
    assert.equal(result.status, 0, result.stderr);
    const { summary } = result;
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { status: 'scored', reasons: [], runs: 8, scoredRuns: 8, excludedRuns: 0, output: fx.output });
    assert.deepEqual([summary.status, summary.reasons, summary.excludedRuns, summary.isolation], ['scored', [], [], { declared: 'separate-user' }]);
    assert.deepEqual(summary.corpus, { version: corpusVersion, digest: corpusDigest() });
    assert.deepEqual(summary.protocol.seeds, [100, 101]);
    assert.deepEqual(summary.protocol.judge, { model: 'opus', effort: 'max', passes: 2, systemPromptSha256: sha256('judge system prompt'), claudeVersion: '2.1.283', includeSuspected: true });
    assert.deepEqual(summary.protocol.spotCheck, { all: false, rate: 0.2, minimum: 5, items: 8, reviewed: 8, pending: 0 });
    assert.deepEqual(summary.sources, { runsSha256: fx.verdicts.runsSha256, verdictsSha256: sha256(readFileSync(fx.verdictsPath)),
      judgeSha256: fx.verdicts.judgeSha256, sheetSha256: fx.verdicts.sheetSha256 });
    assert.equal(summary.variants.length, 1);
    const [variant] = summary.variants;
    assert.deepEqual([variant.name, variant.revision, variant.subject], ['baseline', 'a'.repeat(40), { pluginVersion: '5.0.0', pluginDigest: DIGEST }]);
    assert.deepEqual(Object.keys(variant.perMode), ['A', 'B']);
    assert.equal(summary.runs.length, 8, 'raw per-run results are kept');
    assert(summary.runs.every(entry => entry.scoring === 'scored' && entry.metrics !== null));

    const a = variant.perMode.A;
    assert.deepEqual([a.runs, a.faultyRuns, a.correctedRuns, a.seedsPerFaultyRun, a.meanDetectedSeeds], [4, 2, 2, 22, 1.5]);
    near(a.meanRecall, 3 / 44, 'mean recall');
    assert.equal(a.meanCriticalRecall, 0.125);
    assert.deepEqual(a.perSurfaceRecall.api, { seeded: 6, detected: 1, recall: 1 / 6 });
    assert.deepEqual(a.perSurfaceRecall.authz, { seeded: 10, detected: 1, recall: 0.1 });
    assert.deepEqual(a.perSurfaceRecall.ui, { seeded: 6, detected: 0, recall: 0 });
    assert.deepEqual([a.reported, a.real, a.pooledPrecision, a.falsePositivesOnCorrected, a.meanRealUnseeded, a.suspectedSeedHits], [8, 5, 0.625, 1, 0.5, 1]);
    assert.equal(a.independentReproduction, 0.6);
    assert.deepEqual(a.regression, { faultyRuns: 2, replayedRuns: 2, detectedSeeds: 3, withWiredRegression: 2, failToPass: 2, specific: 1, flaky: 1,
      failToPassRate: 2 / 3, specificRate: 1 / 3, flakyRate: 1 / 3, falseAlarms: 1, baselineGreenOnFixRate: 0.5 });
    assert.deepEqual(a.perLane, {
      ariadne: { reported: 1, real: 0, falsePositive: 1, duplicate: 0, seedsDetected: 0, precision: 0 },
      atalanta: { reported: 3, real: 2, falsePositive: 1, duplicate: 0, seedsDetected: 1, precision: 2 / 3 },
      proteus: { reported: 4, real: 3, falsePositive: 0, duplicate: 1, seedsDetected: 2, precision: 0.75 },
    });
    assert.deepEqual(a.deliveryDefects, { ledgerMissing: 0, ledgerInvalid: 0, unledgeredReports: 2 });
    assert.deepEqual(a.usage, { tokens: { runs: 4, total: 4000, mean: 1000 }, cost: { runs: 4, total: 10, mean: 2.5 },
      numTurns: { runs: 4, total: 160, mean: 40 }, elapsedMs: { runs: 4, total: 240_000, mean: 60_000 } });
    assert.deepEqual([a.timedOutRuns, a.overBudgetRuns, a.controllerTurnCapHits, a.invalidRuns, a.contaminatedRuns], [0, 0, 1, 0, 0]);
    assert.deepEqual(a.judgeReliability, fx.verdicts.reliability);

    const b = variant.perMode.B;
    assert.deepEqual([b.runs, b.faultyRuns, b.meanDetectedSeeds, b.pooledPrecision, b.regression, b.timedOutRuns], [4, 2, 1.5, 1, null, 1]);
    near(b.meanRecall, 3 / 44, 'mode B mean recall');
    assert.equal(b.meanCriticalRecall, 1 / 16);
    assert.deepEqual(b.perLane, { metis: { reported: 3, real: 3, falsePositive: 0, duplicate: 0, seedsDetected: 3, precision: 1 } });
    assert.deepEqual(b.usage.tokens, { runs: 3, total: 3000, mean: 1000 }, 'the timed-out run without usage is left out of usage totals');

    const text = JSON.stringify(summary);
    for (const marker of [...TEXT_MARKERS, work]) assert(!text.includes(marker), `the summary leaks ${marker}`);
    const again = run(fx);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
    console.log('PASS  adjudicate: scored discovery-summary@1 with per-mode recall, per-surface recall, pooled precision, regression rates, per-lane and usage aggregates; IDs and counts only; an existing output is never replaced');
  }

  // 3. A provisional snapshot scores provisionally (exit 23); a confirmed finding without a final
  // verdict is UNSCORED (exit 20).
  {
    const provisional = run(fixture('provisional', { verdicts: document => {
      Object.assign(document, { status: 'provisional' });
      Object.assign(document.spotCheck, { reviewed: 7, pending: 1 });
      Object.assign(document.reliability, { randomReviewed: 4 });
    } }));
    assert.equal(provisional.status, 23, provisional.stderr);
    assert.equal(provisional.summary.status, 'scored-provisional');
    assert.deepEqual(provisional.summary.reasons, [{ code: 'provisional-verdicts', variant: null, runId: null, findingIds: [] }]);
    assert.equal(provisional.summary.variants[0].perMode.A.pooledPrecision, 0.625);

    const missing = run(fixture('missing-verdict', { verdicts: document => {
      const entry = document.runs.find(item => item.runId === 'r0-A-faulty-baseline');
      entry.verdicts = entry.verdicts.filter(verdict => verdict.findingId !== 'BUG-0003');
    } }));
    assert.equal(missing.status, 20, missing.stderr);
    assert.match(missing.stderr, /UNSCORED: missing-verdict baseline r0-A-faulty-baseline BUG-0003/);
    assert.equal(missing.summary.status, 'UNSCORED');
    assert.deepEqual(missing.summary.reasons, [{ code: 'missing-verdict', variant: 'baseline', runId: 'r0-A-faulty-baseline', findingIds: ['BUG-0003'] }]);
    assert.equal(missing.summary.variants[0].perMode, null, 'an UNSCORED summary carries no aggregates');
    assert.deepEqual(missing.summary.runs.filter(entry => entry.scoring !== 'scored').map(entry => [entry.runId, entry.scoring, entry.metrics]),
      [['r0-A-faulty-baseline', 'unscored', null]]);
    console.log('PASS  adjudicate: provisional final verdicts give scored-provisional (exit 23); a confirmed finding without a verdict gives UNSCORED (exit 20)');
  }

  // 4. Runs that block a score: mixed plugin digests within a variant, an invalid run, and a
  // contaminated run unless --exclude-contaminated lists and excludes it.
  {
    const mixed = run(fixture('mixed-digest', { plans: list => { list.find(plan => plan.runId === 'r1-B-corrected-baseline').digest = OTHER_DIGEST; } }));
    assert.equal(mixed.status, 20, mixed.stderr);
    assert.deepEqual(mixed.summary.reasons, [{ code: 'mixed-plugin-digest', variant: 'baseline', runId: null, findingIds: [] }]);
    assert.deepEqual(mixed.summary.variants[0].subject, { pluginVersion: '5.0.0', pluginDigest: null });
    assert.deepEqual(new Set(mixed.summary.runs.map(entry => entry.pluginDigest)), new Set([DIGEST, OTHER_DIGEST, null]));

    const invalid = run(fixture('invalid-run', { plans: list => { list.find(plan => plan.runId === 'r1-B-corrected-baseline').status = 'invalid-run'; } }));
    assert.equal(invalid.status, 20, invalid.stderr);
    assert.deepEqual(invalid.summary.reasons.map(entry => [entry.code, entry.runId]), [['invalid-run', 'r1-B-corrected-baseline']]);

    const contaminated = fixture('contaminated', { plans: list => { list.find(plan => plan.runId === 'r1-B-corrected-baseline').status = 'contaminated'; } });
    const blocked = run(contaminated);
    assert.equal(blocked.status, 20, blocked.stderr);
    assert.deepEqual(blocked.summary.reasons.map(entry => [entry.code, entry.runId]), [['contaminated-run', 'r1-B-corrected-baseline']]);
    rmSync(contaminated.output);
    const excluded = run(contaminated, ['--exclude-contaminated']);
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.deepEqual([excluded.summary.status, excluded.summary.excludedRuns], ['scored', ['r1-B-corrected-baseline']]);
    assert.deepEqual(excluded.summary.runs.find(entry => entry.runId === 'r1-B-corrected-baseline').scoring, 'excluded');
    const b = excluded.summary.variants[0].perMode.B;
    assert.deepEqual([b.runs, b.correctedRuns, b.contaminatedRuns], [3, 1, 1]);
    assert.equal(excluded.summary.isolation.declared, null, 'isolation is null unless declared');
    console.log('PASS  adjudicate: mixed plugin digests, invalid runs, and contaminated runs give UNSCORED; --exclude-contaminated lists and excludes contaminated runs');
  }

  // 5. Invalid input exits 1: evidence escaping the allowed roots (directly or through a symbolic
  // link), a tampered private-runs binding, judge-unreliable verdicts, a verdict that credits a
  // seed the run does not have, and verdicts for a run that cannot be scored.
  {
    const outside = join(work, 'outside-evidence.txt');
    writeFileSync(outside, 'Not a record of this run.\n');
    const refuse = (name, adjust, pattern) => {
      const fx = fixture(name, adjust);
      const result = run(fx);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, pattern, name);
      assert.equal(result.summary, null, `${name}: no output is written`);
    };
    const firstVerdict = (document, runId = 'r0-A-faulty-baseline') => document.runs.find(item => item.runId === runId).verdicts[0];
    refuse('escaping-evidence', { verdicts: document => { firstVerdict(document).evidenceRef = outside; } }, /escapes the run's artifact root/);
    refuse('symlinked-evidence', { verdicts: (document, sealed) => {
      const link = join(sealed, 'runs', 'r0-A-faulty-baseline', 'artifacts', 'linked-evidence.txt');
      symlinkSync(outside, link);
      firstVerdict(document).evidenceRef = link;
    } }, /escapes the run's artifact root/);
    refuse('missing-evidence', { verdicts: (document, sealed) => { firstVerdict(document).evidenceRef = join(sealed, 'repro', 'absent.txt'); } }, /is missing/);
    refuse('tampered-runs', { verdicts: document => { document.runsSha256 = sha256('other private runs'); } }, /runsSha256 mismatch/);
    refuse('judge-unreliable', { verdicts: document => {
      document.status = 'judge-unreliable';
      Object.assign(document.reliability, { randomOverturned: 2, overturnRate: 0.4 });
    } }, /judge-unreliable and must not feed a score/);
    refuse('unknown-seed', { verdicts: document => { Object.assign(firstVerdict(document, 'r0-A-corrected-baseline'), { outcome: 'real', seedId: S1 }); } }, /unknown seed quantity-boundary/);
    refuse('judged-invalid-run', { plans: list => {
      const plan = list.find(item => item.runId === 'r0-B-faulty-baseline');
      plan.status = 'invalid-run';
    } }, /is invalid-run, but the final verdicts judge its findings/);
    console.log('PASS  adjudicate: escaping, symlinked, or missing evidence, a tampered runs binding, judge-unreliable verdicts, an unknown seed, and verdicts for an unscorable run exit 1 with no output');
  }

  // 6. Usage errors exit 2.
  {
    for (const args of [[], ['--runs', 'a.json', '--verdicts', 'b.json'], ['--runs', 'a', '--verdicts', 'b', '--output', 'c', '--isolation', 'container'],
      ['--runs', 'a', '--runs', 'b'], ['--frobnicate']]) {
      const result = adjudicate(args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/eval\/discovery\/adjudicate\.mjs/);
    }
    console.log('PASS  adjudicate: usage errors exit 2');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
