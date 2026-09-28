#!/usr/bin/env node
// Usage: node scripts/eval/discovery/spotcheck.mjs sample --runs <private-runs.json> --judge <judge-verdicts.json>
//          --output <spot-check.json> [--rate 0.2] [--minimum 5] [--seed <int>] [--all]
//        node scripts/eval/discovery/spotcheck.mjs finalize --runs <private-runs.json> --judge <judge-verdicts.json>
//          --sheet <spot-check.json> --output <final-verdicts.json> [--provisional]
//
// Human spot-check of the first-pass judge. `sample` writes a review sheet
// (argus-eval/spot-check@1) bound to the private runs and the judge verdicts by SHA-256. It holds
// every verdict a human must review (judge failure, pass disagreement, seed-probe mismatch,
// unseeded real, low confidence) plus a seeded random sample of the remaining verdicts,
// stratified by outcome. The reviewer fills each item's `human` decision. `finalize` recomputes
// the selection from the recorded sampling parameters (so no item can be dropped, added or
// swapped), validates every decision, estimates the judge's overturn rate from the random items
// only, and writes argus-eval/final-verdicts@1: the human decision where reviewed, the judge's
// elsewhere.
//
// Exit codes: 0 output written (final or provisional); 1 invalid input; 2 usage; 20 incomplete
// sheet; 22 judge unreliable (more than 10% of the random items overturned; the output is written
// with that status and the remedy is `sample --all`, which puts every verdict under human review).
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertEval } from './lib/schemas.mjs';

const USAGE = [
  'usage: node scripts/eval/discovery/spotcheck.mjs sample --runs <private-runs.json> --judge <judge-verdicts.json> --output <spot-check.json> [--rate 0.2] [--minimum 5] [--seed <int>] [--all]',
  '       node scripts/eval/discovery/spotcheck.mjs finalize --runs <private-runs.json> --judge <judge-verdicts.json> --sheet <spot-check.json> --output <final-verdicts.json> [--provisional]',
].join('\n');
const COMMANDS = Object.freeze({
  sample: {
    values: { '--runs': 'runs', '--judge': 'judge', '--output': 'output', '--rate': 'rate', '--minimum': 'minimum', '--seed': 'seed' },
    flags: { '--all': 'all' },
    required: ['runs', 'judge', 'output'],
  },
  finalize: {
    values: { '--runs': 'runs', '--judge': 'judge', '--sheet': 'sheet', '--output': 'output' },
    flags: { '--provisional': 'provisional' },
    required: ['runs', 'judge', 'sheet', 'output'],
  },
});
const SCORABLE = new Set(['awaiting-adjudication', 'timed-out']);
// Mandatory review reasons in precedence order; a verdict matching several records the first. A
// failed verdict also has agreement false, and a disagreement or a probe mismatch forces low
// confidence, so the more specific reasons come first.
const MANDATORY = Object.freeze(['judge-failed', 'disagreement', 'probe-mismatch', 'unseeded-real', 'low-confidence']);
// Every remaining verdict has one of these outcomes (unseeded real and failed verdicts are mandatory).
const STRATA = Object.freeze(['real-seeded', 'false-positive', 'duplicate']);
const DEFAULT_RATE = '0.2';
const DEFAULT_MINIMUM = 5;
const MAX_SEED = 4294967295;
// The judge is unreliable when more than one in ten random items is overturned. Compared in
// integers, so exactly 0.10 stays reliable.
const MAX_OVERTURN = Object.freeze({ numerator: 1, denominator: 10 });
const EXIT_INCOMPLETE = 20;
const EXIT_UNRELIABLE = 22;
const FILE_MODE = 0o600;
const REPRO_DIR = 'repro';
const PREVIEW_ITEMS = 5;

class UsageError extends Error {}

class ExitError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const itemKey = (runId, findingId) => `${runId} ${findingId}`;
const preview = items => [
  ...items.slice(0, PREVIEW_ITEMS).map(item => itemKey(item.runId, item.findingId)),
  ...(items.length > PREVIEW_ITEMS ? [`... ${items.length - PREVIEW_ITEMS} more`] : []),
].join(', ');

