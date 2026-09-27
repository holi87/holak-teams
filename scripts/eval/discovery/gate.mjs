#!/usr/bin/env node
// Usage: node scripts/eval/discovery/gate.mjs --check
//        node scripts/eval/discovery/gate.mjs --compare <discovery-summary.json> [--variant <name>]
//
// The recorded-baseline discovery gate. baseline.json (argus-eval/discovery-baseline@1) is either
// `not-recorded`, which prints SKIP and passes, or `recorded`: the gated metrics of one variant of
// a scored discovery summary, bound to the Argus plugin digest that variant measured
// (lib/plugin-digest.mjs), to the corpus digest, and to the summary itself, which stays committed
// under evaluations/ with the recorded SHA-256. `--check` (the release gate) passes while the
// working tree's argus/claude digest equals the baseline's. After a plugin change it compares the
// newest scored evaluations/*.json with a variant that measured the current digest; without one,
// a waiver for that digest passes with a warning, and otherwise the gate fails. `--compare`
// compares one summary against the baseline directly. The candidate must follow the baseline
// protocol, and it fails when mean detected seeds, pooled precision, or (Mode A) the fail-to-pass
// regression rate dropped by more than the baseline thresholds, which may tighten
// DEFAULT_THRESHOLDS but never loosen them.
//
// Test-only flags, honored only with ARGUS_EVAL_SMOKE=1: --root <dir> (holds baseline.json and
// evaluations/), --plugin-root <dir>, and --corpus-digest <sha256>.
//
// Exit codes: 0 pass, skip (baseline not recorded), or waived; 1 invalid baseline or input (a
// schema violation, a threshold looser than the default, a recorded summary that is missing or
// disagrees with baseline.json, an unreadable plugin tree); 2 corpus changed since the baseline,
// or an incomparable candidate; 3 plugin content changed with no evaluation and no waiver; 4 a
// metric dropped beyond its threshold; 64 usage.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { corpusDigest } from './corpus/index.mjs';
import { pluginDigest } from './lib/plugin-digest.mjs';
import { formatSchemaErrors, validateEval } from './lib/schemas.mjs';

const USAGE = 'usage: node scripts/eval/discovery/gate.mjs --check | --compare <discovery-summary.json> [--variant <name>]';
export const DISCOVERY_ROOT = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL('../../../argus/claude', import.meta.url));
export const BASELINE_FILE = 'baseline.json';
export const EVALUATIONS_DIR = 'evaluations';
export const BASELINE_SCHEMA = 'argus-eval/discovery-baseline@1';
// The loosest thresholds a baseline may carry. A baseline may tighten them, never loosen them.
export const DEFAULT_THRESHOLDS = Object.freeze({ maxMeanDetectedSeedDrop: 1, maxPrecisionDrop: 0.05, maxRegressionFailToPassDrop: 0.05 });
export const EXIT = Object.freeze({ pass: 0, invalid: 1, incomparable: 2, unevaluated: 3, regressed: 4, usage: 64 });
// Drops are differences of binary floating-point values (0.75 - 0.7 is 0.050000000000000044), so
// a drop of exactly the threshold is compared with this tolerance and passes.
const EPSILON = 1e-9;
const SHA256 = /^[a-f0-9]{64}$/;
const TEST_VALUES = Object.freeze({ '--root': 'root', '--plugin-root': 'pluginRoot', '--corpus-digest': 'corpusDigest' });
const MODE_FIELDS = Object.freeze(['faultyRuns', 'seedsPerFaultyRun', 'meanDetectedSeeds', 'meanRecall', 'meanCriticalRecall', 'pooledPrecision', 'perSurfaceRecall']);
const REGRESSION_FIELDS = Object.freeze(['failToPassRate', 'specificRate', 'flakyRate']);

export class UsageError extends Error {}

