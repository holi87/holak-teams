#!/usr/bin/env node
// Usage: node scripts/eval/discovery/record-baseline.mjs --summary <discovery-summary.json> --variant <name> [--write]
//
// Records one variant of a scored discovery summary (adjudicate.mjs) as the baseline that
// gate.mjs enforces. It refuses unless the summary is `scored` (never scored-provisional or
// UNSCORED), ran at least 3 repeats including the faulty build and outside testMode, declares its
// isolation, has no invalid, contaminated, or excluded run, and has a reliable judge (at least 5
// random spot-check items with an overturn rate of at most 0.10, or a complete census). The
// variant must have measured the working tree's argus/claude plugin digest, and the summary the
// built-in corpus digest. Without --write it prints the planned baseline. With --write it copies
// the summary byte for byte to evaluations/argus-<version>-<digest12>.json and rewrites
// baseline.json atomically, keeping its thresholds and dropping the previous baseline's waivers.
//
// Test-only flags, honored only with ARGUS_EVAL_SMOKE=1: --root, --plugin-root, and
// --corpus-digest (see gate.mjs).
//
// Exit codes: 0 planned or recorded; 1 refused or invalid input; 64 usage.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BASELINE_SCHEMA, EVALUATIONS_DIR, EXIT, GateError, UsageError, baselineMetrics, gateContext, loadBaseline, parseOptions, readSummary, reportFailure,
  shortDigest } from './gate.mjs';
import { pluginSubject } from './lib/plugin-digest.mjs';
import { formatSchemaErrors, validateEval } from './lib/schemas.mjs';

const USAGE = 'usage: node scripts/eval/discovery/record-baseline.mjs --summary <discovery-summary.json> --variant <name> [--write]';
const MIN_REPEATS = 3;
const MIN_RANDOM_SAMPLED = 5;
const MAX_OVERTURN_RATE = 0.1;
const VERSION = /^[0-9A-Za-z.+-]+$/;

// Every reason the summary variant cannot become the baseline ([] when it can).
function refusals(summary, variant, current) {
  const { protocol } = summary;
  const problems = [];
  if (summary.status !== 'scored') problems.push(`the summary is ${summary.status}; only a scored summary from final verdicts can be recorded`);
  if (protocol.repeats < MIN_REPEATS) problems.push(`the comparison ran ${protocol.repeats} repeats; a baseline needs at least ${MIN_REPEATS}`);
  if (protocol.testMode) problems.push('the comparison ran in testMode');
  if (!protocol.builds.includes('faulty')) problems.push('the comparison ran no faulty build, so it measured no seed detection');
  if (summary.isolation.declared === null) problems.push('the summary declares no isolation; adjudicate with --isolation separate-user (recommended) or same-user');
  if (summary.excludedRuns.length) problems.push(`the summary excludes contaminated runs (${summary.excludedRuns.join(', ')})`);
  for (const [mode, aggregate] of Object.entries(variant.perMode ?? {})) {
    if (aggregate.invalidRuns) problems.push(`mode ${mode} has ${aggregate.invalidRuns} invalid run(s)`);
    if (aggregate.contaminatedRuns) problems.push(`mode ${mode} has ${aggregate.contaminatedRuns} contaminated run(s)`);
  }
  // The judge reliability is the final verdicts' own, copied into every mode. A complete census
  // (spotcheck.mjs sample --all) put every verdict under human review, so it samples nothing and
  // needs no sample.
  const reliability = Object.values(variant.perMode ?? {})[0]?.judgeReliability;
  const census = protocol.spotCheck.all && protocol.spotCheck.pending === 0;
  if (reliability && !census) {
    if (reliability.randomSampled < MIN_RANDOM_SAMPLED) {
      problems.push(`the spot-check sampled ${reliability.randomSampled} random item(s); a baseline needs at least ${MIN_RANDOM_SAMPLED}, or a census (spotcheck.mjs sample --all)`);
    }
    if (reliability.overturnRate === null || reliability.overturnRate > MAX_OVERTURN_RATE) {
      problems.push(`the judge overturn rate ${reliability.overturnRate} is above ${MAX_OVERTURN_RATE}`);
    }
  }
  if (summary.corpus.digest !== current.corpusDigest) problems.push(`the corpus digest ${summary.corpus.digest ?? 'null'} is not the built-in corpus digest ${current.corpusDigest}`);
  if (variant.subject.pluginDigest !== current.pluginDigest) {
    problems.push(`variant ${variant.name} measured plugin ${variant.subject.pluginDigest ?? 'null'}, not this working tree's ${current.pluginDigest}`);
  }
  return problems;
}