// A rate is a decimal in (0, 1] with at most six decimal places, kept as an exact fraction so the
// sample size is computed in integers (0.14 x 50 is 7, not 7.000000000000001 rounded up to 8).
function parseRate(text) {
  const match = /^(?:0\.([0-9]{1,6})|1(?:\.0{1,6})?)$/.exec(text);
  if (!match) return null;
  const rate = match[1] === undefined ? { numerator: 1, denominator: 1 } : { numerator: Number(match[1]), denominator: 10 ** match[1].length };
  return rate.numerator === 0 ? null : { ...rate, value: Number(text) };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError('a subcommand is required: sample or finalize');
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`unknown subcommand ${command}`);
  const spec = COMMANDS[command];
  const options = { command };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (seen.has(flag)) throw new UsageError(`${flag} was given twice`);
    seen.add(flag);
    if (Object.hasOwn(spec.flags, flag)) {
      options[spec.flags[flag]] = true;
      continue;
    }
    if (!Object.hasOwn(spec.values, flag)) throw new UsageError(`unknown argument ${flag} for ${command}`);
    const value = rest[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    options[spec.values[flag]] = value;
    index += 1;
  }
  const missing = spec.required.filter(name => options[name] === undefined);
  if (missing.length) throw new UsageError(`${command} requires ${missing.map(name => `--${name}`).join(', ')}`);
  for (const name of ['runs', 'judge', 'sheet', 'output']) {
    if (options[name] !== undefined) options[name] = resolve(options[name]);
  }
  if (command === 'sample') {
    options.all = options.all === true;
    if (options.all) {
      const conflicting = ['rate', 'minimum', 'seed'].filter(name => options[name] !== undefined);
      if (conflicting.length) throw new UsageError(`--all selects every verdict and cannot be combined with ${conflicting.map(name => `--${name}`).join(', ')}`);
    } else {
      options.rate = parseRate(options.rate ?? DEFAULT_RATE);
      if (!options.rate) throw new UsageError('--rate must be a decimal greater than 0 and at most 1, with at most six decimal places');
      if (options.minimum === undefined) options.minimum = DEFAULT_MINIMUM;
      else if (/^[0-9]{1,6}$/.test(options.minimum)) options.minimum = Number(options.minimum);
      else throw new UsageError('--minimum must be an integer from 0 to 999999');
      if (options.seed !== undefined) {
        if (!/^[0-9]{1,10}$/.test(options.seed) || Number(options.seed) > MAX_SEED) throw new UsageError(`--seed must be an integer from 0 to ${MAX_SEED}`);
        options.seed = Number(options.seed);
      }
    }
  }
  options.provisional = options.provisional === true;
  return options;
}

// Refuses symbolic links and special files; returns the file's bytes.
function readRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} ${path} ${error.code === 'ENOENT' ? 'does not exist' : 'is not readable'}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} ${path} must be a regular file`);
  return readFileSync(path);
}

// A schema-valid evaluator document with the SHA-256 of its exact bytes.
function readDocument(path, label, schemaName) {
  const bytes = readRegularFile(path, label);
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} ${path} is not valid JSON: ${error.message}`);
  }
  assertEval(schemaName, document, `${label} ${path}`);
  return { document, sha256: sha256(bytes) };
}

// The physical output path. An existing output is never replaced: a sheet may already hold
// reviews, and every finalize is kept as its own record.
function outputTarget(path) {
  let exists = true;
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) throw new Error(`output ${path} already exists; pass a new path`);
  let parent;
  try {
    parent = realpathSync(dirname(path));
  } catch {
    throw new Error(`the parent directory of output ${path} must exist`);
  }
  return join(parent, basename(path));
}

