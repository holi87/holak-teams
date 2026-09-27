#!/usr/bin/env node
// Usage: node scripts/eval/discovery/adjudicate.mjs --runs <private-runs.json> --verdicts <final-verdicts.json>
//          --output <summary.json> [--isolation same-user|separate-user] [--exclude-contaminated]
//
// Scores a comparison from its private runs (argus-eval/private-runs@2) and the final verdicts
// that spotcheck.mjs finalize wrote for exactly those runs (argus-eval/final-verdicts@1, bound by
// runsSha256). Every verdict evidence path must still resolve inside its run's artifact root or
// the physical <runsDir>/repro/ directory. The output, argus-eval/discovery-summary@1, holds the
// per-run results, per-variant and per-mode aggregates, the protocol and the source digests: IDs
// and counts only, no report text, verdict reasons, or evidence paths. It is written even when
// the comparison is UNSCORED, and an existing output is never replaced.
//
// Exit codes: 0 scored; 23 scored-provisional (the final verdicts are a provisional snapshot);
// 20 UNSCORED (an invalid run, a confirmed finding without a final verdict, a contaminated run
// without --exclude-contaminated, or a variant whose runs report different plugin digests);
// 1 invalid input (including judge-unreliable verdicts, which must never feed a score); 2 usage.
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { aggregateRuns, scoreRun } from './score.mjs';
import { summarizeReplay } from './lib/replay.mjs';
import { assertEval } from './lib/schemas.mjs';

const USAGE = 'usage: node scripts/eval/discovery/adjudicate.mjs --runs <private-runs.json> --verdicts <final-verdicts.json> --output <summary.json> [--isolation same-user|separate-user] [--exclude-contaminated]';
const VALUES = Object.freeze({ '--runs': 'runs', '--verdicts': 'verdicts', '--output': 'output', '--isolation': 'isolation' });
const FLAGS = Object.freeze({ '--exclude-contaminated': 'excludeContaminated' });
const REQUIRED = Object.freeze(['runs', 'verdicts', 'output']);
const ISOLATION = Object.freeze(['same-user', 'separate-user']);
const SCORABLE = new Set(['awaiting-adjudication', 'timed-out']);
const BLOCKING = new Set(['invalid-run', 'contaminated-run', 'missing-verdict', 'mixed-plugin-digest']);
const EXIT = Object.freeze({ scored: 0, 'scored-provisional': 23, UNSCORED: 20 });
const FILE_MODE = 0o600;
const REPRO_DIR = 'repro';

class UsageError extends Error {}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const distinct = values => [...new Set(values)];

function parseArguments(argv) {
  const options = { excludeContaminated: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new UsageError(`${flag} was given twice`);
    seen.add(flag);
    if (Object.hasOwn(FLAGS, flag)) {
      options[FLAGS[flag]] = true;
      continue;
    }
    if (!Object.hasOwn(VALUES, flag)) throw new UsageError(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    options[VALUES[flag]] = value;
    index += 1;
  }
  const missing = REQUIRED.filter(name => options[name] === undefined);
  if (missing.length) throw new UsageError(`missing ${missing.map(name => `--${name}`).join(', ')}`);
  if (options.isolation !== undefined && !ISOLATION.includes(options.isolation)) throw new UsageError(`--isolation must be ${ISOLATION.join(' or ')}`);
  for (const name of REQUIRED) options[name] = resolve(options[name]);
  return options;
}

// A schema-valid evaluator document, read from a regular file, with the SHA-256 of its exact bytes.
function readDocument(path, label, schemaName) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} ${path} ${error.code === 'ENOENT' ? 'does not exist' : 'is not readable'}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} ${path} must be a regular file`);
  const bytes = readFileSync(path);
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} ${path} is not valid JSON: ${error.message}`);
  }
  assertEval(schemaName, document, `${label} ${path}`);
  return { document, sha256: sha256(bytes) };
}

// The physical output path; an existing output is never replaced.
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

