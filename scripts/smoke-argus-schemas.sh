#!/usr/bin/env bash
# Validate every canonical Argus contract with valid and invalid fixtures, then prove
# engagement fragments reject malformed documents and render a human-facing summary.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
FIXTURES="$ROOT/scripts/fixtures/argus-schemas"
WORK="$(mktemp -d)"
HOST="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOST"' EXIT

source "$ROOT/scripts/lib/argus-smoke-model-control.sh"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

node "$ROOT/scripts/validate-argus-schemas.mjs"

schema_listing="$($CLI schema list)"
grep -Fq $'preflight-report\thttps://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/preflight-report.schema.json\tschemaVersion=3\treadCompatible=3\treport-only' <<<"$schema_listing" || fail 'schema list omitted the current report-only preflight reader'
for unsupported_version in 2 4; do
  printf '{"schemaVersion":%s}\n' "$unsupported_version" >"$WORK/unsupported-preflight-$unsupported_version.json"
  if "$CLI" schema validate --kind preflight-report --input "$WORK/unsupported-preflight-$unsupported_version.json" \
    >/dev/null 2>"$WORK/unsupported-preflight-$unsupported_version.err"; then
    fail "preflight report reader accepted unsupported schemaVersion $unsupported_version"
  fi
  grep -Fq "unsupported schemaVersion $unsupported_version; expected 3" "$WORK/unsupported-preflight-$unsupported_version.err" || \
    fail "preflight report reader did not name the supported v3 contract for schemaVersion $unsupported_version"
done

for kind in bug-ledger lane-plan evidence-reference automation-status surface-inventory coverage-observations coverage-result final-summary model-escalation-request runner-result capability-evidence; do
  "$CLI" schema validate --kind "$kind" --input "$FIXTURES/valid/$kind.json" >/dev/null
  invalid_count=0
  for invalid in "$FIXTURES/invalid/$kind.json" "$FIXTURES/invalid/$kind-"*.json "$FIXTURES/semantic-invalid/$kind-"*.json; do
    [ -f "$invalid" ] || continue
    invalid_count=$((invalid_count + 1))
    if "$CLI" schema validate --kind "$kind" --input "$invalid" >/dev/null 2>&1; then
      fail "invalid $(basename "$invalid") fixture unexpectedly passed"
    fi
  done
  [ "$invalid_count" -gt 0 ] || fail "$kind has no invalid fixture"
done

# Recon capability evidence gates exactly the capability-matrix target capabilities.
schema_capabilities="$(jq -c '."$defs".gate.properties.capability.enum | sort' "$ROOT/argus/schemas/capability-evidence.schema.json")"
matrix_capabilities="$(jq -c '.capabilities | to_entries | map(select(.value.kind == "target") | .key) | sort' "$ROOT/argus/capabilities/capability-matrix.json")"
[ "$schema_capabilities" = "$matrix_capabilities" ] || fail "capability-evidence capabilities $schema_capabilities drifted from capability-matrix target capabilities $matrix_capabilities"
CAPABILITY_EVIDENCE="$FIXTURES/valid/capability-evidence.json"
jq '(.gates[] | select(.capability == "existing-suite")) |= {capability, verdict: "proven", summary: "A vitest suite exists.", evidenceIds: ["EVD-0006"], proof: {kind: "suite-root", path: "/srv/target/tests", runner: "vitest", testFile: "/srv/target/tests/orders.test.ts"}}
  | (.gates[] | select(.capability == "non-rest-surface")) |= {capability, verdict: "proven", summary: "GraphQL and WebSocket surfaces answered.", evidenceIds: ["EVD-0007"], proof: {kind: "protocol-surface", protocols: ["graphql", "websocket"], surfaceIds: ["SRF-GQL-ORDERS", "SRF-WS-CART"]}}' \
  "$CAPABILITY_EVIDENCE" >"$WORK/capability-evidence-all-proven.json"
