#!/usr/bin/env node
// Human spot-check smoke: mandatory review items, the seeded stratified random sample and its size
// rule, seed replay, incomplete and provisional sheets, the judge reliability boundary, census
// sheets, human decision checks, evidence containment, and the SHA-256 bindings. Synthetic private
// runs and judge verdicts only; no model is called and no Argus score is claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusDigest, corpusVersion, seedIds, truthFor } from './corpus/index.mjs';
import { formatSchemaErrors, validateEval } from './lib/schemas.mjs';

const SPOTCHECK = fileURLToPath(new URL('./spotcheck.mjs', import.meta.url));
const STARTED = Date.UTC(2026, 0, 1, 12, 0, 0);
const REVIEWED_AT = new Date(STARTED + 86_400_000).toISOString();
const SEED = 12345;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const mode = path => statSync(path).mode & 0o777;
const key = item => `${item.runId} ${item.findingId}`;
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-spotcheck-smoke-')));
const sealed = join(work, 'out', 'sealed');
let outputs = 0;
let cases = 0;

const fresh = name => join(work, `${String(outputs++).padStart(2, '0')}-${name}`);

function row(id, status = 'confirmed') {
  const origin = `ATA-${id.slice(4)}`;
  return { id, origin: [origin], lane: 'atalanta', severity: 'Major', status, wired: false, testId: null,
    title: `Synthetic finding ${id}`, reportPath: `bugs/${origin}.md`, evidenceIds: [], confirmedAtMs: 1000 };
}