// Writes through a temporary file; link(2) refuses to replace a name created meanwhile.
function writeExclusive(path, document) {
  const temporary = join(dirname(path), `.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
  try {
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// The judge verdicts must be exactly the judgement of these private runs: bound by runsSha256,
// in recorded run order, skipping exactly the non-scorable runs, covering exactly the ledger rows
// the judge judges (confirmed rows, then suspected rows when it included them), crediting only
// the run's truth seeds, and citing only earlier findings as duplicates.
function checkJudgeCoverage(privateRuns, judgeDocument) {
  const { runs } = privateRuns;
  if (judgeDocument.runs.length !== runs.length || judgeDocument.runs.some((run, index) => run.runId !== runs[index].runId)) {
    throw new Error('judge verdicts do not list the private runs in recorded order');
  }
  for (const [index, judged] of judgeDocument.runs.entries()) {
    const run = runs[index];
    const skipped = SCORABLE.has(run.status) ? null : run.status;
    if (judged.skipped !== skipped) throw new Error(`judge verdicts for ${run.runId} record skipped ${judged.skipped}; the run status requires ${skipped}`);
    const rows = skipped ? [] : [...run.extraction.findings, ...(judgeDocument.judge.includeSuspected ? run.extraction.suspected : [])];
    const expected = rows.map(row => `${row.id}:${row.status}`);
    const actual = judged.verdicts.map(verdict => `${verdict.findingId}:${verdict.status}`);
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`judge verdicts for ${run.runId} do not cover exactly the judged ledger rows in order (expected ${expected.join(', ') || 'none'})`);
    }
    const truth = new Set(run.truth.map(seed => seed.id));
    const earlier = new Set();
    for (const verdict of judged.verdicts) {
      if (verdict.seedId !== null && !truth.has(verdict.seedId)) throw new Error(`judge verdict ${itemKey(run.runId, verdict.findingId)} credits ${verdict.seedId}, which is not a seed of the run`);
      if (verdict.duplicateOf !== null && !earlier.has(verdict.duplicateOf)) throw new Error(`judge verdict ${itemKey(run.runId, verdict.findingId)} cites ${verdict.duplicateOf}, which is not an earlier finding of the run`);
      earlier.add(verdict.findingId);
    }
  }
}

function loadRunsAndJudge(options) {
  const runs = readDocument(options.runs, 'private runs', 'private-runs');
  const judge = readDocument(options.judge, 'judge verdicts', 'judge-verdicts');
  if (judge.document.runsSha256 !== runs.sha256) {
    throw new Error(`judge verdicts ${options.judge} were not produced from private runs ${options.runs} (runsSha256 mismatch)`);
  }
  checkJudgeCoverage(runs.document, judge.document);
  return { runs, judge, runsDir: dirname(realpathSync(options.runs)) };
}

function mandatoryReason(verdict) {
  const matches = {
    'judge-failed': verdict.judgeFailed,
    disagreement: !verdict.agreement,
    'probe-mismatch': verdict.seedProbeConfirmed === false,
    'unseeded-real': verdict.outcome === 'real' && verdict.seedId === null,
    'low-confidence': verdict.confidence === 'low',
  };
  return MANDATORY.find(reason => matches[reason]) ?? null;
}

const stratumOf = verdict => (verdict.outcome === 'real' ? 'real-seeded' : verdict.outcome);

// mulberry32: a small, fast 32-bit PRNG whose whole stream is fixed by the seed.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// min(remaining, max(minimum, ceil(rate x remaining))), in integer arithmetic.
function sampleSize(remaining, rate, minimum) {
  if (!remaining) return 0;
  const proportional = Math.floor((rate.numerator * remaining + rate.denominator - 1) / rate.denominator);
  return Math.min(remaining, Math.max(minimum, proportional));
}

// Proportional allocation by largest remainder (ties in stratum order). Every verdict keeps the
// same inclusion probability up to rounding, so the plain overturn ratio of the random items
// estimates the overturn rate of all remaining verdicts.
function allocate(size, counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) return counts.map(() => 0);
  const quotas = counts.map(count => Math.floor((size * count) / total));
  const remainders = counts.map(count => (size * count) % total);
  let leftover = size - quotas.reduce((sum, quota) => sum + quota, 0);
  const order = counts.map((_, index) => index).sort((left, right) => remainders[right] - remainders[left] || left - right);
  for (const index of order) {
    if (!leftover) break;
    quotas[index] += 1;
    leftover -= 1;
  }
  return quotas;
}

// `count` entries drawn uniformly without replacement (a partial Fisher-Yates shuffle).
function draw(entries, count, random) {
  const pool = [...entries];
  for (let index = 0; index < count; index += 1) {
    const swap = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count);
}

// The review set. It depends only on the judge verdicts (in private-runs and verdict order) and
// the plan, so finalize can recompute it exactly. Items keep that natural order.
function selectItems(judgeDocument, plan) {
  const entries = judgeDocument.runs.flatMap(run => run.verdicts.map(verdict => ({ runId: run.runId, verdict, reason: mandatoryReason(verdict) })));
  const remaining = entries.filter(entry => entry.reason === null);
  const strata = STRATA.map(name => remaining.filter(entry => stratumOf(entry.verdict) === name));
  let quotas;
  if (plan.all) {
    quotas = strata.map(stratum => stratum.length);
    for (const entry of remaining) entry.reason = 'census';
  } else {
    quotas = allocate(sampleSize(remaining.length, plan.rate, plan.minimum), strata.map(stratum => stratum.length));
    const random = mulberry32(plan.seed);
    strata.forEach((stratum, index) => {
      for (const entry of draw(stratum, quotas[index], random)) entry.reason = 'random';
    });
  }
  const population = {
    verdicts: entries.length,
    mandatory: entries.length - remaining.length,
    remaining: remaining.length,
    selected: quotas.reduce((sum, quota) => sum + quota, 0),
    strata: Object.fromEntries(STRATA.map((name, index) => [name, { remaining: strata[index].length, selected: quotas[index] }])),
  };
  const items = entries.filter(entry => entry.reason !== null).map(({ runId, verdict, reason }) => ({
    runId,
    findingId: verdict.findingId,
    reasonSelected: reason,
    judge: { outcome: verdict.outcome, seedId: verdict.seedId, duplicateOf: verdict.duplicateOf, reason: verdict.reason },
    packetPath: verdict.packetPath,
    human: null,
  }));
  return { population, items };
}

function sample(options) {
  const { runs, judge } = loadRunsAndJudge(options);
  const outputPath = outputTarget(options.output);
  const seed = options.all ? null : options.seed ?? randomInt(0, MAX_SEED + 1);
  const { population, items } = selectItems(judge.document, { all: options.all, seed, rate: options.rate, minimum: options.minimum });
  const sheet = {
    schema: 'argus-eval/spot-check@1',
    createdAt: new Date().toISOString(),
    runsSha256: runs.sha256,
    judgeSha256: judge.sha256,
    all: options.all,
    samplingSeed: seed,
    rate: options.all ? null : options.rate.value,
    minimum: options.all ? null : options.minimum,
    population,
    items,
  };
  assertEval('spot-check', sheet, 'spot-check sheet');
  writeExclusive(outputPath, sheet);
  console.log(JSON.stringify({
    status: 'AWAITING-REVIEW',
    verdicts: population.verdicts,
    items: items.length,
    mandatory: population.mandatory,
    random: options.all ? 0 : population.selected,
    census: options.all ? population.selected : 0,
    samplingSeed: seed,
    output: outputPath,
  }));
  return 0;
}

const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// A reviewer's evidence reference (relative to the run's artifact root, or absolute) must name an
// existing regular file whose physical path lies inside the run's artifact root or the physical
// <runsDir>/repro/ directory. Symbolic links are resolved, so one that points outside is refused.
// Returns the physical path, which the final verdicts record.
function resolveEvidence(reference, run, runsDir, label) {
  if (reference.includes('\0')) throw new Error(`${label}: evidenceRef is not a valid path`);
  const roots = [];
  try {
    roots.push(realpathSync(run.artifactRoot));
  } catch {
    // A missing artifact root leaves only the repro directory.
  }
  const repro = join(runsDir, REPRO_DIR);
  try {
    if (lstatSync(repro).isDirectory() && realpathSync(repro) === repro) roots.push(repro);
  } catch {
    // No repro directory.
  }
  let target;
  try {
    target = realpathSync(resolve(run.artifactRoot, reference));
  } catch {
    throw new Error(`${label}: evidenceRef ${reference} does not exist`);
  }
  if (!roots.some(root => isInside(root, target))) {
    throw new Error(`${label}: evidenceRef ${reference} resolves outside the run's artifact root and ${repro}${sep}`);
  }
  if (!statSync(target).isFile()) throw new Error(`${label}: evidenceRef ${reference} is not a regular file`);
  return target;
}