// A failure with its exit code and optional detail lines.
export class GateError extends Error {
  constructor(exitCode, message, details = []) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const invalid = (message, details) => new GateError(EXIT.invalid, message, details);
export const shortDigest = digest => (digest ? digest.slice(0, 12) : 'none');

// Parses `--flag` and `--name <value>` arguments. The test-only values point the tool at another
// tree, plugin, or corpus, so they are honored only with ARGUS_EVAL_SMOKE=1.
export function parseOptions(argv, { values = {}, flags = {} }) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (seen.has(arg)) throw new UsageError(`${arg} was given twice`);
    seen.add(arg);
    if (Object.hasOwn(flags, arg)) {
      options[flags[arg]] = true;
      continue;
    }
    const testOnly = Object.hasOwn(TEST_VALUES, arg);
    if (!testOnly && !Object.hasOwn(values, arg)) throw new UsageError(`unknown argument ${arg}`);
    if (testOnly && process.env.ARGUS_EVAL_SMOKE !== '1') throw new UsageError(`${arg} is a test-only flag, honored only with ARGUS_EVAL_SMOKE=1`);
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${arg} requires a value`);
    options[testOnly ? TEST_VALUES[arg] : values[arg]] = value;
    index += 1;
  }
  if (options.corpusDigest !== undefined && !SHA256.test(options.corpusDigest)) throw new UsageError('--corpus-digest must be a lowercase hex SHA-256');
  return options;
}

// The inputs of the gate: baseline.json and evaluations/ under the discovery directory, the
// Argus plugin root, and the built-in corpus digest (computed only when a recorded baseline
// needs it).
export function gateContext(options) {
  const root = options.root === undefined ? DISCOVERY_ROOT : resolve(options.root);
  return {
    root,
    baselinePath: join(root, BASELINE_FILE),
    evaluationsDir: join(root, EVALUATIONS_DIR),
    pluginRoot: options.pluginRoot === undefined ? DEFAULT_PLUGIN_ROOT : resolve(options.pluginRoot),
    corpusDigest: () => options.corpusDigest ?? corpusDigest(),
  };
}

// A JSON document read from a regular file (never through a symbolic link), with the SHA-256 of
// its exact bytes.
function readJson(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw invalid(`${label} ${path} ${error.code === 'ENOENT' ? 'does not exist' : 'is not readable'}`);
  }
  if (!stat.isFile()) throw invalid(`${label} ${path} must be a regular file`);
  const bytes = readFileSync(path);
  try {
    return { document: JSON.parse(bytes), bytes, sha256: sha256(bytes) };
  } catch (error) {
    throw invalid(`${label} ${path} is not valid JSON: ${error.message}`);
  }
}

// A schema-valid argus-eval/discovery-summary@1 document, with its bytes and their SHA-256.
export function readSummary(path, label) {
  const read = readJson(path, label);
  const errors = validateEval('discovery-summary', read.document);
  if (errors.length) throw invalid(`${label} ${path} violates argus-eval/discovery-summary@1: ${formatSchemaErrors(errors)}`);
  return read;
}

// The schema-valid baseline. Thresholds looser than the defaults are refused, so an edit of
// baseline.json can tighten the gate but never relax it.
export function loadBaseline(path) {
  const { document } = readJson(path, 'baseline');
  const errors = validateEval('discovery-baseline', document);
  if (errors.length) throw invalid(`baseline ${path} violates ${BASELINE_SCHEMA}: ${formatSchemaErrors(errors)}`);
  const looser = Object.entries(DEFAULT_THRESHOLDS).filter(([name, limit]) => document.thresholds[name] > limit)
    .map(([name, limit]) => `${name} ${document.thresholds[name]} is looser than the default ${limit}`);
  if (looser.length) throw invalid(`baseline ${path} loosens the gate thresholds`, looser);
  if (document.status === 'recorded') {
    const modes = Object.keys(document.metrics.perMode).sort();
    if (!isDeepStrictEqual(modes, [...document.protocol.modes].sort())) {
      throw invalid(`baseline ${path} records metrics for modes [${modes.join(', ')}], not for its protocol modes [${document.protocol.modes.join(', ')}]`);
    }
  }
  return document;
}

// The gated subset of a scored variant's per-mode aggregates, as a baseline records it.
export function baselineMetrics(variant) {
  const perMode = {};
  for (const [mode, aggregate] of Object.entries(variant.perMode)) {
    const entry = Object.fromEntries(MODE_FIELDS.map(field => [field, aggregate[field]]));
    if (mode === 'A') entry.regression = Object.fromEntries(REGRESSION_FIELDS.map(field => [field, aggregate.regression?.[field] ?? null]));
    perMode[mode] = entry;
  }
  return { perMode };
}

// What a recorded baseline shares with the summary it names: everything except the recording
// time, the Argus version, the thresholds, and the waivers.
const summaryFields = (summary, variant) => ({ pluginDigest: variant.subject.pluginDigest, revision: variant.revision, corpus: summary.corpus,
  protocol: summary.protocol, metrics: baselineMetrics(variant), isolation: summary.isolation });
const baselineFields = baseline => ({ pluginDigest: baseline.subject.pluginDigest, revision: baseline.subject.revision, corpus: baseline.corpus,
  protocol: baseline.protocol, metrics: baseline.metrics, isolation: baseline.isolation });

// A recorded baseline is only as good as the summary it was recorded from: that summary must
// still be committed with the recorded SHA-256, and baseline.json must equal what
// record-baseline.mjs derives from it, so a hand edit of the recorded metrics cannot move the bar.
function verifyRecordedSummary(context, baseline) {
  const path = join(context.root, baseline.summary.path);
  const { document, sha256: digest } = readSummary(path, 'recorded summary');
  if (digest !== baseline.summary.sha256) throw invalid(`recorded summary ${path} has SHA-256 ${digest}, not the baseline's ${baseline.summary.sha256}`);
  const variant = document.status === 'scored'
    ? document.variants.find(entry => entry.subject.pluginDigest === baseline.subject.pluginDigest && entry.revision === baseline.subject.revision)
    : undefined;
  if (!variant || !isDeepStrictEqual(summaryFields(document, variant), baselineFields(baseline))) {
    throw invalid(`baseline ${context.baselinePath} does not match its recorded summary ${path}; record it again with record-baseline.mjs`);
  }
}

