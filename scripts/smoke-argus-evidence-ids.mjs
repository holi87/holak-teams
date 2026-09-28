#!/usr/bin/env node
// Evidence IDs remain unique across lanes and repeated immutable references cannot wedge closeout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateId, allocateWorker, createDefaultEngagement, deriveFinalSummaryFacts, getEngagementStatus,
  initializeEngagementState, mergeCanonical, validateEngagementManifest, writeFragment } from '../argus/runtime/engagement.mjs';
import { mergeCanonicalDocuments } from '../argus/runtime/contracts.mjs';
import { calculateCoverage } from '../argus/runtime/coverage.mjs';
import { derivePhasePlan } from '../argus/runtime/orchestration-plan.mjs';

const readRepo = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const digest = (content) => createHash('sha256').update(content).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'argus-evidence-ids-'));
const tests = { allocator: testAllocator, collision: testCollision, cumulative: testCumulativeMerge };
try {
  for (const [name, test] of Object.entries(tests)) {
    if (process.argv[2] && process.argv[2] !== name) continue;
    test();
    console.log(`PASS  evidence IDs: ${name}`);
  }
} finally { rmSync(work, { recursive: true, force: true }); }

function fixture(name) {
  const root = join(work, name);
  mkdirSync(join(root, 'reports'), { recursive: true });
  const selectedAgents = ['atalanta', 'hermes', 'kalchas', 'kleio', 'minos', 'odysseus'];
  const manifest = createDefaultEngagement({ template: readRepo('argus/policies/engagement.template.json'),
    target: root, targetRoot: root, artifactRoot: root, mode: 'B', engagementId: name, selectedAgents,
    phasePlan: derivePhasePlan(readRepo('argus/orchestration-plan.json'), readRepo('argus/capabilities/capability-matrix.json'),
      'B', selectedAgents, readRepo('argus/raci.json')) });
  assert.deepEqual(validateEngagementManifest(manifest), []);
  const { path: statePath } = initializeEngagementState(manifest);
  const tokens = {};
  for (const lane of ['odysseus', ...selectedAgents.filter((lane) => lane !== 'odysseus')]) {
    const sha = digest(`${name}:${lane}`);
    tokens[lane] = allocateWorker(manifest, lane, { controllerToken: tokens.odysseus,
      executionBinding: { modelDecisionId: `MDR-${sha.slice(0, 24)}`, modelDecisionIntegritySha256: sha,
        dispatchId: `${name}:${lane}`, attempt: 1, runtime: 'claude' } }).token;
  }
  const evidence = (references) => ({ $schema: 'argus/evidence-reference@3', schemaVersion: 3, engagementId: name, references });
  const fragment = (lane, id, references) => writeFragment(manifest, lane, tokens[lane], 'solution/evidence-reference.json', id, JSON.stringify(evidence(references)));
  const ref = (id, lane, source) => {
    const content = `Synthetic capture from ${lane}: ${source}\n`;
    writeFileSync(join(root, source), content);
    return { id, kind: 'text', mediaType: 'text/plain', source, collectedBy: lane, capturedAt: '2026-07-10T00:00:00.000Z',
      redaction: 'synthetic', sha256: digest(content), relatedBugIds: [], relatedSurfaceIds: [] };
  };
  return { root, manifest, tokens, statePath, evidence, fragment, ref };
}

function testAllocator() {
  const { manifest, tokens, statePath } = fixture('allocator');
  const id = (lane, identity, token = tokens[lane], kind = 'evidence') => allocateId(manifest, lane, token, kind, identity);
  assert.equal(id('atalanta', 'atalanta:reports/capture.txt'), 'EVD-0001');
  assert.equal(id('atalanta', 'atalanta:reports/capture.txt'), 'EVD-0001');
  assert.equal(id('hermes', 'hermes:reports/capture.txt'), 'EVD-0002');
  assert.equal(id('atalanta', 'atalanta:reports/next.txt'), 'EVD-0003');
  assert.throws(() => id('hermes', 'atalanta:reports/capture.txt'), /identity must start with hermes:/u);
  assert.throws(() => id('hermes', 'hermes:'), /non-empty source/u);
  assert.throws(() => id('hermes', 'hermes:bad-token', tokens.atalanta), /invalid or inactive lease/u);
  assert.throws(() => id('atlas', 'atlas:not-selected', tokens.atalanta), /not selected/u);
  assert.throws(() => id('hermes', 'bug', tokens.hermes, 'bug'), /owned by minos/u);
  assert.equal(id('minos', 'bug', tokens.minos, 'bug'), 'BUG-0001');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.allocations.hermes.status = 'released';
  writeFileSync(statePath, JSON.stringify(state));
  assert.throws(() => id('hermes', 'hermes:reports/capture.txt'), /invalid or inactive lease/u);
}