// Copies the summary bytes to the evaluation path. An existing file is kept only when it holds
// the same bytes; a different file is never replaced.
function copyEvaluation(bytes, path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
    return 'copied';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isFile() || !readFileSync(path).equals(bytes)) throw new GateError(EXIT.invalid, `evaluation ${path} already exists with other content; it is never replaced`);
  return 'already present';
}

// Replaces baseline.json through a temporary file and a rename.
function writeBaseline(path, baseline) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recordBaseline(options) {
  const context = gateContext(options);
  const existing = loadBaseline(context.baselinePath);
  const summaryPath = resolve(options.summary);
  const { document: summary, bytes, sha256 } = readSummary(summaryPath, 'summary');
  const variant = summary.variants.find(entry => entry.name === options.variant);
  if (!variant) throw new GateError(EXIT.invalid, `summary ${summaryPath} has no variant ${options.variant} (variants: ${summary.variants.map(entry => entry.name).join(', ')})`);
  let subject;
  try {
    subject = pluginSubject(context.pluginRoot);
  } catch (error) {
    throw new GateError(EXIT.invalid, `cannot identify the Argus plugin root ${context.pluginRoot}: ${error.message}`);
  }
  const problems = refusals(summary, variant, { pluginDigest: subject.pluginDigest, corpusDigest: context.corpusDigest() });
  if (!VERSION.test(subject.pluginVersion ?? '')) problems.push(`the plugin manifest version ${subject.pluginVersion} cannot name an evaluation file`);
  if (problems.length) throw new GateError(EXIT.invalid, `refusing to record variant ${variant.name} of ${summaryPath} as the discovery baseline`, problems);

  const fileName = `argus-${subject.pluginVersion}-${shortDigest(subject.pluginDigest)}.json`;
  const baseline = {
    schema: BASELINE_SCHEMA,
    status: 'recorded',
    recordedAt: new Date().toISOString(),
    subject: { argusVersion: subject.pluginVersion, pluginDigest: subject.pluginDigest, revision: variant.revision },
    corpus: summary.corpus,
    protocol: summary.protocol,
    metrics: baselineMetrics(variant),
    summary: { path: `${EVALUATIONS_DIR}/${fileName}`, sha256 },
    isolation: summary.isolation,
    thresholds: existing.thresholds,
    waivers: [],
  };
  const errors = validateEval('discovery-baseline', baseline);
  if (errors.length) throw new GateError(EXIT.invalid, `the planned baseline violates ${BASELINE_SCHEMA}: ${formatSchemaErrors(errors)}`);
  if (summary.isolation.declared === 'same-user') {
    console.error('WARN  record-baseline: isolation same-user; the Argus OS sandbox confines writes, not reads, so record baselines as a separate OS user or in a container');
  }
  const dropped = existing.waivers.length ? `, dropping ${existing.waivers.length} waiver(s) of the previous baseline` : '';
  if (!options.write) {
    console.log(JSON.stringify(baseline, null, 2));
    console.error(`PLAN  record-baseline: would copy ${summaryPath} to ${join(context.evaluationsDir, fileName)} and rewrite ${context.baselinePath}${dropped}; pass --write to record`);
    return EXIT.pass;
  }
  const copied = copyEvaluation(bytes, join(context.evaluationsDir, fileName));
  writeBaseline(context.baselinePath, baseline);
  console.log(`PASS  record-baseline: recorded argus ${subject.pluginVersion}, plugin ${shortDigest(subject.pluginDigest)} (variant ${variant.name}, revision ${variant.revision.slice(0, 12)}); `
    + `${baseline.summary.path} ${copied}${dropped}; commit it together with ${basename(context.baselinePath)}`);
  return EXIT.pass;
}

function parseRecordArguments(argv) {
  const options = parseOptions(argv, { values: { '--summary': 'summary', '--variant': 'variant' }, flags: { '--write': 'write' } });
  const missing = ['summary', 'variant'].filter(name => options[name] === undefined);
  if (missing.length) throw new UsageError(`missing ${missing.map(name => `--${name}`).join(', ')}`);
  return options;
}

try {
  process.exitCode = recordBaseline(parseRecordArguments(process.argv.slice(2)));
} catch (error) {
  process.exitCode = reportFailure('record-baseline', error, USAGE);
}
