#!/usr/bin/env node
// Maintainer tool: re-stamp argus/prompt-budgets.json approvedCorpus for the current prompt
// corpus, either as a pending approval bound to one Argus release or with adjudicated
// discovery evidence that the corpus did not regress: the argus-eval/discovery-summary@1 that
// scripts/eval/discovery/adjudicate.mjs writes for a paired baseline/candidate comparison.
//
// The summary must be scored (not provisional or UNSCORED) and must not be a testMode run. The
// candidate must reach the baseline within the nonRegression tolerances in every mode the
// comparison ran. The recorded evidence keeps one figure per side and metric: the minimum
// across those modes (critical recall over the modes where both sides have one), with `runs`
// the fewest scored faulty runs, the repeats that recall is averaged over. If every mode
// passes, these minima pass the prompt gate's own re-check.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSchemaErrors, validateEval } from './eval/discovery/lib/schemas.mjs';
import {
  AGENTS_DIR,
  CAPABILITY_MATRIX,
  SHARED_SKILLS_DIR,
  computePromptCorpus,
  doctrineProfileNames,
  evaluateNonRegression,
  hashPromptCorpus,
  readArgusPluginVersion,
  sha256,
} from './lib/argus-prompt-corpus.mjs';

const BUDGET_FILE = 'argus/prompt-budgets.json';
const VALUE_FLAGS = new Set(['--root', '--approved-for', '--release', '--benchmark-pending', '--benchmark', '--baseline-variant', '--candidate-variant', '--adjudicated-at']);
const BOOLEAN_FLAGS = new Set(['--write', '--help']);
const SUMMARY_SCHEMA = 'argus-eval/discovery-summary@1';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const USAGE = `usage: approve-argus-prompts.mjs --approved-for <text>
         (--benchmark-pending <reason> | --benchmark <discovery-summary.json> --baseline-variant <name> --candidate-variant <name> [--adjudicated-at <YYYY-MM-DD>])
         [--release <semver>] [--root <dir>] [--write]

Without --write the proposed approvedCorpus is printed and nothing is changed.`;

const options = parseArgs(process.argv.slice(2));
if (options['--help']) {
  console.log(USAGE);
  process.exit(0);
}

