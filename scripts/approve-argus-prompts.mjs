#!/usr/bin/env node
// Maintainer tool: re-stamp argus/prompt-budgets.json approvedCorpus for the current prompt
// corpus, either as a pending approval bound to one Argus release or with adjudicated
// discovery evidence (scripts/eval/discovery/adjudicate.mjs) that the corpus did not regress.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const COMPARISON_FIELDS = ['revision', 'runs', 'meanRecall', 'meanCriticalRecall', 'meanPrecision'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const USAGE = `usage: approve-argus-prompts.mjs --approved-for <text>
         (--benchmark-pending <reason> | --benchmark <adjudication.json> --baseline-variant <name> --candidate-variant <name> [--adjudicated-at <YYYY-MM-DD>])
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
if ((pending === undefined) === (benchmarkPath === undefined)) fail('pass exactly one of --benchmark-pending <reason> or --benchmark <adjudication.json>');
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
  let adjudication;
  try {
    adjudication = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${path} is not JSON: ${error.message}`);
  }
  if (adjudication?.status !== 'scored') fail(`adjudication status must be "scored", found ${JSON.stringify(adjudication?.status)}; unscored comparisons cannot approve a corpus`);
  if (!Array.isArray(adjudication.comparison)) fail('adjudication has no comparison rows');
  const baselineRow = comparisonRow(adjudication.comparison, baselineVariant);
  const candidateRow = comparisonRow(adjudication.comparison, candidateVariant);
  for (const row of [baselineRow, candidateRow]) {
    if (!/^[0-9a-f]{40}$/.test(row.revision ?? '')) fail(`variant ${row.variant}: revision must be a full 40-hex commit, found ${JSON.stringify(row.revision)}`);
    if (spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${row.revision}^{commit}`]).status !== 0) {
      fail(`variant ${row.variant}: revision ${row.revision} is not a commit in ${ROOT}`);
    }
  }

  const diff = spawnSync('git', ['-C', ROOT, 'diff', '--quiet', candidateRow.revision, '--', AGENTS_DIR, SHARED_SKILLS_DIR], { encoding: 'utf8' });
  if (diff.status === 1) fail(`${AGENTS_DIR} or ${SHARED_SKILLS_DIR} differ from candidate revision ${candidateRow.revision}; approve only the corpus that was benchmarked`);
  if (diff.status !== 0) fail(`git diff against candidate revision ${candidateRow.revision} failed: ${(diff.stderr || diff.error?.message || '').trim()}`);

  const candidateSha256 = corpusSha256AtRevision(candidateRow.revision);
  if (candidateSha256 !== currentSha256) {
    fail(`candidate revision ${candidateRow.revision} hashes to ${candidateSha256}, but the working-tree corpus is ${currentSha256}`);
  }
  const evidence = {
    status: 'non-regressed',
    comparisonSha256: sha256(bytes),
    adjudicatedAt: adjudicationDate(path),
    baseline: comparisonEvidence(baselineRow, corpusSha256AtRevision(baselineRow.revision)),
    candidate: comparisonEvidence(candidateRow, candidateSha256),
  };
  const errors = evaluateNonRegression(evidence, nonRegression);
  if (errors.length > 0) fail(`refusing a regressed approval: ${errors.join('; ')}`);
  return evidence;
}

function comparisonRow(rows, variant) {
  const matches = rows.filter((row) => row?.variant === variant);
  if (matches.length !== 1) fail(`adjudication must contain exactly one comparison row for variant ${JSON.stringify(variant)}, found ${matches.length}`);
  const row = matches[0];
  for (const field of COMPARISON_FIELDS) {
    if (!Object.hasOwn(row, field)) fail(`variant ${variant}: comparison row has no ${field}`);
  }
  return row;
}

function comparisonEvidence(row, corpusSha256) {
  return {
    revision: row.revision,
    corpusSha256,
    runs: row.runs,
    meanRecall: row.meanRecall,
    meanCriticalRecall: row.meanCriticalRecall,
    meanPrecision: row.meanPrecision,
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

function adjudicationDate(path) {
  const value = options['--adjudicated-at'] ?? statSync(path).mtime.toISOString().slice(0, 10);
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
