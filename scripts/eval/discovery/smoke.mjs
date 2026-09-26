#!/usr/bin/env node
import assert from 'node:assert/strict';
import { scoreRun } from './score.mjs';
import { seedIds } from './corpus/index.mjs';
// Live corpus fixtures (seeded defects, correct lookalikes, seed independence) are covered by smoke-corpus.mjs.
const input = { truth: [{ id: 'hidden', severity: 'Critical' }], findings: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }],
  verdicts: [{ findingId: 'F1', outcome: 'real', seedId: 'hidden', reason: 'Criterion independently reproduced', evidenceRef: 'probe-1.txt', independentlyReproduced: true, confirmedAtMs: 30 },
    { findingId: 'F2', outcome: 'real', reason: 'Legitimate unseeded defect', evidenceRef: 'probe-2.txt', independentlyReproduced: false, confirmedAtMs: 50 },
    { findingId: 'F3', outcome: 'false-positive', reason: 'Contract allows separate creates', evidenceRef: 'probe-3.txt', independentlyReproduced: false }], elapsedMs: 100, tokens: 20, cost: 0.01 };
const result = scoreRun(input); assert.equal(result.recall, 1); assert.equal(result.precision, 2 / 3); assert.equal(result.independentReproduction, 0.5); assert.equal(result.firstConfirmedMs, 30);
assert.equal(scoreRun({ ...input, verdicts: [] }).status, 'unscored');
assert.throws(() => scoreRun({ ...input, verdicts: [...input.verdicts, input.verdicts[0]] }));
assert.throws(() => scoreRun({ ...input, tokens: null }));
console.log('PASS  evidence-adjudicated metrics: false positives, unseeded findings, missing verdicts, and reproduction. Scripted harness validation only; no Argus model score claimed.');

// Exercise the comparison CLI protocol without pretending this stub is an agent.
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { spawnSync } = await import('node:child_process');
const work = mkdtempSync(join(tmpdir(), 'argus-eval-protocol-'));
let recorded = [];
try {
  const adapter = join(work, 'protocol-stub.mjs');
  writeFileSync(adapter, `import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(process.argv[2]));
if ('truth' in request || 'seed' in request || 'faulty' in request) throw new Error('private truth leaked');
const response=await fetch(request.contractUrl);if(!response.ok)throw new Error('application unreachable');
writeFileSync(request.resultPath,JSON.stringify({findings:[],tokens:0,cost:0}));`);
  const config = join(work, 'config.json'), output = join(work, 'output');
  writeFileSync(config, JSON.stringify({ variants: ['baseline', 'candidate'].map(name => ({ name, revision: '0'.repeat(40), command: [process.execPath, adapter] })), repeats: 2, seconds: 10, tokens: 10 }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), config, output], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  recorded = JSON.parse(readFileSync(join(output, 'private-runs.json'))).runs;
  assert.equal(recorded.length, 8); assert(recorded.every(run => run.status === 'awaiting-adjudication'));
  assert(recorded.every(run => run.family === 'suite' && run.truth.length === (run.faulty ? seedIds.length : 0)), 'faulty builds carry every seed as private truth; corrected builds none');
  const verdictFile = join(work, 'verdicts.json');writeFileSync(verdictFile, JSON.stringify(recorded.map(() => [])));
  const adjudicated = spawnSync(process.execPath, [fileURLToPath(new URL('./adjudicate.mjs', import.meta.url)), join(output, 'private-runs.json'), verdictFile], { encoding:'utf8', timeout:10000 });
  assert.equal(adjudicated.status, 0, adjudicated.stderr);
  const comparison = JSON.parse(adjudicated.stdout);assert.equal(comparison.comparison.length, 2);
  assert(comparison.comparison.every(variant => variant.meanRecall === 0));
  console.log('PASS  8 paired comparison protocol runs; empty stub earns zero recall, not fabricated discovery credit');
} finally {
  for (const run of recorded) rmSync(run.work, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