// The newest (by createdAt, then file name) schema-valid, scored evaluations/*.json with a
// variant that measured `digest`, or null. Invalid files are named in a warning, never skipped
// silently.
function findCandidate(context, digest) {
  let names;
  try {
    names = readdirSync(context.evaluationsDir).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw invalid(`evaluations directory ${context.evaluationsDir} is not readable: ${error.message}`);
  }
  const matches = [];
  for (const name of names) {
    const label = `${EVALUATIONS_DIR}/${name}`;
    let summary;
    try {
      ({ document: summary } = readSummary(join(context.evaluationsDir, name), 'evaluation'));
    } catch (error) {
      console.log(`WARN  discovery gate: ignoring ${label}: ${error.message}`);
      continue;
    }
    const variant = summary.variants.find(entry => entry.subject.pluginDigest === digest);
    if (!variant) continue;
    if (summary.status !== 'scored') {
      console.log(`WARN  discovery gate: ignoring ${label}: it measured plugin ${shortDigest(digest)} but is ${summary.status}, not scored`);
      continue;
    }
    matches.push({ label, summary, variant });
  }
  matches.sort((left, right) => Date.parse(right.summary.createdAt) - Date.parse(left.summary.createdAt) || (left.label < right.label ? -1 : 1));
  if (matches.length > 1) console.log(`  ${matches.length} scored evaluations measured plugin ${shortDigest(digest)}; comparing the newest, ${matches[0].label}`);
  return matches[0] ?? null;
}

// The summary given to --compare and its compared variant: the --variant one, or the only one.
function compareCandidate(path, variantName) {
  const label = resolve(path);
  const { document: summary } = readSummary(label, 'summary');
  if (summary.status !== 'scored') throw invalid(`summary ${label} is ${summary.status}; only a scored summary can be compared`);
  if (variantName === undefined && summary.variants.length !== 1) throw new UsageError(`summary ${label} has ${summary.variants.length} variants; name one with --variant`);
  const variant = variantName === undefined ? summary.variants[0] : summary.variants.find(entry => entry.name === variantName);
  if (!variant) throw invalid(`summary ${label} has no variant ${variantName} (variants: ${summary.variants.map(entry => entry.name).join(', ')})`);
  return { label, summary, variant };
}