// Every final duplicate must lead, through duplicateOf, to a finding that is not a duplicate.
// Judge duplicates cite only earlier findings; a human decision may cite any other finding.
function checkDuplicateChains(finalRuns) {
  for (const run of finalRuns) {
    const byId = new Map(run.verdicts.map(verdict => [verdict.findingId, verdict]));
    for (const verdict of run.verdicts) {
      const seen = new Set([verdict.findingId]);
      let current = verdict;
      while (current.outcome === 'duplicate') {
        const next = byId.get(current.duplicateOf);
        if (seen.has(next.findingId)) throw new Error(`${itemKey(run.runId, verdict.findingId)}: the final duplicateOf chain forms a cycle through ${next.findingId}`);
        seen.add(next.findingId);
        current = next;
      }
    }
  }
}

const overturned = item => item.human.outcome !== item.judge.outcome || item.human.seedId !== item.judge.seedId;

function finalize(options) {
  const { runs, judge, runsDir } = loadRunsAndJudge(options);
  const sheet = readDocument(options.sheet, 'spot-check sheet', 'spot-check');
  const outputPath = outputTarget(options.output);
  const record = sheet.document;
  if (record.runsSha256 !== runs.sha256) throw new Error(`spot-check sheet ${options.sheet} was sampled from different private runs (runsSha256 mismatch)`);
  if (record.judgeSha256 !== judge.sha256) throw new Error(`judge verdicts ${options.judge} differ from the ones spot-check sheet ${options.sheet} was sampled from (judgeSha256 mismatch)`);

  // The sheet may only gain human decisions: its selection must equal the recomputed one.
  let plan = { all: true };
  if (!record.all) {
    const rate = parseRate(String(record.rate));
    if (!rate || rate.value !== record.rate) throw new Error(`spot-check sheet rate ${record.rate} is not a decimal with at most six decimal places`);
    plan = { all: false, seed: record.samplingSeed, rate, minimum: record.minimum };
  }
  const expected = selectItems(judge.document, plan);
  const withoutHuman = ({ human, ...rest }) => rest;
  const mismatch = record.items.findIndex((item, index) => index >= expected.items.length || !isDeepStrictEqual(withoutHuman(item), withoutHuman(expected.items[index])));
  if (!isDeepStrictEqual(record.population, expected.population) || record.items.length !== expected.items.length || mismatch !== -1) {
    const detail = mismatch !== -1 ? `item ${mismatch} (${itemKey(record.items[mismatch].runId, record.items[mismatch].findingId)}) differs`
      : `it has ${record.items.length} items and population ${JSON.stringify(record.population)}, expected ${expected.items.length} items and ${JSON.stringify(expected.population)}`;
    throw new Error(`spot-check sheet ${options.sheet} does not match the selection recomputed from the judge verdicts and its sampling parameters: ${detail}; only the human fields may be edited`);
  }

  const runById = new Map(runs.document.runs.map(run => [run.runId, run]));
  const judgedIds = new Map(judge.document.runs.map(run => [run.runId, new Set(run.verdicts.map(verdict => verdict.findingId))]));
  const decisions = new Map();
  for (const item of record.items) {
    if (item.human === null) continue;
    const label = itemKey(item.runId, item.findingId);
    const run = runById.get(item.runId);
    const { human } = item;
    if (human.seedId !== null && !run.truth.some(seed => seed.id === human.seedId)) throw new Error(`${label}: seedId ${human.seedId} is not a seed of this run`);
    if (human.duplicateOf === item.findingId) throw new Error(`${label}: a finding cannot duplicate itself`);
    if (human.duplicateOf !== null && !judgedIds.get(item.runId).has(human.duplicateOf)) throw new Error(`${label}: duplicateOf ${human.duplicateOf} is not a judged finding of this run`);
    const evidenceRef = human.evidenceRef === null ? null : resolveEvidence(human.evidenceRef, run, runsDir, label);
    decisions.set(label, { item, evidenceRef });
  }

  const pending = record.items.filter(item => item.human === null);
  if (pending.length && !options.provisional) {
    throw new ExitError(`the spot-check sheet is incomplete: ${pending.length} of ${record.items.length} items have no human decision (${preview(pending)}); review them, or pass --provisional for a provisional snapshot`, EXIT_INCOMPLETE);
  }
  const failedPending = pending.filter(item => item.reasonSelected === 'judge-failed');
  if (failedPending.length) {
    throw new ExitError(`every judge-failed verdict needs a human decision, even with --provisional: ${failedPending.length} have none (${preview(failedPending)})`, EXIT_INCOMPLETE);
  }

  const finalRuns = judge.document.runs.map(run => ({
    runId: run.runId,
    verdicts: run.verdicts.map(verdict => {
      const decision = decisions.get(itemKey(run.runId, verdict.findingId));
      if (!decision) {
        return { findingId: verdict.findingId, status: verdict.status, outcome: verdict.outcome, seedId: verdict.seedId, duplicateOf: verdict.duplicateOf,
          source: 'judge', confidence: verdict.confidence, reason: verdict.reason, evidenceRef: null, humanReproduced: null, reviewer: null, overturned: null };
      }
      const { human } = decision.item;
      return { findingId: verdict.findingId, status: verdict.status, outcome: human.outcome, seedId: human.seedId, duplicateOf: human.duplicateOf,
        source: 'human', confidence: null, reason: human.reason, evidenceRef: decision.evidenceRef, humanReproduced: human.reproduced,
        reviewer: human.reviewer, overturned: overturned(decision.item) };
    }),
  }));
  checkDuplicateChains(finalRuns);

  // Reliability counts only the random items: the mandatory ones are chosen for being doubtful,
  // so their overturns would bias the estimate. A partial sheet is judged against the whole random
  // sample, so it is unreliable only once no remaining review could bring the rate back to 0.10.
  const random = record.items.filter(item => item.reasonSelected === 'random');
  const reviewed = random.filter(item => item.human !== null);
  const randomOverturned = reviewed.filter(overturned).length;
  const reliability = {
    randomSampled: random.length,
    randomReviewed: reviewed.length,
    randomOverturned,
    overturnRate: reviewed.length ? randomOverturned / reviewed.length : null,
    maxOverturnRate: MAX_OVERTURN.numerator / MAX_OVERTURN.denominator,
  };
  const unreliable = randomOverturned * MAX_OVERTURN.denominator > random.length * MAX_OVERTURN.numerator;
  const status = unreliable ? 'judge-unreliable' : pending.length ? 'provisional' : 'final';

  const { model, effort, passes, claudeVersion, systemPromptSha256, includeSuspected } = judge.document.judge;
  const document = {
    schema: 'argus-eval/final-verdicts@1',
    status,
    createdAt: new Date().toISOString(),
    runsSha256: runs.sha256,
    judgeSha256: judge.sha256,
    sheetSha256: sheet.sha256,
    judge: { model, effort, passes, claudeVersion, systemPromptSha256, includeSuspected },
    spotCheck: { all: record.all, samplingSeed: record.samplingSeed, rate: record.rate, minimum: record.minimum,
      items: record.items.length, reviewed: record.items.length - pending.length, pending: pending.length },
    reliability,
    runs: finalRuns,
  };
  assertEval('final-verdicts', document, 'final verdicts');
  writeExclusive(outputPath, document);
  const verdicts = finalRuns.flatMap(run => run.verdicts);
  console.log(JSON.stringify({
    status,
    verdicts: verdicts.length,
    human: verdicts.filter(verdict => verdict.source === 'human').length,
    judge: verdicts.filter(verdict => verdict.source === 'judge').length,
    pending: pending.length,
    reliability,
    output: outputPath,
  }));
  if (!unreliable) return 0;
  console.error(`spotcheck: judge unreliable: ${randomOverturned} of ${random.length} random items overturned (more than ${reliability.maxOverturnRate}); run \`spotcheck.mjs sample --all\` and review every verdict`);
  return EXIT_UNRELIABLE;
}

try {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = options.command === 'sample' ? sample(options) : finalize(options);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`spotcheck: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`spotcheck: ${error.message}`);
    process.exitCode = error instanceof ExitError ? error.code : 1;
  }
}