"$CLI" schema validate --kind capability-evidence --input "$WORK/capability-evidence-all-proven.json" >/dev/null || fail 'capability-evidence rejected a fully proven document'
for rule in \
  'escaped-source-file|(.gates[] | select(.capability == "source-access") | .proof.fileRead) = "/srv/target/src/../secrets.txt"' \
  'suite-file-outside-root|(.gates[] | select(.capability == "existing-suite")) |= {capability, verdict: "proven", summary: "s", evidenceIds: ["EVD-0006"], proof: {kind: "suite-root", path: "/srv/target/tests", runner: "vitest", testFile: "/srv/target/tests-other/a.test.ts"}}' \
  'repeated-service-origin|(.gates[] | select(.capability == "multi-service") | .proof.services[1].origin) = "HTTP://127.0.0.1:3000"' \
  'credential-in-service-origin|(.gates[] | select(.capability == "multi-service") | .proof.services[1].origin) = "postgres://qa:secret@db:5432"' \
  'proven-without-proof|(.gates[] | select(.capability == "db-access")) |= del(.proof)' \
  'proven-without-evidence|(.gates[] | select(.capability == "db-access") | .evidenceIds) = []'; do
  jq "${rule#*|}" "$CAPABILITY_EVIDENCE" >"$WORK/capability-evidence-${rule%%|*}.json"
  if "$CLI" schema validate --kind capability-evidence --input "$WORK/capability-evidence-${rule%%|*}.json" >/dev/null 2>&1; then
    fail "capability-evidence accepted ${rule%%|*}"
  fi
done

for kind in lane-plan evidence-reference automation-status; do
  jq --arg schema "argus/$kind@1" '."$schema"=$schema | .schemaVersion=1' \
    "$FIXTURES/valid/$kind.json" >"$WORK/$kind-retired-v1.json"
  if "$CLI" schema validate --kind "$kind" --input "$WORK/$kind-retired-v1.json" >/dev/null 2>&1; then
    fail "$kind runtime reader accepted retired v1 input"
  fi
done

TARGET="$WORK/target"
mkdir -p "$TARGET"
"$CLI" engagement init --target "$TARGET" --artifact-root "$TARGET" --mode A --engagement-id schema-fixture >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
argus_smoke_prepare_model_control "$CLI" "$MANIFEST" "$TARGET" "$TARGET" A \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST"
ODYSSEUS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" odysseus | jq -r .token)"
KLEIO="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" kleio "$ODYSSEUS" | jq -r .token)"
MINOS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" minos "$ODYSSEUS" | jq -r .token)"
ATLAS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" atlas "$ODYSSEUS" | jq -r .token)"
KALCHAS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" kalchas "$ODYSSEUS" | jq -r .token)"
ATALANTA="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" atalanta "$ODYSSEUS" | jq -r .token)"
TALOS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" talos "$ODYSSEUS" | jq -r .token)"
DAIDALOS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" daidalos "$ODYSSEUS" | jq -r .token)"

for invalid in "$FIXTURES/invalid/bug-ledger.json" "$FIXTURES/invalid/bug-ledger-"*.json "$FIXTURES/semantic-invalid/bug-ledger-"*.json; do
  [ -f "$invalid" ] || continue
  fragment_id="invalid-$(basename "$invalid" .json)"
  if "$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/bug-ledger.json --id "$fragment_id" --input "$invalid" >/dev/null 2>&1; then
    fail "invalid canonical fragment $(basename "$invalid") unexpectedly passed"
  fi
done

# Capability evidence is written directly by Kalchas; it is never a mergeable canonical fragment.
jq '.engagementId = "schema-fixture"' "$CAPABILITY_EVIDENCE" >"$WORK/capability-evidence-engagement.json"
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --canonical solution/discovery/capability-evidence.json --id capability-evidence --input "$WORK/capability-evidence-engagement.json" >"$WORK/capability-fragment.out" 2>&1; then
  fail 'capability evidence was accepted as a canonical fragment'
fi
grep -Fq 'unknown canonical artifact: solution/discovery/capability-evidence.json' "$WORK/capability-fragment.out" || fail 'capability evidence fragment was not rejected as a non-canonical artifact'