const ROOT = resolve(options['--root'] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const approvedFor = options['--approved-for']?.trim();
if (!approvedFor) fail('--approved-for <text> is required');
const pending = options['--benchmark-pending'];
const benchmarkPath = options['--benchmark'];
if ((pending === undefined) === (benchmarkPath === undefined)) fail('pass exactly one of --benchmark-pending <reason> or --benchmark <discovery-summary.json>');
if (pending !== undefined && !pending.trim()) fail('--benchmark-pending needs a non-empty reason');
for (const flag of ['--baseline-variant', '--candidate-variant', '--adjudicated-at']) {
  if (pending !== undefined && options[flag] !== undefined) fail(`${flag} applies only to --benchmark`);
}

const pluginVersion = readArgusPluginVersion(ROOT);
const releaseVersion = options['--release'] ?? pluginVersion;
if (!SEMVER.test(releaseVersion)) fail(`--release must be a semantic version, found ${JSON.stringify(releaseVersion)}`);

const budgetPath = join(ROOT, BUDGET_FILE);
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
if (budget.schemaVersion !== 2) fail(`${BUDGET_FILE} must be schemaVersion 2, found ${budget.schemaVersion}`);

const corpus = computePromptCorpus(ROOT);
const benchmark = pending !== undefined
  ? { status: 'pending', reason: pending.trim() }
  : adjudicatedBenchmark(benchmarkPath, corpus.sha256, budget.nonRegression);

const approvedCorpus = {
  sha256: corpus.sha256,
  words: corpus.words,
  effectiveWords: corpus.effectiveWords,
  codexEstimatedTokens: corpus.codexEstimatedTokens,
  agents: corpus.agents,
  profiles: corpus.profiles,
  releaseVersion,
  approvedFor,
  benchmark,
};

if (benchmark.status === 'pending' && releaseVersion !== pluginVersion) {
  console.error(`NOTE  a pending approval for ${releaseVersion} fails the prompt gate while Argus is ${pluginVersion}`);
}
if (!options['--write']) {
  console.log(JSON.stringify(approvedCorpus, null, 2));
  process.exit(0);
}
budget.approvedCorpus = approvedCorpus;
writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
console.log(`WROTE  ${BUDGET_FILE}: approvedCorpus ${corpus.sha256.slice(0, 12)} for ${releaseVersion}, benchmark ${benchmark.status}`);

function adjudicatedBenchmark(path, currentSha256, nonRegression) {
  const baselineVariant = options['--baseline-variant'];
  const candidateVariant = options['--candidate-variant'];
  if (!baselineVariant || !candidateVariant) fail('--benchmark requires --baseline-variant <name> and --candidate-variant <name>');
  if (baselineVariant === candidateVariant) fail('--baseline-variant and --candidate-variant must name different variants');
  if (!nonRegression) fail(`${BUDGET_FILE} declares no nonRegression tolerances`);

  const bytes = readFileSync(path);
  let summary;
  try {
    summary = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${path} is not JSON: ${error.message}`);
  }
  if (summary?.schema !== SUMMARY_SCHEMA) {
    const legacy = Array.isArray(summary?.comparison) ? '; the pre-5.0 comparison shape is no longer read' : '';
    fail(`${path} is not an ${SUMMARY_SCHEMA} document written by scripts/eval/discovery/adjudicate.mjs${legacy}`);
  }
  const schemaErrors = validateEval('discovery-summary', summary);
  if (schemaErrors.length > 0) fail(`${path} violates ${SUMMARY_SCHEMA}: ${formatSchemaErrors(schemaErrors)}`);
  if (summary.status !== 'scored') fail(`discovery summary status must be "scored", found ${JSON.stringify(summary.status)}; provisional and unscored comparisons cannot approve a corpus`);
  if (summary.protocol.testMode) fail('the discovery summary is a testMode comparison; a stub-adapter run cannot approve a corpus');
  const baselineRow = summaryVariant(summary, baselineVariant);
  const candidateRow = summaryVariant(summary, candidateVariant);
  for (const row of [baselineRow, candidateRow]) {
    if (!/^[0-9a-f]{40}$/.test(row.revision ?? '')) fail(`variant ${row.name}: revision must be a full 40-hex commit, found ${JSON.stringify(row.revision)}`);
    if (spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${row.revision}^{commit}`]).status !== 0) {
      fail(`variant ${row.name}: revision ${row.revision} is not a commit in ${ROOT}`);
    }
  }

  const diff = spawnSync('git', ['-C', ROOT, 'diff', '--quiet', candidateRow.revision, '--', AGENTS_DIR, SHARED_SKILLS_DIR], { encoding: 'utf8' });
  if (diff.status === 1) fail(`${AGENTS_DIR} or ${SHARED_SKILLS_DIR} differ from candidate revision ${candidateRow.revision}; approve only the corpus that was benchmarked`);
  if (diff.status !== 0) fail(`git diff against candidate revision ${candidateRow.revision} failed: ${(diff.stderr || diff.error?.message || '').trim()}`);

  const candidateSha256 = corpusSha256AtRevision(candidateRow.revision);
  if (candidateSha256 !== currentSha256) {
    fail(`candidate revision ${candidateRow.revision} hashes to ${candidateSha256}, but the working-tree corpus is ${currentSha256}`);
  }
  const baselineSha256 = corpusSha256AtRevision(baselineRow.revision);
  const modes = summary.protocol.modes.map((mode) => ({
    mode,
    baseline: { revision: baselineRow.revision, corpusSha256: baselineSha256, ...modeFigures(baselineRow, mode) },
    candidate: { revision: candidateRow.revision, corpusSha256: candidateSha256, ...modeFigures(candidateRow, mode) },
  }));
  for (const { mode, baseline, candidate } of modes) {
    const errors = evaluateNonRegression({ baseline, candidate }, nonRegression);
    if (errors.length > 0) fail(`refusing a regressed approval in mode ${mode}: ${errors.join('; ')}`);
  }
  const evidence = {
    status: 'non-regressed',
    comparisonSha256: sha256(bytes),
    adjudicatedAt: adjudicationDate(summary.createdAt),
    baseline: weakestModeEvidence(modes, 'baseline'),
    candidate: weakestModeEvidence(modes, 'candidate'),
  };
  const errors = evaluateNonRegression(evidence, nonRegression);
  if (errors.length > 0) fail(`refusing a regressed approval: ${errors.join('; ')}`);
  return evidence;
}

