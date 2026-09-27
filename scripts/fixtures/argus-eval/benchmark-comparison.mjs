#!/usr/bin/env node
// Test-only input builder for the prompt-approval smoke (scripts/smoke-prompt-regression.sh).
// It writes a schema-valid argus-eval/private-runs@2 comparison of two variants and the
// argus-eval/final-verdicts@1 that finalize those exact runs, so the smoke can score them with
// the real scripts/eval/discovery/adjudicate.mjs and hand its discovery-summary@1 output to
// scripts/approve-argus-prompts.mjs. Synthetic runs only; no model is called and no Argus score
// is claimed.
//
// Usage: benchmark-comparison.mjs --work <empty-dir> --plan '<json>'
//   plan: {"variants": {"baseline": {"revision": "<40 hex>", "seeds": {"A": 3, "B": 2}},
//                       "candidate": {"revision": "<40 hex>", "seeds": {"A": 3, "B": 2}}},
//          "testMode": false, "dropVerdict": false}
// Every faulty run of a variant in a mode confirms that many distinct corpus seeds, each with a
// real judge verdict; corrected runs report nothing. dropVerdict removes the last verdict of the
// first faulty candidate run (adjudicate.mjs then reports UNSCORED). Prints the two input paths.
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusDigest, corpusVersion, seedIds, truthFor } from '../../eval/discovery/corpus/index.mjs';
import { formatSchemaErrors, validateEval } from '../../eval/discovery/lib/schemas.mjs';

const MODES = ['A', 'B'];
const BUILDS = ['faulty', 'corrected'];
const REPEATS = 3;
const STARTED = Date.UTC(2026, 0, 1, 12, 0, 0);
const sha256 = value => createHash('sha256').update(value).digest('hex');

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`benchmark-comparison: ${name} is required`);
  return args[index + 1];
};
const work = realpathSync(option('--work'));
const plan = JSON.parse(option('--plan'));
const variantNames = Object.keys(plan.variants);

const sealed = join(work, 'sealed');
mkdirSync(join(sealed, 'repro'), { recursive: true, mode: 0o700 });

const runs = [];
const verdictRuns = [];
for (const variant of variantNames) {
  const { revision, seeds } = plan.variants[variant];
  for (const mode of MODES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      for (const build of BUILDS) {
        const runId = `r${repeat}-${mode}-${build}-${variant}`;
        const artifactRoot = join(sealed, 'runs', runId, 'artifacts');
        mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
        const enabledSeeds = build === 'faulty' ? [...seedIds] : [];
        const credited = build === 'faulty' ? seedIds.slice(0, seeds[mode]) : [];
        const rows = credited.map((seedId, index) => {
          const id = `BUG-${String(index + 1).padStart(4, '0')}`;
          const origin = `ATA-${String(index + 1).padStart(3, '0')}`;
          return { id, origin: [origin], lane: 'atalanta', severity: 'Major', status: 'confirmed', wired: false, testId: null,
            title: `Synthetic finding ${id}`, reportPath: `bugs/${origin}.md`, evidenceIds: [], confirmedAtMs: 1000 + index, seedId };
        });
        runs.push({
          runId, variant, revision, repeat, seed: 100 + repeat, mode, build, enabledSeeds, truth: truthFor(enabledSeeds),
          url: 'http://127.0.0.1:40000', port: 40000, contract: { rules: ['Synthetic public rule.'] }, status: 'awaiting-adjudication',
          reason: null, launchAssurance: 'unattested', startedAt: new Date(STARTED).toISOString(), elapsedMs: 60_000, timedOut: false,
          overBudget: false, artifactRoot,
          adapter: { envNames: ['HOME', 'PATH', 'TMPDIR'], exitCode: 0, signal: null, spawnError: null, resultState: 'valid', resultErrors: [],
            result: { schema: 'argus-eval/adapter-result@2', status: 'completed', launcherExitCode: 0,
              usage: { source: 'claude-cli-result-json', inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0,
                totalTokens: 1000, costUsd: 2.5, numTurns: 40, controllerTurnCapHit: false },
              subject: { pluginVersion: '5.0.0', pluginDigest: sha256(`synthetic plugin tree ${variant}`) }, reason: null, launchAssurance: 'unattested' } },
          extraction: { ledger: 'present', ledgerErrors: [], findings: rows.map(({ seedId, ...row }) => row), suspected: [], unledgeredReports: [],
            framework: { root: null, candidates: 0 } },
          contamination: { status: 'clean', hits: [], totalHits: 0, scannedFiles: 3, skippedFiles: 0 },
          replay: null,
        });
        verdictRuns.push({
          runId,
          verdicts: rows.map(row => ({ findingId: row.id, status: row.status, outcome: 'real', seedId: row.seedId, duplicateOf: null, source: 'judge',
            confidence: 'high', reason: `Judge reason for ${row.id}.`, evidenceRef: null, humanReproduced: null, reviewer: null, overturned: null })),
        });
      }
    }
  }
}
if (plan.dropVerdict) verdictRuns.find(entry => entry.runId.includes('-faulty-candidate') && entry.verdicts.length > 0).verdicts.pop();

const privateRuns = {
  schema: 'argus-eval/private-runs@2', createdAt: new Date(STARTED).toISOString(),
  config: { schema: 'argus-eval/comparison-config@2',
    variants: variantNames.map(name => ({ name, revision: plan.variants[name].revision, command: ['/bin/true'] })),
    modes: MODES, builds: BUILDS, repeats: REPEATS, seeds: Array.from({ length: REPEATS }, (_, repeat) => 100 + repeat),
    secondsByMode: { A: 28800, B: 14400 }, tokens: null, workRoot: work, adapterEnv: ['ANTHROPIC_API_KEY'],
    replay: { enabled: true, repeats: 2, perSeedMatrix: true, secondsPerRunner: 1800 }, corpusModule: null, testMode: plan.testMode === true },
  corpus: { version: corpusVersion, digest: corpusDigest() }, canarySha256: sha256('smoke canary'), runs,
};
assertValid('private-runs', privateRuns);
const runsPath = join(sealed, 'private-runs.json');
const runsBytes = `${JSON.stringify(privateRuns, null, 2)}\n`;
writeFileSync(runsPath, runsBytes, { mode: 0o600 });

const verdicts = {
  schema: 'argus-eval/final-verdicts@1', status: 'final', createdAt: new Date(STARTED + 86_400_000).toISOString(), runsSha256: sha256(runsBytes),
  judgeSha256: sha256('synthetic judge verdicts'), sheetSha256: sha256('synthetic spot-check sheet'),
  judge: { model: 'opus', effort: 'max', passes: 2, claudeVersion: '2.1.283', systemPromptSha256: sha256('judge system prompt'), includeSuspected: true },
  spotCheck: { all: false, samplingSeed: 12345, rate: 0.2, minimum: 5, items: 8, reviewed: 8, pending: 0 },
  reliability: { randomSampled: 5, randomReviewed: 5, randomOverturned: 0, overturnRate: 0, maxOverturnRate: 0.1 },
  runs: verdictRuns,
};
assertValid('final-verdicts', verdicts);
const verdictsPath = join(work, 'final-verdicts.json');
writeFileSync(verdictsPath, `${JSON.stringify(verdicts, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ runs: runsPath, verdicts: verdictsPath }));

function assertValid(schemaName, document) {
  const errors = validateEval(schemaName, document);
  if (errors.length) throw new Error(`benchmark-comparison: ${schemaName} fixture violation: ${formatSchemaErrors(errors)}`);
}