function testCollision() {
  const f = fixture('collision');
  const first = f.ref('EVD-0001', 'atalanta', 'reports/first.txt');
  const conflicting = f.ref('EVD-0001', 'hermes', 'reports/second.txt');
  const registered = f.fragment('atalanta', 'first-capture', [first]);
  const stateBefore = readFileSync(f.statePath, 'utf8');
  for (const lane of ['hermes', 'atalanta']) {
    assert.throws(() => f.fragment(lane, 'conflicting-capture', [conflicting]), (error) =>
      error.message.includes('EVD-0001') && error.message.includes(registered.path) &&
      error.message.includes('engagement id --kind evidence'), 'conflicting evidence must fail at write with allocation recovery');
    assert.equal(readFileSync(f.statePath, 'utf8'), stateBefore, 'a rejected collision mutated state');
    assert.equal(existsSync(join(f.root, registered.path.replace('first-capture--atalanta', `conflicting-capture--${lane}`))), false,
      'a rejected collision left an immutable fragment behind');
  }
  // No other mutable metadata, including a new bug link, may silently replace an immutable record.
  assert.throws(() => f.fragment('atalanta', 'changed-link', [{ ...first, relatedBugIds: ['BUG-0001'] }]), /EVD-0001/u);
  f.fragment('hermes', 'identical-replay', [structuredClone(first)]);
  mergeCanonical(f.manifest, 'kleio', f.tokens.kleio, 'solution/evidence-reference.json');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'solution/evidence-reference.json'), 'utf8')).references, [first]);
  assert.throws(() => mergeCanonicalDocuments('evidence-reference', [f.evidence([first]), f.evidence([conflicting])]), /duplicate evidence reference id: EVD-0001/u,
    'the lower-level merge must still refuse different records with one ID');
}

function testCumulativeMerge() {
  const f = fixture('cumulative');
  const first = f.ref('EVD-0001', 'atalanta', 'reports/first.txt');
  const second = f.ref('EVD-0002', 'atalanta', 'reports/second.txt');
  f.fragment('atalanta', 'first-capture', [first]);
  f.fragment('atalanta', 'cumulative-capture', [structuredClone(first), second]);
  const writeAndMerge = (lane, name, document) => {
    const path = `solution/${name}.json`;
    writeFragment(f.manifest, lane, f.tokens[lane], path, name, JSON.stringify(document));
    mergeCanonical(f.manifest, lane, f.tokens[lane], path);
    return JSON.parse(readFileSync(join(f.root, path), 'utf8'));
  };
  // Minos reconciles fragment evidence before Kleio publishes the canonical registry.
  const ledger = writeAndMerge('minos', 'bug-ledger', { $schema: 'argus/bug-ledger@2', schemaVersion: 2,
    engagementId: f.manifest.engagementId, bugs: [{ id: 'BUG-0001', origin: ['ATA-001'], title: 'Captured response differs from the expected status',
      severity: 'Minor', priority: 'P3', lane: 'atalanta', oracleId: 'ORC-API-001', status: 'suspected', wired: false, testId: null,
      evidenceIds: ['EVD-0001'], missingProof: { elements: ['oracle'], detail: 'The response contract must resolve the expected status.', owner: 'metis' } }] });
  assert.equal(ledger.bugs[0].status, 'suspected');
  mergeCanonical(f.manifest, 'kleio', f.tokens.kleio, 'solution/evidence-reference.json');
  const registryPath = join(f.root, 'solution/evidence-reference.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.deepEqual(registry.references, [first, second]);
  const bytes = readFileSync(registryPath, 'utf8');
  mergeCanonical(f.manifest, 'kleio', f.tokens.kleio, 'solution/evidence-reference.json');
  assert.equal(readFileSync(registryPath, 'utf8'), bytes, 'repeated merge must remain byte-stable');
  const inventory = readRepo('scripts/fixtures/argus-schemas/valid/surface-inventory.json');
  inventory.engagementId = f.manifest.engagementId;
  writeAndMerge('kalchas', 'surface-inventory', inventory);
  const observations = writeAndMerge('kleio', 'coverage-observations', { $schema: 'argus/coverage-observations@2', schemaVersion: 2,
    engagementId: f.manifest.engagementId, observations: [] });
  const coverage = calculateCoverage(inventory, observations, { evidence: registry, ledger, readArtifact: (source) => readFileSync(join(f.root, source)) });
  writeAndMerge('kleio', 'coverage-result', coverage);
  const summary = readRepo('scripts/fixtures/argus-schemas/valid/final-summary.json');
  Object.assign(summary, { engagementId: f.manifest.engagementId, runner: null,
    summary: 'Two immutable captures remain available after repeated evidence registration.' });
  const final = writeAndMerge('kleio', 'final-summary', summary);
  assert.equal(final.counts.evidence, 2);
  assert.equal(final.counts.bugs.suspected, 1);
  assert.equal(final.runner, null);
  assert.equal(deriveFinalSummaryFacts(f.manifest, getEngagementStatus(f.manifest)).counts.evidence, 2);
}