function summaryVariant(summary, name) {
  const matches = summary.variants.filter((variant) => variant.name === name);
  if (matches.length !== 1) fail(`discovery summary must contain exactly one variant named ${JSON.stringify(name)}, found ${matches.length}`);
  return matches[0];
}

// One mode's figures in the benchmark-evidence vocabulary: recall is averaged over the scored
// faulty runs, so those are the repeats; pooled precision is the precision.
function modeFigures(variant, mode) {
  const aggregate = variant.perMode?.[mode];
  if (!aggregate) fail(`variant ${variant.name}: the discovery summary has no mode ${mode} aggregate`);
  for (const field of ['meanRecall', 'pooledPrecision']) {
    if (typeof aggregate[field] !== 'number') {
      fail(`variant ${variant.name} mode ${mode}: ${field} is ${JSON.stringify(aggregate[field])}; approval needs scored faulty runs with reported findings`);
    }
  }
  return {
    runs: aggregate.faultyRuns,
    meanRecall: aggregate.meanRecall,
    meanCriticalRecall: aggregate.meanCriticalRecall,
    meanPrecision: aggregate.pooledPrecision,
  };
}

// The per-metric minimum across modes. Critical recall is taken over the same modes on both
// sides (those where both have one), so a pass in every mode implies a pass of the minima.
function weakestModeEvidence(modes, side) {
  const records = modes.map((entry) => entry[side]);
  const critical = modes
    .filter((entry) => entry.baseline.meanCriticalRecall !== null && entry.candidate.meanCriticalRecall !== null)
    .map((entry) => entry[side].meanCriticalRecall);
  return {
    revision: records[0].revision,
    corpusSha256: records[0].corpusSha256,
    runs: Math.min(...records.map((record) => record.runs)),
    meanRecall: Math.min(...records.map((record) => record.meanRecall)),
    meanCriticalRecall: critical.length > 0 ? Math.min(...critical) : null,
    meanPrecision: Math.min(...records.map((record) => record.meanPrecision)),
  };
}

// Same file list and encoding as computePromptCorpus, read from a commit instead of the
// working tree: the agent files present at that revision and the doctrine profiles its
// capability matrix declared.
function corpusSha256AtRevision(revision) {
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const show = (path) => git('show', `${revision}:./${path}`);
  let matrix;
  try {
    matrix = JSON.parse(show(CAPABILITY_MATRIX));
  } catch (error) {
    fail(`revision ${revision} has no readable ${CAPABILITY_MATRIX}; its doctrine profiles cannot be hashed: ${firstLine(error)}`);
  }
  const agents = new Map();
  for (const path of git('ls-tree', '--name-only', revision, `${AGENTS_DIR}/`).split('\n').filter(Boolean)) {
    const file = path.slice(AGENTS_DIR.length + 1);
    if (file.endsWith('.md') && !file.includes('/')) agents.set(file, show(path));
  }
  if (agents.size === 0) fail(`revision ${revision} has no ${AGENTS_DIR}/*.md prompts`);
  const profiles = new Map();
  for (const name of doctrineProfileNames(matrix)) {
    try {
      profiles.set(name, show(`${SHARED_SKILLS_DIR}/${name}/SKILL.md`));
    } catch (error) {
      fail(`revision ${revision} has no ${SHARED_SKILLS_DIR}/${name}/SKILL.md: ${firstLine(error)}`);
    }
  }
  return hashPromptCorpus({ agents, profiles });
}

// The adjudication date defaults to the day adjudicate.mjs wrote the summary.
function adjudicationDate(createdAt) {
  const value = options['--adjudicated-at'] ?? String(createdAt).slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`--adjudicated-at must be a calendar date YYYY-MM-DD, found ${JSON.stringify(value)}`);
  }
  return value;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) fail(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    if (Object.hasOwn(parsed, flag)) fail(`${flag} was given more than once`);
    if (BOOLEAN_FLAGS.has(flag)) {
      parsed[flag] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value\n${USAGE}`);
    parsed[flag] = value;
    index += 1;
  }
  return parsed;
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n')[0];
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