// Every reason a candidate summary does not follow the baseline protocol ([] when comparable).
// The candidate may run more repeats, but its seeds must begin with the baseline's seeds (so they
// are identical when the repeat counts are equal), and it must cover every baseline mode and build.
export function comparabilityProblems(baseline, summary) {
  const recorded = baseline.protocol;
  const current = summary.protocol;
  const list = values => `[${values.join(', ')}]`;
  const problems = [];
  if (summary.corpus.digest !== baseline.corpus.digest) problems.push(`corpus digest ${shortDigest(summary.corpus.digest)} differs from the baseline's ${shortDigest(baseline.corpus.digest)}`);
  for (const key of ['modes', 'builds']) {
    const missing = recorded[key].filter(value => !current[key].includes(value));
    if (missing.length) problems.push(`${key} ${list(current[key])} lack the baseline's ${list(missing)}`);
  }
  if (current.repeats < recorded.repeats) problems.push(`${current.repeats} repeats, fewer than the baseline's ${recorded.repeats}`);
  if (!isDeepStrictEqual(current.seeds.slice(0, recorded.seeds.length), recorded.seeds)) problems.push(`seeds ${list(current.seeds)} do not begin with the baseline seeds ${list(recorded.seeds)}`);
  if (!isDeepStrictEqual(current.secondsByMode, recorded.secondsByMode)) {
    problems.push(`secondsByMode ${JSON.stringify(current.secondsByMode)} differs from the baseline's ${JSON.stringify(recorded.secondsByMode)}`);
  }
  for (const field of ['model', 'passes', 'systemPromptSha256']) {
    if (current.judge[field] !== recorded.judge[field]) problems.push(`judge ${field} ${current.judge[field]} differs from the baseline's ${recorded.judge[field]}`);
  }
  if (current.testMode) problems.push('the candidate is a testMode comparison');
  return problems;
}

const format = value => (value === null ? 'null' : String(Number(value.toFixed(6))));

// One line per gated metric of every baseline mode, and the number of failed checks. The drop is
// the baseline value minus the candidate value; an improvement always passes. A null baseline
// value has nothing to regress from; a null candidate value against a non-null baseline value
// counts as a drop.
export function compareMetrics(baseline, variant) {
  const { thresholds } = baseline;
  const lines = [];
  let failures = 0;
  for (const [mode, recorded] of Object.entries(baseline.metrics.perMode)) {
    const current = variant.perMode[mode];
    const checks = [
      ['meanDetectedSeeds', recorded.meanDetectedSeeds, current.meanDetectedSeeds, thresholds.maxMeanDetectedSeedDrop],
      ['pooledPrecision', recorded.pooledPrecision, current.pooledPrecision, thresholds.maxPrecisionDrop],
    ];
    if (mode === 'A') {
      checks.push(['regression.failToPassRate', recorded.regression.failToPassRate, current.regression?.failToPassRate ?? null, thresholds.maxRegressionFailToPassDrop]);
    }
    for (const [metric, before, after, limit] of checks) {
      let delta = 'n/a';
      let verdict;
      if (before === null) {
        verdict = 'ok (no baseline value)';
      } else if (after === null) {
        verdict = 'FAIL (no candidate value)';
      } else {
        const change = after - before;
        delta = change > 0 ? `+${format(change)}` : format(change);
        verdict = before - after > limit + EPSILON ? 'FAIL' : 'ok';
      }
      if (verdict.startsWith('FAIL')) failures += 1;
      lines.push(`  ${mode} ${metric}: baseline ${format(before)}, candidate ${format(after)}, delta ${delta} (max drop ${format(limit)}) ${verdict}`);
    }
  }
  return { lines, failures };
}