const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// A verdict's evidence must still exist and resolve, after following symbolic links, to a regular
// file inside the run's artifact root or the physical <runsDir>/repro/ directory (the reviewers'
// reproduction records), the same roots spotcheck.mjs accepted.
function checkEvidence(reference, run, runsDir, label) {
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
    throw new Error(`${label}: adjudication evidence ${reference} is missing`);
  }
  if (!roots.some(root => isInside(root, target))) throw new Error(`${label}: adjudication evidence ${reference} escapes the run's artifact root and ${repro}${sep}`);
  if (!statSync(target).isFile()) throw new Error(`${label}: adjudication evidence ${reference} is not a regular file`);
}

// One seed per repeat, as the runs recorded it (config.seeds is null when every repeat drew a
// random seed), so two summaries can be compared seed for seed.
function protocolSeeds(config, runs) {
  return Array.from({ length: config.repeats }, (_, repeat) => {
    const seeds = distinct(runs.filter(run => run.repeat === repeat).map(run => run.seed));
    if (seeds.length !== 1) throw new Error(`private runs record ${seeds.length ? `several seeds (${seeds.join(', ')})` : 'no run'} for repeat ${repeat}`);
    if (config.seeds !== null && config.seeds[repeat] !== seeds[0]) throw new Error(`repeat ${repeat} ran with seed ${seeds[0]}, but the configuration pins ${config.seeds[repeat]}`);
    return seeds[0];
  });
}

const reason = (code, { variant = null, runId = null, findingIds = [] } = {}) => ({ code, variant, runId, findingIds });

