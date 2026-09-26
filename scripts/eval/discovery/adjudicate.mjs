#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { scoreRun } from './score.mjs';
import { formatSchemaErrors, validateEval } from './lib/schemas.mjs';
const [runPath, verdictPath] = process.argv.slice(2);
if (!runPath || !verdictPath) throw new Error('private-runs.json and verdicts.json required');
const privateRuns = JSON.parse(readFileSync(runPath));
const schemaErrors = validateEval('private-runs', privateRuns);
if (schemaErrors.length) throw new Error(`private runs violate argus-eval/private-runs@2: ${formatSchemaErrors(schemaErrors)}`);
const { runs, config } = privateRuns;
const verdicts = JSON.parse(readFileSync(verdictPath));
if (!Array.isArray(verdicts) || verdicts.length !== runs.length) throw new Error('one verdict array per recorded run required');
// Findings are the evaluator-extracted confirmed ledger rows; timed-out runs stay scorable.
const results = runs.map((run, index) => {
  if (run.status === 'invalid-run' || run.status === 'contaminated') return { variant: run.variant, runId: run.runId, status: run.status };
  for (const verdict of verdicts[index]) {
    const path = resolve(run.artifactRoot, verdict.evidenceRef ?? '');
    const root = realpathSync(run.artifactRoot);
    if (!existsSync(path)) throw new Error('adjudication evidence missing');
    const inside = relative(root, realpathSync(path));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('adjudication evidence escapes run artifacts');
  }
  const usage = run.adapter.result?.usage;
  if (!Number.isFinite(usage?.totalTokens) || !Number.isFinite(usage?.costUsd)) {
    return { variant: run.variant, runId: run.runId, status: 'unscored', reason: 'Measured token and cost usage unavailable' };
  }
  return { variant: run.variant, runId: run.runId, repeat: run.repeat, mode: run.mode, build: run.build, timedOut: run.timedOut,
    ...scoreRun({ truth: run.truth, findings: run.extraction.findings, verdicts: verdicts[index], elapsedMs: run.elapsedMs,
      tokens: usage.totalTokens, cost: usage.costUsd }) };
});
const complete = results.every(result => result.status === 'scored');
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const comparison = complete ? config.variants.map(variant => {
  const group = results.filter(run => run.variant === variant.name);
  return { variant: variant.name, revision: variant.revision, runs: group.length,
    meanRecall: mean(group.map(run => run.recall).filter(value => value !== null)),
    meanCriticalRecall: mean(group.map(run => run.criticalRecall).filter(value => value !== null)),
    meanPrecision: mean(group.map(run => run.precision).filter(value => value !== null)),
    meanIndependentReproduction: mean(group.map(run => run.independentReproduction).filter(value => value !== null)),
    totalCost: group.reduce((sum, run) => sum + run.cost, 0), totalTokens: group.reduce((sum, run) => sum + run.tokens, 0),
    meanFirstConfirmedMs: mean(group.map(run => run.firstConfirmedMs).filter(value => value !== null)) };
}) : null;
console.log(JSON.stringify({ status: complete ? 'scored' : 'UNSCORED', results, comparison }, null, 2));
if (!complete) process.exitCode = 20;