jq '.engagementId = "schema-fixture" | .lanes = [.lanes[1]]' "$FIXTURES/valid/lane-plan.json" >"$WORK/lane-talos.json"
jq '.engagementId = "schema-fixture" | .lanes = [.lanes[0]]' "$FIXTURES/valid/lane-plan.json" >"$WORK/lane-kalchas.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/lane-plan.json --id a-talos --input "$WORK/lane-talos.json" >/dev/null
lane_fragment="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --canonical solution/lane-plan.json --id z-kalchas --input "$WORK/lane-kalchas.json")"
jq -e '."$schema" == "argus/lane-plan@2" and .schemaVersion == 2 and (.lanes[0].transitions | map(.to) == ["planned", "running", "completed"])' "$TARGET/$(jq -r .path <<<"$lane_fragment")" >/dev/null || fail 'current lane-plan fragment was not persisted as v2'
"$CLI" engagement merge --manifest "$MANIFEST" --owner odysseus --token "$ODYSSEUS" --canonical solution/lane-plan.json >/dev/null
jq -e '.lanes | map(.lane) == ["kalchas", "talos"]' "$TARGET/solution/lane-plan.json" >/dev/null || fail 'lane-plan fragments were not merged in deterministic lane order'

node --input-type=module - "$FIXTURES/valid/evidence-reference.json" "$TARGET" "$WORK/evidence-source.json" <<'NODE'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
const [input, target, output] = process.argv.slice(2);
const document = JSON.parse(readFileSync(input));
for (const ref of document.references) {
  const content = `Synthetic evidence ${ref.id}\n`;
  const path = join(target, ref.source); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, content);
  ref.sha256 = createHash('sha256').update(content).digest('hex');
  ref.capturedAt = new Date().toISOString();
}
writeFileSync(output, JSON.stringify(document));
NODE

jq '.engagementId = "schema-fixture" | .references = [.references[1]]' "$WORK/evidence-source.json" >"$WORK/evidence-2.json"
jq '.engagementId = "schema-fixture" | .references = [.references[0]]' "$WORK/evidence-source.json" >"$WORK/evidence-1.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/evidence-reference.json --id a-evidence-2 --input "$WORK/evidence-2.json" >/dev/null
evidence_fragment="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/evidence-reference.json --id z-evidence-1 --input "$WORK/evidence-1.json")"
jq -e '."$schema" == "argus/evidence-reference@2" and .schemaVersion == 2' "$TARGET/$(jq -r .path <<<"$evidence_fragment")" >/dev/null || fail 'evidence-reference fragment was not persisted as v2'
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/evidence-reference.json >/dev/null
jq -e '.references | map(.id) == ["EVD-0001", "EVD-0002"]' "$TARGET/solution/evidence-reference.json" >/dev/null || fail 'evidence fragments were not merged in deterministic ID order'

# Exercise the actual canonical merge gate, not only the standalone validator.
jq '.engagementId = "schema-fixture"' "$FIXTURES/valid/bug-ledger.json" >"$WORK/proven-ledger.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/bug-ledger.json --id proven-ledger --input "$WORK/proven-ledger.json" >/dev/null
# The triager must not wait for the reporter's later canonical registry.
mv "$TARGET/solution/evidence-reference.json" "$WORK/published-registry.json"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null
mv "$WORK/published-registry.json" "$TARGET/solution/evidence-reference.json"
cp "$TARGET/reports/request-1.txt" "$WORK/original-proof.txt"
printf 'changed evidence' >"$TARGET/reports/request-1.txt"
if "$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null 2>&1; then
  fail 'confirmed ledger merge accepted evidence digest drift'
fi
cp "$WORK/original-proof.txt" "$TARGET/reports/request-1.txt"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null