function adjudicate(options) {
  const runs = readDocument(options.runs, 'private runs', 'private-runs');
  const verdicts = readDocument(options.verdicts, 'final verdicts', 'final-verdicts');
  const outputPath = outputTarget(options.output);
  const final = verdicts.document;
  if (final.runsSha256 !== runs.sha256) throw new Error(`final verdicts ${options.verdicts} were not produced from private runs ${options.runs} (runsSha256 mismatch)`);
  if (final.status === 'judge-unreliable') {
    throw new Error(`final verdicts ${options.verdicts} are judge-unreliable and must not feed a score; run \`spotcheck.mjs sample --all\`, review every verdict, and finalize again`);
  }  const { config, corpus, runs: privateRuns } = runs.document;
  if (final.runs.length !== privateRuns.length || final.runs.some((run, index) => run.runId !== privateRuns[index].runId)) {
    throw new Error('final verdicts do not list the private runs in recorded order');
  }
  const variantNames = new Set(config.variants.map(variant => variant.name));
  const unknown = privateRuns.find(run => !variantNames.has(run.variant) || !config.modes.includes(run.mode) || !config.builds.includes(run.build));
  if (unknown) throw new Error(`private run ${unknown.runId} is outside the recorded configuration (variant, mode, or build)`);
  const seeds = protocolSeeds(config, privateRuns);
  const runsDir = dirname(realpathSync(options.runs));

  const reasons = [];
  const results = privateRuns.map((run, index) => {
    const runVerdicts = final.runs[index].verdicts;
    const base = { runId: run.runId, variant: run.variant, revision: run.revision, repeat: run.repeat, seed: run.seed, mode: run.mode, build: run.build,
      status: run.status, pluginDigest: run.adapter.result?.subject?.pluginDigest ?? null };
    if (!SCORABLE.has(run.status)) {
      if (runVerdicts.length) throw new Error(`private run ${run.runId} is ${run.status}, but the final verdicts judge its findings`);
      if (run.status === 'invalid-run') reasons.push(reason('invalid-run', { variant: run.variant, runId: run.runId }));
      else if (!options.excludeContaminated) reasons.push(reason('contaminated-run', { variant: run.variant, runId: run.runId }));
      return { ...base, scoring: 'excluded', metrics: null };
    }
    for (const verdict of runVerdicts) {
      if (verdict.evidenceRef !== null) checkEvidence(verdict.evidenceRef, run, runsDir, `${run.runId} ${verdict.findingId}`);
    }
    const scored = scoreRun(run, runVerdicts, summarizeReplay(run.replay));
    if (scored.status !== 'scored') {
      reasons.push(reason(scored.reason, { variant: run.variant, runId: run.runId, findingIds: scored.missingVerdicts }));
      return { ...base, scoring: 'unscored', metrics: null };
    }
    return { ...base, scoring: 'scored', metrics: scored.metrics };
  });

  // Every run of a variant with a valid adapter result must report the same plugin: a run that
  // reports no digest cannot be shown to match one that does, so null counts as its own value.
  const subjects = new Map();
  for (const variant of config.variants) {
    const reported = privateRuns.filter(run => run.variant === variant.name && run.adapter.resultState === 'valid');
    const digests = distinct(reported.map(run => run.adapter.result?.subject?.pluginDigest ?? null));
    const versions = distinct(reported.map(run => run.adapter.result?.subject?.pluginVersion ?? null));
    if (digests.length > 1) reasons.push(reason('mixed-plugin-digest', { variant: variant.name }));
    subjects.set(variant.name, { pluginVersion: versions.length === 1 ? versions[0] : null, pluginDigest: digests.length === 1 ? digests[0] : null });
  }
  if (final.status === 'provisional') reasons.push(reason('provisional-verdicts'));
  const status = reasons.some(entry => BLOCKING.has(entry.code)) ? 'UNSCORED' : final.status === 'provisional' ? 'scored-provisional' : 'scored';

  const variants = config.variants.map(variant => ({
    name: variant.name,
    revision: variant.revision,
    subject: subjects.get(variant.name),
    perMode: status === 'UNSCORED' ? null : Object.fromEntries(config.modes.map(mode => [mode,
      aggregateRuns(results.filter(result => result.variant === variant.name && result.mode === mode), { mode, judgeReliability: final.reliability })])),
  }));
  const { model, effort, passes, systemPromptSha256, claudeVersion, includeSuspected } = final.judge;
  const { all, rate, minimum, items, reviewed, pending } = final.spotCheck;
  const summary = {
    schema: 'argus-eval/discovery-summary@1',
    status,
    reasons,
    createdAt: new Date().toISOString(),
    corpus: { version: corpus.version, digest: corpus.digest },
    protocol: {
      modes: config.modes, builds: config.builds, repeats: config.repeats, seeds, secondsByMode: config.secondsByMode, tokens: config.tokens,
      replay: config.replay, testMode: config.testMode,
      judge: { model, effort, passes, systemPromptSha256, claudeVersion, includeSuspected },
      spotCheck: { all, rate, minimum, items, reviewed, pending },
    },
    variants,
    runs: results,
    excludedRuns: options.excludeContaminated ? results.filter(result => result.status === 'contaminated').map(result => result.runId) : [],
    isolation: { declared: options.isolation ?? null },
    sources: { runsSha256: runs.sha256, verdictsSha256: verdicts.sha256, judgeSha256: final.judgeSha256, sheetSha256: final.sheetSha256 },
  };
  assertEval('discovery-summary', summary, 'discovery summary');
  writeExclusive(outputPath, summary);
  console.log(JSON.stringify({
    status,
    reasons: distinct(reasons.map(entry => entry.code)),
    runs: results.length,
    scoredRuns: results.filter(result => result.scoring === 'scored').length,
    excludedRuns: summary.excludedRuns.length,
    output: outputPath,
  }));
  if (status === 'UNSCORED') {
    const detail = reasons.filter(entry => BLOCKING.has(entry.code))
      .map(entry => [entry.code, entry.variant, entry.runId, entry.findingIds.join(' ')].filter(Boolean).join(' '));
    console.error(`adjudicate: UNSCORED: ${detail.join('; ')}`);
  }
  return EXIT[status];
}

try {
  process.exitCode = adjudicate(parseArguments(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`adjudicate: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`adjudicate: ${error.message}`);
    process.exitCode = 1;
  }
}
