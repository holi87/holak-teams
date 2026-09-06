#!/usr/bin/env node
import assert from 'node:assert/strict';
import { startApplication } from './apps.mjs';
import { scoreRun } from './score.mjs';
let executions = 0;
for (const seed of [1, 19]) for (const family of ['orders', 'accounts', 'workflow']) for (const faulty of [false, true]) {
  const app = await startApplication({ family, faulty, seed });
  try {
    const contract = await (await fetch(`${app.url}/contract`)).json();
    const post = (path, body) => fetch(app.url + path, { method: 'POST', body: JSON.stringify(body) });
    let detected;
    if (family === 'orders') {
      // A valid request at equality and two intentional creates are not bugs.
      assert.equal((await post('/orders', { quantity: contract.quantityLimit })).status, 201);
      assert.equal((await post('/orders', { quantity: 1 })).status, 201);
      assert.equal((await post('/orders', { quantity: 1 })).status, 201);
      assert.equal((await post('/orders', { quantity: 0 })).status, 422);
      assert.equal((await (await fetch(`${app.url}/state`)).json()).count, 3);
      detected = (await post('/orders', { quantity: contract.quantityLimit + 1 })).status === 201;
      const claims = await Promise.all([post('/claim', {}), post('/claim', {})]);
      assert.equal(claims.filter(response => response.status === 201).length, faulty ? 2 : 1);
      assert.equal((await (await fetch(`${app.url}/state`)).json()).claims, faulty ? 2 : 1);
    } else if (family === 'accounts') {
      const path = `/objects/${contract.objectId}`;
      assert.equal((await fetch(app.url + path, { headers: { 'x-actor': 'alice' } })).status, 200);
      assert.equal((await fetch(app.url + path)).status, 401);
      assert.equal((await (await fetch(`${app.url}/profile?email=User@Example.test`)).json()).email, 'User@Example.test');
      detected = (await fetch(app.url + path, { headers: { 'x-actor': 'bob' } })).status === 200;
    } else {
      assert.equal((await post('/transition', { to: 'cancelled' })).status, 200);
      detected = (await post('/transition', { to: 'committed' })).status === 200;
      assert.equal((await (await fetch(`${app.url}/state`)).json()).status, faulty ? 'committed' : 'cancelled');
    }
    assert.equal(detected, faulty); executions++;
  } finally { await app.close(); }
}
const input = { truth: [{ id: 'hidden', severity: 'Critical' }], findings: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }],
  verdicts: [{ findingId: 'F1', outcome: 'real', seedId: 'hidden', reason: 'Criterion independently reproduced', evidenceRef: 'probe-1.txt', independentlyReproduced: true, confirmedAtMs: 30 },
    { findingId: 'F2', outcome: 'real', reason: 'Legitimate unseeded defect', evidenceRef: 'probe-2.txt', independentlyReproduced: false, confirmedAtMs: 50 },
    { findingId: 'F3', outcome: 'false-positive', reason: 'Contract allows separate creates', evidenceRef: 'probe-3.txt', independentlyReproduced: false }], elapsedMs: 100, tokens: 20, cost: 0.01 };
const result = scoreRun(input); assert.equal(result.recall, 1); assert.equal(result.precision, 2 / 3); assert.equal(result.independentReproduction, 0.5); assert.equal(result.firstConfirmedMs, 30);
assert.equal(scoreRun({ ...input, verdicts: [] }).status, 'unscored');
assert.throws(() => scoreRun({ ...input, verdicts: [...input.verdicts, input.verdicts[0]] }));
assert.throws(() => scoreRun({ ...input, tokens: null }));
console.log(`PASS  ${executions} live HTTP fixture executions, correct lookalikes, seeded defects, and evidence-adjudicated metrics. Scripted harness validation only; no Argus model score claimed.`);

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
  assert.equal(recorded.length, 24); assert(recorded.every(run => run.status === 'awaiting-adjudication'));
  const verdictFile = join(work, 'verdicts.json');writeFileSync(verdictFile, JSON.stringify(recorded.map(() => [])));
  const adjudicated = spawnSync(process.execPath, [fileURLToPath(new URL('./adjudicate.mjs', import.meta.url)), join(output, 'private-runs.json'), verdictFile], { encoding:'utf8', timeout:10000 });
  assert.equal(adjudicated.status, 0, adjudicated.stderr);
  const comparison = JSON.parse(adjudicated.stdout);assert.equal(comparison.comparison.length, 2);
  assert(comparison.comparison.every(variant => variant.meanRecall === 0));
  console.log('PASS  24 paired comparison protocol runs; empty stub earns zero recall, not fabricated discovery credit');
} finally {
  for (const run of recorded) rmSync(run.work, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