// A private-runs@2 run with a real (empty) artifact root and synthetic extraction rows.
function makeRun(runId, build, status, rows) {
  const repeat = Number(/^r([0-9]+)/.exec(runId)[1]);
  const enabledSeeds = build === 'faulty' ? [...seedIds] : [];
  const artifactRoot = join(sealed, 'runs', runId, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const valid = status !== 'invalid-run';
  return {
    runId, publicId: sha256(runId).slice(0, 16), variant: 'baseline', revision: 'a'.repeat(40), repeat, seed: 100 + repeat, mode: 'B', build, enabledSeeds, truth: truthFor(enabledSeeds),
    url: 'http://127.0.0.1:40000', port: 40000, contract: { rules: ['Synthetic public rule.'] }, status,
    reason: status === 'awaiting-adjudication' ? null : `smoke fixture: ${status}`, launchAssurance: 'unattested',
    startedAt: new Date(STARTED).toISOString(), elapsedMs: 60_000, timedOut: status === 'timed-out', overBudget: false, artifactRoot,
    adapter: { envNames: ['HOME', 'PATH', 'TMPDIR'], exitCode: valid ? 0 : null, signal: null, spawnError: valid ? null : 'smoke fixture: no adapter',
      resultState: valid ? 'valid' : 'missing', resultErrors: [], result: valid ? {} : null },
    extraction: { ledger: 'present', ledgerErrors: [], findings: rows.filter(item => item.status === 'confirmed'),
      suspected: rows.filter(item => item.status !== 'confirmed'), unledgeredReports: [], framework: { root: null, candidates: 0 } },
    contamination: { status: 'clean', hits: [], totalHits: 0, scannedFiles: 0, skippedFiles: 0 },
    replay: null,
  };
}

// A judge-verdicts@1 verdict with two recorded passes. A failed verdict has no decision.
function judgeVerdict(runId, finding, options = {}) {
  const { outcome = 'real', seedId = null, duplicateOf = null, confidence = 'high', agreement = true, failed = false } = options;
  const probe = options.probe ?? (seedId === null ? null : true);
  const base = { findingId: finding.id, status: finding.status, packetPath: join(sealed, 'judge-packets', runId, `${finding.id}.json`), packetSha256: sha256(`${runId}/${finding.id}`) };
  if (failed) {
    const failedPass = pass => ({ pass, attempts: 2, outcome: null, seedId: null, duplicateOf: null, confidence: null, criterionEvidence: null, reason: null,
      error: 'output violates the judge schema: /outcome must be equal to one of the allowed values', costUsd: 0.5, models: ['claude-opus-stub'] });
    return { ...base, outcome: null, seedId: null, duplicateOf: null, confidence: null, agreement: false, judgeFailed: true, seedProbeConfirmed: null,
      seedProbeError: null, reason: 'judge failed: pass 1: output violates the judge schema', criterionEvidence: null, passes: [failedPass(1), failedPass(2)] };
  }
  const reason = `Judge reason for ${runId} ${finding.id}.`;
  const decided = (pass, fields) => ({ pass, attempts: 1, outcome, seedId, duplicateOf, confidence: 'high', criterionEvidence: 'The cited response violates the criterion.',
    reason, error: null, costUsd: 0.25, models: ['claude-opus-stub'], ...fields });
  return { ...base, outcome, seedId, duplicateOf, confidence, agreement, judgeFailed: false, seedProbeConfirmed: probe,
    seedProbeError: probe === false ? 'seed probe failed: the seed was not observed' : null, reason, criterionEvidence: 'The cited response violates the criterion.',
    passes: [decided(1, { confidence }), agreement ? decided(2, {}) : decided(2, { outcome: 'false-positive', seedId: null, duplicateOf: null })] };
}

const bug = number => `BUG-${String(number).padStart(4, '0')}`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// Five runs: 55 judged verdicts (5 mandatory; 50 remaining: 25 real-seeded, 15 false-positive,
// 10 duplicate), a judged suspected row, a run with no findings, and a skipped invalid run.
const plans = [
  ['r0-B-faulty-baseline', 'faulty', 'awaiting-adjudication', [
    [1, { failed: true }],
    [2, { outcome: 'real' }],
    [3, { seedId: seedIds[0], agreement: false, confidence: 'low' }],
    [4, { seedId: seedIds[1], probe: false, confidence: 'low' }],
    [5, { seedId: seedIds[2], confidence: 'low' }],
    ...range(6, 17).map(number => [number, { seedId: seedIds[number % seedIds.length], confidence: number % 2 ? 'high' : 'medium' }]),
    ...range(18, 22).map(number => [number, { outcome: 'false-positive' }]),
    ...range(23, 27).map(number => [number, { outcome: 'duplicate', duplicateOf: 'BUG-0006' }]),
  ]],
  ['r0-B-corrected-baseline', 'corrected', 'awaiting-adjudication', [
    ...range(1, 5).map(number => [number, { outcome: 'false-positive' }]),
    ...range(6, 8).map(number => [number, { outcome: 'duplicate', duplicateOf: 'BUG-0001' }]),
  ]],
  ['r1-B-faulty-baseline', 'faulty', 'timed-out', [
    ...range(1, 13).map(number => [number, { seedId: seedIds[(number + 5) % seedIds.length] }]),
    ...range(14, 17).map(number => [number, { outcome: 'false-positive' }]),
    ...range(18, 19).map(number => [number, { outcome: 'duplicate', duplicateOf: 'BUG-0001' }]),
    [20, { outcome: 'false-positive', status: 'suspected' }],
  ]],
  ['r1-B-corrected-baseline', 'corrected', 'awaiting-adjudication', []],
  ['r2-B-faulty-baseline', 'faulty', 'invalid-run', [[1, {}]]],
];

const runs = [];
const judgedRuns = [];
for (const [runId, build, status, specs] of plans) {
  const rows = specs.map(([number, spec]) => row(bug(number), spec.status));
  runs.push(makeRun(runId, build, status, rows));
  const skipped = status === 'invalid-run' ? status : null;
  judgedRuns.push({ runId, skipped, verdicts: skipped ? [] : specs.map(([number, spec], index) => judgeVerdict(runId, rows[index], spec)) });
}

function writePrivateRuns(path, runList) {
  const document = {
    schema: 'argus-eval/private-runs@2', createdAt: new Date(STARTED).toISOString(),
    config: { schema: 'argus-eval/comparison-config@2', variants: [{ name: 'baseline', revision: 'a'.repeat(40), command: ['/bin/true'] }],
      modes: ['B'], builds: ['faulty', 'corrected'], repeats: 3, seeds: [100, 101, 102], secondsByMode: { A: 28800, B: 14400 }, tokens: null,
      workRoot: work, adapterEnv: ['ANTHROPIC_API_KEY'], replay: { enabled: false }, corpusModule: null, testMode: false },
    corpus: { version: corpusVersion, digest: corpusDigest() }, canarySha256: sha256('smoke canary'), runs: runList,
  };
  const errors = validateEval('private-runs', document);
  assert.deepEqual(errors, [], `fixture violates private-runs@2: ${formatSchemaErrors(errors)}`);
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(path, bytes, { mode: 0o600 });
  return sha256(bytes);
}

function writeJudge(path, runsSha256, runList) {
  const verdictCount = runList.flatMap(run => run.verdicts).length;
  const document = {
    schema: 'argus-eval/judge-verdicts@1', createdAt: new Date(STARTED + 3_600_000).toISOString(), runsSha256,
    judge: { model: 'opus', effort: 'max', claudeVersion: '2.1.283', resolvedModels: ['claude-opus-stub'], systemPromptSha256: sha256('judge system prompt'),
      passes: 2, bare: true, tools: 'none', includeSuspected: true, invocations: verdictCount * 2, totalCostUsd: verdictCount * 0.5 },
    runs: runList,
  };
  const errors = validateEval('judge-verdicts', document);
  assert.deepEqual(errors, [], `fixture violates judge-verdicts@1: ${formatSchemaErrors(errors)}`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return document;
}

function spotcheck(args) {
  const result = spawnSync(process.execPath, [SPOTCHECK, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const lastLine = text => JSON.parse(text.trim().split('\n').at(-1));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function writeSheet(name, sheet) {
  const path = fresh(name);
  writeFileSync(path, `${JSON.stringify(sheet, null, 2)}\n`, { mode: 0o600 });
  return path;
}

// A human decision agreeing with the judge (a failed verdict is decided false-positive).
function agree(item, fields = {}) {
  const decided = item.judge.outcome !== null;
  return { outcome: decided ? item.judge.outcome : 'false-positive', seedId: decided ? item.judge.seedId : null, duplicateOf: decided ? item.judge.duplicateOf : null,
    reviewer: 'reviewer-a', reviewedAt: REVIEWED_AT, reason: `Reproduced the report for ${key(item)} independently.`, reproduced: false, evidenceRef: null, ...fields };
}

// A decision that overturns the judge's outcome.
const overturnOutcome = item => (item.judge.outcome === 'false-positive'
  ? agree(item, { outcome: 'real', seedId: null, duplicateOf: null })
  : agree(item, { outcome: 'false-positive', seedId: null, duplicateOf: null }));

function fill(sheet, decide) {
  const copy = structuredClone(sheet);
  copy.items.forEach((item, index) => {
    const human = decide(item, index);
    if (human !== undefined) item.human = human;
  });
  return copy;
}

function assertValid(schemaName, document) {
  const errors = validateEval(schemaName, document);
  assert.deepEqual(errors, [], `${schemaName} violation: ${formatSchemaErrors(errors)}`);
}

try {
  mkdirSync(sealed, { recursive: true, mode: 0o700 });
  const runsPath = join(sealed, 'private-runs.json');
  const runsSha256 = writePrivateRuns(runsPath, runs);
  const judgePath = join(work, 'out', 'judge-verdicts.json');
  const judgeDocument = writeJudge(judgePath, runsSha256, judgedRuns);
  const judgeSha256 = sha256(readFileSync(judgePath));
  const common = ['--runs', runsPath, '--judge', judgePath];
  const sample = (name, extra = []) => {
    const output = fresh(name);
    const result = spotcheck(['sample', ...common, '--output', output, ...extra]);
    assert.equal(result.status, 0, `sample ${extra.join(' ')} failed: ${result.stderr}`);
    const sheet = readJson(output);
    assertValid('spot-check', sheet);
    return { output, sheet, summary: lastLine(result.stdout) };
  };
  const finalize = (sheetPath, extra = [], { judge = judgePath, runsFile = runsPath } = {}) => {
    const output = fresh('final.json');
    const result = spotcheck(['finalize', '--runs', runsFile, '--judge', judge, '--sheet', sheetPath, '--output', output, ...extra]);
    return { ...result, output, document: existsSync(output) ? readJson(output) : null };
  };
  const verdictOf = (document, runId, findingId) => document.runs.find(run => run.runId === runId).verdicts.find(verdict => verdict.findingId === findingId);
  const randomItems = sheet => sheet.items.filter(item => item.reasonSelected === 'random');
  const strata = items => ['real', 'false-positive', 'duplicate'].map(outcome => items.filter(item => item.judge.outcome === outcome).length);
  const naturalOrder = judgeDocument.runs.flatMap(run => run.verdicts.map(verdict => `${run.runId} ${verdict.findingId}`));
  const mandatory = {
    'r0-B-faulty-baseline BUG-0001': 'judge-failed',
    'r0-B-faulty-baseline BUG-0002': 'unseeded-real',
    'r0-B-faulty-baseline BUG-0003': 'disagreement',
    'r0-B-faulty-baseline BUG-0004': 'probe-mismatch',
    'r0-B-faulty-baseline BUG-0005': 'low-confidence',
  };
  const assertMandatory = sheet => {
    for (const [itemKey, reason] of Object.entries(mandatory)) {
      assert.equal(sheet.items.find(item => key(item) === itemKey)?.reasonSelected, reason, `${itemKey} is always selected as ${reason}`);
    }
    assert.equal(sheet.items.filter(item => !['random', 'census'].includes(item.reasonSelected)).length, 5, 'exactly the five mandatory verdicts');
  };

  // 1. Mandatory items are always selected, with the stratified default sample (0.2 x 50 = 10).
  const base = sample('sheet.json', ['--seed', String(SEED)]);
  {
    const { sheet, summary, output } = base;
    assert.equal(mode(output), 0o600);
    assert.deepEqual([sheet.runsSha256, sheet.judgeSha256, sheet.all, sheet.samplingSeed, sheet.rate, sheet.minimum], [runsSha256, judgeSha256, false, SEED, 0.2, 5]);
    assertMandatory(sheet);
    assert.deepEqual(sheet.population, { verdicts: 55, mandatory: 5, remaining: 50, selected: 10,
      strata: { 'real-seeded': { remaining: 25, selected: 5 }, 'false-positive': { remaining: 15, selected: 3 }, duplicate: { remaining: 10, selected: 2 } } });
    assert.deepEqual(strata(randomItems(sheet)), [5, 3, 2], 'proportional allocation across outcome strata');
    assert(randomItems(sheet).every(item => item.judge.outcome !== 'real' || item.judge.seedId !== null), 'the real stratum holds only seeded verdicts');
    const positions = sheet.items.map(item => naturalOrder.indexOf(key(item)));
    assert(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), 'items keep private-runs and verdict order');
    assert(sheet.items.every(item => item.human === null));
    const failed = sheet.items[0];
    assert.deepEqual(failed, { runId: 'r0-B-faulty-baseline', findingId: 'BUG-0001', reasonSelected: 'judge-failed',
      judge: { outcome: null, seedId: null, duplicateOf: null, reason: 'judge failed: pass 1: output violates the judge schema' },
      packetPath: join(sealed, 'judge-packets', 'r0-B-faulty-baseline', 'BUG-0001.json'), human: null });
    assert.deepEqual(summary, { status: 'AWAITING-REVIEW', verdicts: 55, items: 15, mandatory: 5, random: 10, census: 0, samplingSeed: SEED, output });
    assert(!sheet.items.some(item => item.runId === 'r2-B-faulty-baseline'), 'a skipped run contributes no item');
    cases++;
  }

  // 2. The same seed gives an identical sample; another seed differs; a drawn seed is recorded
  // and replays.
  {
    const again = sample('sheet-again.json', ['--seed', String(SEED)]).sheet;
    assert.deepEqual([again.items, again.population, again.samplingSeed], [base.sheet.items, base.sheet.population, base.sheet.samplingSeed]);
    const other = sample('sheet-other.json', ['--seed', '54321']).sheet;
    assert.notDeepEqual(randomItems(other).map(key), randomItems(base.sheet).map(key), 'a different seed draws a different sample');
    assert.deepEqual(strata(randomItems(other)), [5, 3, 2]);
    const drawn = sample('sheet-drawn.json').sheet;
    assert(Number.isInteger(drawn.samplingSeed) && drawn.samplingSeed >= 0 && drawn.samplingSeed <= 4294967295, 'the default seed is drawn and recorded');
    const replay = sample('sheet-replay.json', ['--seed', String(drawn.samplingSeed)]).sheet;
    assert.deepEqual(replay.items, drawn.items, 'the recorded seed replays the sample');
    cases++;
  }

  // 3. Sample size = min(remaining, max(minimum, ceil(rate x remaining))), allocated by stratum.
  {
    for (const [extra, size, allocation] of [
      [['--rate', '0.5'], 25, [13, 7, 5]],
      [['--minimum', '30'], 30, [15, 9, 6]],
      [['--minimum', '100'], 50, [25, 15, 10]],
      [['--rate', '1'], 50, [25, 15, 10]],
      [['--rate', '0.14', '--minimum', '0'], 7, [4, 2, 1]],
      [['--rate', '0.01', '--minimum', '0'], 1, [1, 0, 0]],
      [['--rate', '0.01'], 5, [3, 1, 1]],
      [['--rate', '0.000001', '--minimum', '0'], 1, [1, 0, 0]],
    ]) {
      const { sheet } = sample('sheet-size.json', ['--seed', '7', ...extra]);
      assert.equal(randomItems(sheet).length, size, `sample size for ${extra.join(' ')}`);
      assert.deepEqual(strata(randomItems(sheet)), allocation, `stratum allocation for ${extra.join(' ')}`);
      assert.equal(sheet.population.selected, size);
      assertMandatory(sheet);
    }
    cases++;
  }

  // 4. --all selects every verdict; the non-mandatory ones are a census, not a random sample.
  const census = sample('sheet-all.json', ['--all']);
  {
    const { sheet, summary } = census;
    assert.equal(sheet.items.length, 55);
    assertMandatory(sheet);
    assert.equal(sheet.items.filter(item => item.reasonSelected === 'census').length, 50);
    assert.deepEqual([sheet.all, sheet.samplingSeed, sheet.rate, sheet.minimum, sheet.population.selected], [true, null, null, null, 50]);
    assert.deepEqual([summary.random, summary.census, summary.samplingSeed], [0, 50, null]);
    cases++;
  }

  // Evidence the reviewers cite: one file in the run's artifact root, one under <runsDir>/repro/.
  const faultyRoot = runs[0].artifactRoot;
  mkdirSync(join(faultyRoot, 'evidence'), { recursive: true });
  writeFileSync(join(faultyRoot, 'evidence', 'response.txt'), 'HTTP/1.1 201 Created\n');
  const repro = join(sealed, 'repro', 'r0-B-faulty-baseline');
  mkdirSync(repro, { recursive: true, mode: 0o700 });
  writeFileSync(join(repro, 'BUG-0002.txt'), 'Independent replay: 201 Created for quantity 11\n');

  // 5. An incomplete sheet exits 20 and writes nothing; --provisional gives status provisional,
  // except that every judge-failed verdict needs a human decision.
  {
    const untouched = finalize(base.output);
    assert.equal(untouched.status, 20, untouched.stderr);
    assert.match(untouched.stderr, /incomplete: 15 of 15 items have no human decision/);
    assert.equal(untouched.document, null, 'nothing is written for an incomplete sheet');

    const oneMissing = finalize(writeSheet('sheet-one-missing.json', fill(base.sheet, (item, index) => (index === base.sheet.items.length - 1 ? undefined : agree(item)))));
    assert.equal(oneMissing.status, 20);
    assert.match(oneMissing.stderr, /1 of 15 items have no human decision/);

    const failedMissing = finalize(writeSheet('sheet-failed-missing.json', fill(base.sheet, item => (item.reasonSelected === 'judge-failed' ? undefined : agree(item)))), ['--provisional']);
    assert.equal(failedMissing.status, 20);
    assert.match(failedMissing.stderr, /every judge-failed verdict needs a human decision, even with --provisional/);
    assert.equal(failedMissing.document, null);

    const partial = fill(base.sheet, item => (item.reasonSelected === 'random' ? undefined : agree(item)));
    const provisional = finalize(writeSheet('sheet-partial.json', partial), ['--provisional']);
    assert.equal(provisional.status, 0, provisional.stderr);
    assertValid('final-verdicts', provisional.document);
    assert.equal(provisional.document.status, 'provisional');
    assert.deepEqual(provisional.document.spotCheck, { all: false, samplingSeed: SEED, rate: 0.2, minimum: 5, items: 15, reviewed: 5, pending: 10 });
    assert.deepEqual(provisional.document.reliability, { randomSampled: 10, randomReviewed: 0, randomOverturned: 0, overturnRate: null, maxOverturnRate: 0.1 });
    const pendingRandom = randomItems(base.sheet)[0];
    assert.equal(verdictOf(provisional.document, pendingRandom.runId, pendingRandom.findingId).source, 'judge', 'an unreviewed item keeps the judge verdict');
    assert.equal(lastLine(provisional.stdout).status, 'provisional');

    // A partial sheet is unreliable as soon as no remaining review can bring the rate back to 0.10:
    // three of ten random items reviewed, with `overturns` of them overturned.
    const rankOf = item => randomItems(base.sheet).findIndex(random => key(random) === key(item));
    const earlySheet = overturns => fill(base.sheet, item => {
      if (item.reasonSelected !== 'random') return agree(item);
      const rank = rankOf(item);
      return rank < overturns ? overturnOutcome(item) : rank < 3 ? agree(item) : undefined;
    });
    const hopeless = finalize(writeSheet('sheet-early-two.json', earlySheet(2)), ['--provisional']);
    assert.equal(hopeless.status, 22, hopeless.stderr);
    assert.equal(hopeless.document.status, 'judge-unreliable');
    assert.deepEqual(hopeless.document.reliability, { randomSampled: 10, randomReviewed: 3, randomOverturned: 2, overturnRate: 2 / 3, maxOverturnRate: 0.1 });
    const recoverable = finalize(writeSheet('sheet-early-one.json', earlySheet(1)), ['--provisional']);
    assert.equal(recoverable.status, 0, recoverable.stderr);
    assert.equal(recoverable.document.status, 'provisional', '1 overturned of 10 sampled can still end at 0.10');
    assert.deepEqual(recoverable.document.reliability, { randomSampled: 10, randomReviewed: 3, randomOverturned: 1, overturnRate: 1 / 3, maxOverturnRate: 0.1 });
    cases++;
  }

  // 6. 1 of 10 random items overturned (exactly 0.10) is final. Mandatory overturns and a changed
  // duplicate target do not count; the final verdicts take the human decision where reviewed.
  const [firstRandom, secondRandom] = randomItems(base.sheet);
  const randomDuplicate = randomItems(base.sheet).find(item => item.judge.outcome === 'duplicate');
  const randomSeeded = randomItems(base.sheet).find(item => item.judge.outcome === 'real' && key(item) !== key(firstRandom));
  assert(randomDuplicate && randomSeeded && key(randomDuplicate) !== key(firstRandom));
  const reviewedOnce = fill(base.sheet, item => {
    if (key(item) === key(firstRandom)) return overturnOutcome(item);
    if (key(item) === key(randomDuplicate)) return agree(item, { duplicateOf: item.judge.duplicateOf === 'BUG-0001' ? 'BUG-0002' : 'BUG-0001' });
    if (key(item) === 'r0-B-faulty-baseline BUG-0002') return agree(item, { reproduced: true, evidenceRef: join(repro, 'BUG-0002.txt') });
    if (key(item) === 'r0-B-faulty-baseline BUG-0003') return agree(item, { outcome: 'false-positive', seedId: null, reproduced: false, evidenceRef: 'evidence/response.txt' });
    if (key(item) === 'r0-B-faulty-baseline BUG-0005') return overturnOutcome(item);
    return agree(item);
  });
  const reviewedOncePath = writeSheet('sheet-one-overturn.json', reviewedOnce);
  {
    const result = finalize(reviewedOncePath);
    assert.equal(result.status, 0, result.stderr);
    const { document } = result;
    assertValid('final-verdicts', document);
    assert.equal(mode(result.output), 0o600);
    assert.equal(document.status, 'final');
    assert.deepEqual([document.runsSha256, document.judgeSha256, document.sheetSha256], [runsSha256, judgeSha256, sha256(readFileSync(reviewedOncePath))]);
    assert.deepEqual(document.reliability, { randomSampled: 10, randomReviewed: 10, randomOverturned: 1, overturnRate: 0.1, maxOverturnRate: 0.1 });
    assert.deepEqual(document.judge, { model: 'opus', effort: 'max', passes: 2, claudeVersion: '2.1.283', systemPromptSha256: sha256('judge system prompt'), includeSuspected: true });
    assert.deepEqual(document.spotCheck, { all: false, samplingSeed: SEED, rate: 0.2, minimum: 5, items: 15, reviewed: 15, pending: 0 });
    assert.deepEqual(document.runs.map(run => [run.runId, run.verdicts.length]),
      [['r0-B-faulty-baseline', 27], ['r0-B-corrected-baseline', 8], ['r1-B-faulty-baseline', 20], ['r1-B-corrected-baseline', 0], ['r2-B-faulty-baseline', 0]], 'every run in private-runs order');
    const verdicts = document.runs.flatMap(run => run.verdicts);
    assert.deepEqual([verdicts.filter(verdict => verdict.source === 'human').length, verdicts.filter(verdict => verdict.source === 'judge').length], [15, 40]);
    assert.deepEqual(lastLine(result.stdout), { status: 'final', verdicts: 55, human: 15, judge: 40, pending: 0, reliability: document.reliability, output: result.output });
    // Every judge-failed verdict has a human decision.
    assert.deepEqual(verdictOf(document, 'r0-B-faulty-baseline', 'BUG-0001'), { findingId: 'BUG-0001', status: 'confirmed', outcome: 'false-positive', seedId: null, duplicateOf: null,
      source: 'human', confidence: null, reason: 'Reproduced the report for r0-B-faulty-baseline BUG-0001 independently.', evidenceRef: null, humanReproduced: false, reviewer: 'reviewer-a', overturned: true });
    const unseeded = verdictOf(document, 'r0-B-faulty-baseline', 'BUG-0002');
    assert.deepEqual([unseeded.evidenceRef, unseeded.humanReproduced, unseeded.overturned], [realpathSync(join(repro, 'BUG-0002.txt')), true, false], 'evidence under <runsDir>/repro/ is accepted');
    assert.equal(verdictOf(document, 'r0-B-faulty-baseline', 'BUG-0003').evidenceRef, realpathSync(join(faultyRoot, 'evidence', 'response.txt')), 'a path relative to the artifact root resolves physically');
    const overturnedRandom = verdictOf(document, firstRandom.runId, firstRandom.findingId);
    assert.deepEqual([overturnedRandom.source, overturnedRandom.overturned, overturnedRandom.outcome], ['human', true, overturnOutcome(firstRandom).outcome]);
    const retargeted = verdictOf(document, randomDuplicate.runId, randomDuplicate.findingId);
    assert.deepEqual([retargeted.outcome, retargeted.overturned], ['duplicate', false], 'a changed duplicate target is not an overturn');
    assert.notEqual(retargeted.duplicateOf, randomDuplicate.judge.duplicateOf);
    const unsampled = judgeDocument.runs[2].verdicts.find(verdict => !base.sheet.items.some(item => item.runId === 'r1-B-faulty-baseline' && item.findingId === verdict.findingId));
    assert.deepEqual(verdictOf(document, 'r1-B-faulty-baseline', unsampled.findingId), { findingId: unsampled.findingId, status: unsampled.status, outcome: unsampled.outcome,
      seedId: unsampled.seedId, duplicateOf: unsampled.duplicateOf, source: 'judge', confidence: unsampled.confidence, reason: unsampled.reason, evidenceRef: null,
      humanReproduced: null, reviewer: null, overturned: null }, 'an unsampled verdict keeps the judge decision');
    assert.equal(verdictOf(document, 'r1-B-faulty-baseline', 'BUG-0020').status, 'suspected');
    cases++;
  }

  // 7. 2 of 10 random items overturned (0.2): judge-unreliable, exit 22, with the output written.
  // A changed seed credit is an overturn too.
  {
    const faultySeeds = new Set(runs.find(run => run.runId === randomSeeded.runId).truth.map(seed => seed.id));
    const otherSeed = [...faultySeeds].find(id => id !== randomSeeded.judge.seedId);
    const twice = fill(reviewedOnce, item => (key(item) === key(randomSeeded) ? agree(item, { seedId: otherSeed }) : undefined));
    const result = finalize(writeSheet('sheet-two-overturns.json', twice));
    assert.equal(result.status, 22, result.stderr);
    assert.match(result.stderr, /judge unreliable: 2 of 10 random items overturned .*sample --all/);
    assertValid('final-verdicts', result.document);
    assert.equal(result.document.status, 'judge-unreliable');
    assert.deepEqual(result.document.reliability, { randomSampled: 10, randomReviewed: 10, randomOverturned: 2, overturnRate: 0.2, maxOverturnRate: 0.1 });
    assert.equal(verdictOf(result.document, randomSeeded.runId, randomSeeded.findingId).overturned, true);
    cases++;
  }

  // 8. The remedy: a census sheet puts every verdict under human review, so it is final however
  // many census items the humans overturn.
  {
    const result = finalize(writeSheet('sheet-census.json', fill(census.sheet, item => (item.reasonSelected === 'census' ? overturnOutcome(item) : agree(item)))));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.document.status, 'final');
    assert.deepEqual(result.document.reliability, { randomSampled: 0, randomReviewed: 0, randomOverturned: 0, overturnRate: null, maxOverturnRate: 0.1 });
    assert(result.document.runs.flatMap(run => run.verdicts).every(verdict => verdict.source === 'human'));
    assert.deepEqual(result.document.spotCheck, { all: true, samplingSeed: null, rate: null, minimum: null, items: 55, reviewed: 55, pending: 0 });
    cases++;
  }

  // 9. evidenceRef must resolve to a regular file inside the run's artifact root or <runsDir>/repro/.
  {
    symlinkSync(runsPath, join(faultyRoot, 'evidence', 'escape.txt'));
    const outside = join(work, 'outside.txt');
    writeFileSync(outside, 'not evidence\n');
    const refused = [
      ['../../../private-runs.json', /resolves outside the run's artifact root/],
      [outside, /resolves outside the run's artifact root/],
      ['evidence/escape.txt', /resolves outside the run's artifact root/],
      ['evidence', /is not a regular file/],
      ['evidence/missing.txt', /does not exist/],
    ];
    for (const [evidenceRef, pattern] of refused) {
      const sheet = fill(reviewedOnce, item => (key(item) === 'r0-B-faulty-baseline BUG-0002' ? agree(item, { reproduced: true, evidenceRef }) : undefined));
      const result = finalize(writeSheet('sheet-evidence.json', sheet));
      assert.equal(result.status, 1, `${evidenceRef}: ${result.stderr}`);
      assert.match(result.stderr, pattern, evidenceRef);
      assert.equal(result.document, null);
    }
    const unbacked = fill(reviewedOnce, item => (key(item) === 'r0-B-faulty-baseline BUG-0002' ? agree(item, { reproduced: true, evidenceRef: null }) : undefined));
    const noEvidence = finalize(writeSheet('sheet-unbacked.json', unbacked));
    assert.equal(noEvidence.status, 1);
    assert.match(noEvidence.stderr, /evidenceRef must be string/, 'a claimed reproduction needs evidence');
    // A repro directory reached through a symbolic link is not an allowed root.
    const aliasSealed = join(work, 'alias', 'sealed');
    mkdirSync(aliasSealed, { recursive: true, mode: 0o700 });
    cpSync(runsPath, join(aliasSealed, 'private-runs.json'));
    symlinkSync(join(sealed, 'repro'), join(aliasSealed, 'repro'));
    const aliased = finalize(reviewedOncePath, [], { runsFile: join(aliasSealed, 'private-runs.json') });
    assert.equal(aliased.status, 1);
    assert.match(aliased.stderr, /BUG-0002: evidenceRef .* resolves outside/);
    cases++;
  }

  // 10. Human decisions: seeds only from the run's truth, no self or unknown duplicate, no cycle.
  {
    const corrected = census.sheet.items.find(item => item.runId === 'r0-B-corrected-baseline');
    const broken = [
      [census.sheet, item => (key(item) === key(corrected) ? agree(item, { outcome: 'real', seedId: seedIds[0], duplicateOf: null }) : agree(item)), /seedId .* is not a seed of this run/],
      [base.sheet, item => (key(item) === 'r0-B-faulty-baseline BUG-0002' ? agree(item, { outcome: 'duplicate', seedId: null, duplicateOf: 'BUG-0002' }) : agree(item)), /cannot duplicate itself/],
      [base.sheet, item => (key(item) === 'r0-B-faulty-baseline BUG-0002' ? agree(item, { outcome: 'duplicate', seedId: null, duplicateOf: 'BUG-0999' }) : agree(item)), /BUG-0999 is not a judged finding/],
      [base.sheet, item => {
        if (key(item) === 'r0-B-faulty-baseline BUG-0002') return agree(item, { outcome: 'duplicate', seedId: null, duplicateOf: 'BUG-0003' });
        if (key(item) === 'r0-B-faulty-baseline BUG-0003') return agree(item, { outcome: 'duplicate', seedId: null, duplicateOf: 'BUG-0002' });
        return agree(item);
      }, /duplicateOf chain forms a cycle/],
      [base.sheet, item => (key(item) === 'r0-B-faulty-baseline BUG-0002' ? agree(item, { outcome: 'false-positive', seedId: seedIds[0] }) : agree(item)), /violates spot-check: .*seedId/],
    ];
    for (const [sheet, decide, pattern] of broken) {
      const result = finalize(writeSheet('sheet-broken.json', fill(sheet, decide)));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assert.equal(result.document, null);
    }
    cases++;
  }

  // 11. SHA-256 bindings: a tampered judge file, tampered private runs, or a judge file from other
  // runs is rejected.
  {
    const tamperedJudge = fresh('judge-tampered.json');
    const judgeText = readFileSync(judgePath, 'utf8');
    const original = `Judge reason for ${firstRandom.runId} ${firstRandom.findingId}.`;
    assert(judgeText.includes(original));
    writeFileSync(tamperedJudge, judgeText.replace(original, `${original.slice(0, -1)}!`));
    assertValid('judge-verdicts', readJson(tamperedJudge));
    const tampered = finalize(reviewedOncePath, [], { judge: tamperedJudge });
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /judgeSha256 mismatch/);
    assert.equal(tampered.document, null);

    const tamperedRuns = join(work, 'tampered', 'private-runs.json');
    mkdirSync(join(work, 'tampered'));
    writeFileSync(tamperedRuns, readFileSync(runsPath, 'utf8').replace('Synthetic public rule.', 'Synthetic public rule!'));
    const runsChanged = finalize(reviewedOncePath, [], { runsFile: tamperedRuns });
    assert.equal(runsChanged.status, 1);
    assert.match(runsChanged.stderr, /were not produced from private runs .* \(runsSha256 mismatch\)/);
    const sampleChanged = spotcheck(['sample', '--runs', tamperedRuns, '--judge', judgePath, '--output', fresh('never.json'), '--seed', '1']);
    assert.equal(sampleChanged.status, 1);
    assert.match(sampleChanged.stderr, /runsSha256 mismatch/);

    // A judge file bound to these runs that omits a judged row is refused.
    const partialJudge = fresh('judge-partial.json');
    const trimmed = structuredClone(judgedRuns);
    trimmed[1].verdicts.pop();
    writeJudge(partialJudge, runsSha256, trimmed);
    const uncovered = spotcheck(['sample', '--runs', runsPath, '--judge', partialJudge, '--output', fresh('never.json')]);
    assert.equal(uncovered.status, 1);
    assert.match(uncovered.stderr, /do not cover exactly the judged ledger rows/);
    cases++;
  }

  // 12. The sheet may only gain human decisions: a dropped, reclassified, or edited item, or a
  // changed sampling seed, no longer matches the recomputed selection.
  {
    const edits = [
      sheet => { sheet.items = sheet.items.filter(item => key(item) !== key(firstRandom)); },
      sheet => { sheet.items.find(item => key(item) === 'r0-B-faulty-baseline BUG-0005').reasonSelected = 'random'; },
      sheet => {
        const item = sheet.items.find(candidate => key(candidate) === key(secondRandom));
        item.judge.outcome = item.judge.outcome === 'false-positive' ? 'duplicate' : 'false-positive';
      },
      sheet => { sheet.items.find(item => key(item) === key(secondRandom)).judge.reason = 'Edited by the reviewer.'; },
      sheet => { sheet.samplingSeed = 54321; },
      sheet => { sheet.rate = 0.3; },
    ];
    for (const [index, edit] of edits.entries()) {
      const sheet = structuredClone(reviewedOnce);
      edit(sheet);
      const result = finalize(writeSheet('sheet-edited.json', sheet));
      assert.equal(result.status, 1, `edit ${index}: ${result.stderr}`);
      assert.match(result.stderr, /does not match the selection recomputed from the judge verdicts/, `edit ${index}`);
    }
    cases++;
  }

  // 13. Usage errors exit 2; an existing output is never replaced.
  {
    const usage = [
      [],
      ['score'],
      ['sample', ...common],
      ['sample', ...common, '--output', fresh('x.json'), '--all', '--seed', '1'],
      ['sample', ...common, '--output', fresh('x.json'), '--rate', '0'],
      ['sample', ...common, '--output', fresh('x.json'), '--rate', '1.5'],
      ['sample', ...common, '--output', fresh('x.json'), '--rate', '0.1234567'],
      ['sample', ...common, '--output', fresh('x.json'), '--minimum', '-1'],
      ['sample', ...common, '--output', fresh('x.json'), '--seed', '4294967296'],
      ['sample', ...common, '--output', fresh('x.json'), '--provisional'],
      ['finalize', ...common, '--output', fresh('x.json')],
      ['finalize', ...common, '--sheet', base.output, '--output', fresh('x.json'), '--all'],
    ];
    for (const args of usage) {
      const result = spotcheck(args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /usage: node scripts\/eval\/discovery\/spotcheck\.mjs sample/);
    }
    const existingSheet = spotcheck(['sample', ...common, '--output', base.output, '--seed', '1']);
    assert.equal(existingSheet.status, 1);
    assert.match(existingSheet.stderr, /already exists/);
    const existingFinal = spotcheck(['finalize', ...common, '--sheet', reviewedOncePath, '--output', reviewedOncePath]);
    assert.equal(existingFinal.status, 1);
    assert.match(existingFinal.stderr, /already exists/);
    cases++;
  }

  console.log(`PASS  human spot-check: ${cases} cases (mandatory items, stratified sample, seed replay, size rule, census, incomplete and provisional sheets, reliability boundary 0.10 and 0.20, evidence containment, human decision checks, SHA-256 bindings, sheet integrity, usage). Synthetic fixtures only; no model score claimed.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