jq '.engagementId = "schema-fixture" | .tests = [.tests[1]]' "$FIXTURES/valid/automation-status.json" >"$WORK/automation-2.json"
jq '.engagementId = "schema-fixture" | .tests = [.tests[0]]' "$FIXTURES/valid/automation-status.json" >"$WORK/automation-1.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane daidalos --token "$DAIDALOS" --canonical solution/automation-status.json --id a-automation-2 --input "$WORK/automation-2.json" >/dev/null
automation_fragment="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/automation-status.json --id z-automation-1 --input "$WORK/automation-1.json")"
jq -e '."$schema" == "argus/automation-status@2" and .schemaVersion == 2' "$TARGET/$(jq -r .path <<<"$automation_fragment")" >/dev/null || fail 'automation-status fragment was not persisted as v2'
"$CLI" engagement merge --manifest "$MANIFEST" --owner atlas --token "$ATLAS" --canonical solution/automation-status.json >/dev/null
jq -e '.tests | map(.testId) == ["REG-0001", "TST-0002"]' "$TARGET/solution/automation-status.json" >/dev/null || fail 'automation fragments were not merged in deterministic test ID order'

if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/final-summary.json --id foreign --input "$FIXTURES/valid/final-summary.json" >/dev/null 2>&1; then
  fail "cross-engagement canonical fragment unexpectedly passed"
fi
node --input-type=module - "$WORK" <<'NODE'
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const work=process.argv[2];
const inventory={$schema:'argus/surface-inventory@1',schemaVersion:1,engagementId:'schema-fixture',owner:'kalchas',discovery:{candidates:1,characterized:1},items:[{id:'SRF-API-ORDER',surfaceType:'api',lane:'api',risk:'critical',riskWeight:5,riskBasis:'Ownership invariant',accessibility:'testable',denominators:['role','state'],discoveryEvidenceIds:['EVD-0001'],obligations:['OWNER','OTHER'].map(role=>({id:`CASE-${role}`,dimensions:{role,state:'active'},oracleId:'ORC-ACCESS',applicability:'Two synthetic actors',weight:5}))}]};
const observations={$schema:'argus/coverage-observations@1',schemaVersion:1,engagementId:'schema-fixture',observations:[{surfaceId:'SRF-API-ORDER',executed:true,assertions:[{id:'A1',oracleId:'ORC-ACCESS',meaningful:true}],evidenceIds:['EVD-0001'],defects:[],cases:[{obligationId:'CASE-OWNER',oracleId:'ORC-ACCESS',outcome:'passed',evidenceIds:['EVD-0001'],controlEvidenceIds:['EVD-0002']}]}]};
writeFileSync(join(work,'inventory.json'),JSON.stringify(inventory));writeFileSync(join(work,'observations.json'),JSON.stringify(observations));
NODE
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --canonical solution/surface-inventory.json --id case-plan --input "$WORK/inventory.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kalchas --token "$KALCHAS" --canonical solution/surface-inventory.json >/dev/null
"$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/coverage-observations.json --id cases --input "$WORK/observations.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-observations.json >/dev/null
"$CLI" coverage calculate --inventory "$WORK/inventory.json" --observations "$WORK/observations.json" >"$WORK/case-coverage.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/coverage-result.json --id case-result --input "$WORK/case-coverage.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-result.json >/dev/null
jq -e '.overall.caseDepth.coverage == 0.5 and (.overall.caseDepth.gaps | length) == 1' "$TARGET/solution/coverage-result.json" >/dev/null || fail 'case depth overstated partial coverage'
cp "$TARGET/reports/runner.log" "$WORK/original-control.txt"
printf 'changed control proof' >"$TARGET/reports/runner.log"
if "$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-result.json >/dev/null 2>&1; then
  fail 'coverage merge accepted modified assertion-control evidence'
fi
cp "$WORK/original-control.txt" "$TARGET/reports/runner.log"

jq '.engagementId = "schema-fixture"' "$FIXTURES/valid/final-summary.json" >"$WORK/final-summary.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/final-summary.json --id summary --input "$WORK/final-summary.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/final-summary.json >/dev/null
grep -Fq 'Source schema: argus/final-summary@1' "$TARGET/solution/FINAL-SUMMARY.md" || fail "rendered summary has no source schema"
grep -Fq 'Required-case depth: 50%' "$TARGET/solution/FINAL-SUMMARY.md" || fail "rendered summary has no surface-derived coverage"

printf 'PASS  Argus schemas: current fixtures, retired v1 rejection, deterministic collection merges, fragment rejection, stable IDs, runner results, and source-versioned summary\n'
