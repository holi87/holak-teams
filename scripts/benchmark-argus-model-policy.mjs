#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--record'].includes(mode)) fail('usage: benchmark-argus-model-policy.mjs [--check|--record]');
const scenarios = readJson('argus/model-benchmark-scenarios.json');
const policy = readJson('argus/model-policy.json');
const outputPath = join(ROOT, 'argus/model-policy.benchmark.json');

assert(scenarios.schemaVersion === 1 && scenarios.syntheticOnly === true, 'benchmark scenarios must be synthetic schema v1');
assert(JSON.stringify(scenarios.models) === JSON.stringify(['opus', 'sonnet']), 'benchmark must compare Opus and Sonnet');

if (mode === '--record') {
  const result = {
    schemaVersion: 1,
    policyId: policy.policyId,
    decision: policy.baseline.decision,
    recordedAt: new Date().toISOString(),
    claudeCodeVersion: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    syntheticOnly: true,
    scenarios: scenarios.scenarios.map(recordScenario),
  };
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

const benchmark = readJson('argus/model-policy.benchmark.json');
assert(benchmark.schemaVersion === 1 && benchmark.policyId === policy.policyId, 'benchmark policy identity mismatch');
assert(benchmark.decision === 'adopt-10-frontier-17-standard', 'benchmark does not adopt the 10/17 baseline');
assert(benchmark.syntheticOnly === true, 'benchmark must not contain target data');
assert(benchmark.scenarios.length === scenarios.scenarios.length, 'benchmark scenario count drift');

for (const scenario of scenarios.scenarios) {
  const recorded = benchmark.scenarios.find((item) => item.id === scenario.id);
  assert(recorded, `${scenario.id}: benchmark result missing`);
  assert(recorded.agent === scenario.agent && recorded.expectedTier === scenario.expectedTier, `${scenario.id}: role/tier drift`);
  assert(recorded.qualityMarkers === scenario.requiredMarkers.length, `${scenario.id}: quality marker count drift`);
  assert(recorded.runs.length === 2, `${scenario.id}: expected two model runs`);
  for (const requestedModel of scenarios.models) {
    const run = recorded.runs.find((item) => item.requestedModel === requestedModel);
    assert(run, `${scenario.id}: ${requestedModel} run missing`);
    assert(run.runtimeModel.includes(requestedModel), `${scenario.id}: requested ${requestedModel} but runtime used ${run.runtimeModel}`);
    assert(run.qualityPassed === run.qualityTotal, `${scenario.id}: ${requestedModel} missed quality markers (${run.qualityPassed}/${run.qualityTotal})`);
    for (const metric of ['latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'reportedCostUsd']) {
      assert(Number.isFinite(run[metric]) && run[metric] >= 0, `${scenario.id}: ${requestedModel} invalid ${metric}`);
    }
    assert(/^[a-f0-9]{64}$/.test(run.outputSha256), `${scenario.id}: ${requestedModel} output hash missing`);
    for (const forbidden of ['prompt', 'completion', 'target', 'account', 'evidence']) assert(!Object.hasOwn(run, forbidden), `${scenario.id}: benchmark leaked ${forbidden}`);
  }
  if (scenario.expectedTier === 'standard') {
    const standard = recorded.runs.find((item) => item.requestedModel === 'sonnet');
    const frontier = recorded.runs.find((item) => item.requestedModel === 'opus');
    assert(standard.qualityPassed === frontier.qualityPassed, `${scenario.id}: standard quality regressed`);
    assert(standard.reportedCostUsd <= frontier.reportedCostUsd, `${scenario.id}: standard model did not reduce provider-reported cost`);
  }
}

console.log(`PASS  Argus model benchmark: ${benchmark.scenarios.length} synthetic scenarios, Opus/Sonnet quality + latency + tokens + cost, decision=${benchmark.decision}`);

function recordScenario(scenario) {
  return {
    id: scenario.id,
    agent: scenario.agent,
    expectedTier: scenario.expectedTier,
    classification: scenario.classification,
    qualityMarkers: scenario.requiredMarkers.length,
    runs: scenarios.models.map((model) => recordRun(scenario, model)),
  };
}

function recordRun(scenario, model) {
  const raw = execFileSync('claude', [
    '--plugin-dir', join(ROOT, 'argus/claude'),
    '--agent', `argus:${scenario.agent}`,
    '--model', model,
    '--print',
    '--output-format', 'json',
    '--max-turns', '1',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    scenario.prompt,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const response = JSON.parse(raw);
  assert(response.type === 'result' && response.subtype === 'success', `${scenario.id}: ${model} invocation failed`);
  const usage = response.usage ?? {};
  const runtimeModel = Object.keys(response.modelUsage ?? {})[0];
  const qualityPassed = scenario.requiredMarkers.filter((marker) => response.result.includes(marker)).length;
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  return {
    requestedModel: model,
    runtimeModel,
    qualityPassed,
    qualityTotal: scenario.requiredMarkers.length,
    latencyMs: response.duration_ms,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reportedCostUsd: response.total_cost_usd,
    outputSha256: createHash('sha256').update(response.result).digest('hex'),
  };
}

function readJson(path) { return JSON.parse(readFileSync(join(ROOT, path), 'utf8')); }
function assert(value, message) { if (!value) fail(message); }
function fail(message) { console.error(`FAIL  ${message}`); process.exit(1); }
