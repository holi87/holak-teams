#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/scripts/fixtures/argus-coverage"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for schema in surface-inventory coverage-observations coverage-result; do
  jq empty "$ROOT/argus/schemas/$schema.schema.json"
done

node --input-type=module - "$ROOT" "$FIXTURES" "$TMP" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [root, fixtures, tmp] = process.argv.slice(2);
const { calculateCoverage, validateCoverageObservations, validateSurfaceInventory } = await import(pathToFileURL(`${root}/argus/runtime/coverage.mjs`));
const inventory = JSON.parse(readFileSync(`${fixtures}/surface-inventory.json`, 'utf8'));
const observations = JSON.parse(readFileSync(`${fixtures}/coverage-observations.json`, 'utf8'));
if (validateSurfaceInventory(inventory).length) throw new Error('valid UI/API/event/data inventory rejected');
if (validateCoverageObservations(observations, inventory).length) throw new Error('valid observations rejected');
const result = calculateCoverage(inventory, observations);
if (result.overall.executionCoverage !== 0.7143) throw new Error(`unexpected risk-weighted execution coverage: ${result.overall.executionCoverage}`);
if (result.overall.assertionQuality !== 1 || result.overall.evidenceQuality !== 1) throw new Error('quality dimensions were not calculated independently');
if (result.scopedOutcomes.length !== 1 || result.scopedOutcomes[0].surfaceId !== 'SRF-DATA-AUDIT') throw new Error('inaccessible data surface was hidden');
if (result.defectOutcomes.scoreContribution !== 0 || result.defectOutcomes.uniqueConfirmed !== 1) throw new Error('defects changed score or were not deduplicated');

const withoutDefects = structuredClone(observations);
withoutDefects.observations.forEach((item) => { item.defects = []; });
const noDefectResult = calculateCoverage(inventory, withoutDefects);
for (const metric of ['executionCoverage', 'assertionQuality', 'evidenceQuality']) {
  if (result.overall[metric] !== noDefectResult.overall[metric]) throw new Error(`defects changed ${metric}`);
}

const small = structuredClone(inventory);
small.items = small.items.slice(0, 1); small.discovery = { candidates: 1, characterized: 1 };
const smallObservations = structuredClone(observations); smallObservations.observations = smallObservations.observations.slice(0, 1);
if (calculateCoverage(small, smallObservations).overall.executionCoverage !== 1) throw new Error('small target did not scale to its own denominator');
const large = structuredClone(inventory);
for (let i = 0; i < 20; i += 1) large.items.push({ ...large.items[2], id: `SRF-EVENT-EXTRA-${i}` });
large.discovery = { candidates: 25, characterized: 24 };
if (calculateCoverage(large, observations).overall.executionCoverage >= result.overall.executionCoverage) throw new Error('large uncovered surface did not expand the denominator');

const invalid = structuredClone(inventory); invalid.items.push({ ...invalid.items[0] });
if (!validateSurfaceInventory(invalid).some((error) => error.includes('duplicate surface id'))) throw new Error('duplicate surface accepted');
writeFileSync(`${tmp}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
NODE

node "$ROOT/scripts/sync-argus-runtime-assets.mjs" --write >/dev/null
"$ROOT/argus/claude/bin/argus-assets" coverage validate --inventory "$FIXTURES/surface-inventory.json" --observations "$FIXTURES/coverage-observations.json"
"$ROOT/argus/claude/bin/argus-assets" coverage calculate --inventory "$FIXTURES/surface-inventory.json" --observations "$FIXTURES/coverage-observations.json" --output "$TMP/cli-result.json"
jq -S 'del(.generatedAt)' "$TMP/result.json" >"$TMP/runtime-normalized.json"
jq -S 'del(.generatedAt)' "$TMP/cli-result.json" >"$TMP/cli-normalized.json"
cmp "$TMP/runtime-normalized.json" "$TMP/cli-normalized.json" >/dev/null || { echo 'FAIL  runtime and CLI coverage results differ' >&2; exit 1; }
printf 'PASS  surface-derived UI/API/event/data coverage, scoped outcomes, proportional denominators, and defect-neutral scoring\n'
