#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = join(ROOT, 'solution', 'surface-inventory.json');
const observations = join(ROOT, 'solution', 'coverage-observations.json');
const evidence = join(ROOT, 'solution', 'evidence-reference.json');
const ledger = join(ROOT, 'solution', 'bug-ledger.json');
const automationStatus = join(ROOT, 'solution', 'automation-status.json');
// Inside an Argus engagement the canonical solution/coverage-result.json has one writer,
// Kleio's merge, and the packaged CLI refuses it. The hook then writes its calculation to
// reports/ as a preview. Delivered CI, with no engagement, writes the canonical path.
const engaged = activeEngagement();
const output = join(ROOT, engaged ? 'reports' : 'solution', 'coverage-result.json');
const summaryPath = join(ROOT, 'reports', 'summary.json');
const executable = process.env.ARGUS_ASSETS ?? 'argus-assets';

// Kleio merges solution/coverage-observations.json only in reporting, after the automation
// phase's runs, so inside an engagement an unmerged canonical input defers the gate: exit 0,
// with no result and no event (the outcome adapter alone emits events). Kleio calculates the
// canonical result from the merged inputs. Outside an engagement a missing input fails.
const missing = [inventory, observations].filter((required) => !existsSync(required))
  .map((required) => required.replace(`${ROOT}/`, ''));
if (missing.length > 0 && engaged) {
  console.log(`COVERAGE  deferred reason=canonical-input-unmerged missing=${missing.join(',')}; inside an Argus engagement Kleio calculates the canonical coverage result in reporting`);
  process.exit(0);
}
if (missing.length > 0) {
  console.error(`surface-coverage: missing ${missing.join(', ')}; coverage requires a target-derived denominator`);
  process.exit(1);
}

// Execution is derived from registered evidence and defect outcomes from the ledger; evidence
// sources resolve against this project root. The automation status, when present, must map
// every credited runner case to its surface.
const args = ['coverage', 'calculate', '--inventory', inventory, '--observations', observations];
if (existsSync(evidence)) args.push('--evidence', evidence);
if (existsSync(ledger)) args.push('--ledger', ledger);
if (existsSync(automationStatus)) args.push('--automation-status', automationStatus);
args.push('--root', ROOT, '--output', '-');
const run = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (run.error) {
  console.error(`surface-coverage: cannot run ${executable}: ${run.error.message}`);
  process.exit(1);
}
if (run.stderr) process.stderr.write(run.stderr);
if (run.status !== 0) {
  if (run.stdout) process.stdout.write(run.stdout);
  process.exit(run.status ?? 1);
}

let coverage;
try { coverage = JSON.parse(run.stdout); } catch {
  console.error(`surface-coverage: ${executable} coverage calculate did not print a JSON result`);
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, run.stdout);
console.log(`COVERAGE  calculated output=${output}`);
mkdirSync(dirname(summaryPath), { recursive: true });
let summary = {};
if (existsSync(summaryPath)) {
  try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { summary = {}; }
}
writeFileSync(summaryPath, `${JSON.stringify({ ...summary, surface_coverage: coverage, generated_at: new Date().toISOString() }, null, 2)}\n`);
console.log(`surface_coverage: execution=${format(coverage.overall.executionCoverage)} assertion=${format(coverage.overall.assertionQuality)} evidence=${format(coverage.overall.evidenceQuality)} automated=${format(coverage.overall.automatedExecution)} runner-cases=${coverage.runnerCaseMapping} scoped=${coverage.overall.scopedItems}`);

function format(value) { return value === null ? 'n/a' : `${Math.round(value * 10000) / 100}%`; }

// The CLI finds an engagement the same way: ARGUS_ENGAGEMENT_MANIFEST, or an
// ai_agents_internal/engagement.json in the working directory or an ancestor.
function activeEngagement() {
  if (process.env.ARGUS_ENGAGEMENT_MANIFEST) return true;
  for (const start of [process.cwd(), ROOT]) {
    for (let cursor = resolve(start); ; cursor = dirname(cursor)) {
      if (existsSync(join(cursor, 'ai_agents_internal', 'engagement.json'))) return true;
      if (dirname(cursor) === cursor) break;
    }
  }
  return false;
}