function runGate(options) {
  const context = gateContext(options);
  const baseline = loadBaseline(context.baselinePath);
  if (baseline.status === 'not-recorded') {
    console.log(`SKIP  discovery gate inactive: baseline not recorded (${baseline.reason})`);
    return EXIT.pass;
  }
  verifyRecordedSummary(context, baseline);
  const corpus = context.corpusDigest();
  if (corpus !== baseline.corpus.digest) {
    throw new GateError(EXIT.incomparable, 'corpus changed since baseline; re-record', [`baseline corpus: ${baseline.corpus.version} ${baseline.corpus.digest}`, `current corpus: ${corpus}`]);
  }
  const recorded = `argus ${baseline.subject.argusVersion}, plugin ${shortDigest(baseline.subject.pluginDigest)}, recorded ${baseline.recordedAt}`;
  let candidate;
  if (options.compare !== undefined) {
    candidate = compareCandidate(options.compare, options.variant);
  } else {
    let current;
    try {
      current = pluginDigest(context.pluginRoot);
    } catch (error) {
      throw invalid(`cannot digest the Argus plugin root ${context.pluginRoot}: ${error.message}`);
    }
    if (current === baseline.subject.pluginDigest) {
      console.log(`PASS  discovery gate: plugin unchanged since baseline (${recorded})`);
      return EXIT.pass;
    }
    candidate = findCandidate(context, current);
    if (candidate === null) {
      const waiver = baseline.waivers.find(entry => entry.pluginDigest === current);
      if (waiver) {
        console.log(`WARN  discovery gate: plugin ${shortDigest(current)} changed since the baseline (${recorded}) and has no discovery evaluation; waived by ${waiver.approvedBy} on ${waiver.createdAt}: ${waiver.reason}`);
        return EXIT.pass;
      }
      throw new GateError(EXIT.unevaluated, 'Argus plugin content changed since the recorded baseline; run the discovery evaluation and commit its summary', [
        `baseline: ${recorded}`,
        `current plugin digest: ${current}`,
        `no scored summary in ${context.evaluationsDir} measured it, and no waiver names it`,
      ]);
    }
  }
  console.log(`  baseline: ${recorded}`);
  console.log(`  candidate: ${candidate.label}, variant ${candidate.variant.name}, plugin ${shortDigest(candidate.variant.subject.pluginDigest)}, created ${candidate.summary.createdAt}`);
  const problems = comparabilityProblems(baseline, candidate.summary);
  if (problems.length) throw new GateError(EXIT.incomparable, `incomparable: ${candidate.label} does not follow the baseline protocol`, problems);
  const { lines, failures } = compareMetrics(baseline, candidate.variant);
  for (const line of lines) console.log(line);
  if (failures) throw new GateError(EXIT.regressed, `${failures} discovery metric${failures === 1 ? '' : 's'} dropped beyond the recorded baseline thresholds`);
  console.log(`PASS  discovery gate: ${candidate.label} is within the recorded baseline thresholds`);
  return EXIT.pass;
}

function parseGateArguments(argv) {
  const options = parseOptions(argv, { values: { '--compare': 'compare', '--variant': 'variant' }, flags: { '--check': 'check' } });
  if (Boolean(options.check) === (options.compare !== undefined)) throw new UsageError('pass exactly one of --check and --compare <summary.json>');
  if (options.variant !== undefined && options.compare === undefined) throw new UsageError('--variant applies only to --compare');
  return options;
}

// Prints a failure with its detail lines and returns its exit code.
export function reportFailure(label, error, usage) {
  if (error instanceof UsageError) {
    console.error(`FAIL  ${label}: ${error.message}\n${usage}`);
    return EXIT.usage;
  }
  console.error(`FAIL  ${label}: ${error.message}`);
  for (const detail of error.details ?? []) console.error(`  ${detail}`);
  return error instanceof GateError ? error.exitCode : EXIT.invalid;
}

// Runs only as a script; record-baseline.mjs imports the helpers above.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = runGate(parseGateArguments(process.argv.slice(2)));
  } catch (error) {
    process.exitCode = reportFailure('discovery gate', error, USAGE);
  }
}
