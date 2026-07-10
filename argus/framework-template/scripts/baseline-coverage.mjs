#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = join(ROOT, 'solution', 'surface-inventory.json');
const observations = join(ROOT, 'solution', 'coverage-observations.json');
const output = join(ROOT, 'solution', 'coverage-result.json');
const summaryPath = join(ROOT, 'reports', 'summary.json');
const executable = process.env.ARGUS_ASSETS ?? 'argus-assets';

for (const required of [inventory, observations]) {
  if (!existsSync(required)) {
    console.error(`surface-coverage: missing ${required.replace(`${ROOT}/`, '')}; coverage requires a target-derived denominator`);
    process.exit(1);
  }
}

const run = spawnSync(executable, ['coverage', 'calculate', '--inventory', inventory, '--observations', observations, '--output', output], { encoding: 'utf8' });
if (run.error) {
  console.error(`surface-coverage: cannot run ${executable}: ${run.error.message}`);
  process.exit(1);
}
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
if (run.status !== 0) process.exit(run.status ?? 1);

const coverage = JSON.parse(readFileSync(output, 'utf8'));
mkdirSync(dirname(summaryPath), { recursive: true });
let summary = {};
if (existsSync(summaryPath)) {
  try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { summary = {}; }
}
writeFileSync(summaryPath, `${JSON.stringify({ ...summary, surface_coverage: coverage, generated_at: new Date().toISOString() }, null, 2)}\n`);
console.log(`surface_coverage: execution=${format(coverage.overall.executionCoverage)} assertion=${format(coverage.overall.assertionQuality)} evidence=${format(coverage.overall.evidenceQuality)} scoped=${coverage.overall.scopedItems}`);

function format(value) { return value === null ? 'n/a' : `${Math.round(value * 10000) / 100}%`; }
