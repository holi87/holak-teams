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

for kind in bug-ledger lane-plan evidence-reference automation-status surface-inventory coverage-observations coverage-result final-summary model-escalation-request runner-result capability-evidence automation-review; do
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

for retired in lane-plan:1 evidence-reference:1 evidence-reference:2 automation-status:1 bug-ledger:1 coverage-observations:1 coverage-result:1 final-summary:1; do
  kind="${retired%%:*}" version="${retired#*:}"
  jq --arg schema "argus/$kind@$version" --argjson version "$version" '."$schema"=$schema | .schemaVersion=$version' \
    "$FIXTURES/valid/$kind.json" >"$WORK/$kind-retired-v$version.json"
  if "$CLI" schema validate --kind "$kind" --input "$WORK/$kind-retired-v$version.json" >/dev/null 2>&1; then
    fail "$kind runtime reader accepted retired v$version input"
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
ARISTARCHUS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" aristarchus "$ODYSSEUS" | jq -r .token)"

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
jq -e '."$schema" == "argus/evidence-reference@3" and .schemaVersion == 3 and .references[0].mediaType == "text/plain" and .references[0].relatedSurfaceIds == ["SRF-API-ORDER"]' "$TARGET/$(jq -r .path <<<"$evidence_fragment")" >/dev/null || fail 'evidence-reference fragment was not persisted as v3'
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/evidence-reference.json >/dev/null
jq -e '.references | map(.id) == ["EVD-0001", "EVD-0002"]' "$TARGET/solution/evidence-reference.json" >/dev/null || fail 'evidence fragments were not merged in deterministic ID order'

# Coverage observations cite registered evidence; coverage-result merges only against the
# canonical ledger while Minos is dispatchable. The Kleio fragment is calculated with the ledger
# that Minos merges next, so the refused merge succeeds unchanged once that ledger exists.
node --input-type=module - "$WORK" <<'NODE'
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const work=process.argv[2];
const inventory={$schema:'argus/surface-inventory@1',schemaVersion:1,engagementId:'schema-fixture',owner:'kalchas',discovery:{candidates:1,characterized:1},items:[{id:'SRF-API-ORDER',surfaceType:'api',lane:'api',risk:'critical',riskWeight:5,riskBasis:'Ownership invariant',accessibility:'testable',denominators:['role','state'],discoveryEvidenceIds:['EVD-0002'],obligations:['OWNER','OTHER'].map(role=>({id:`CASE-${role}`,dimensions:{role,state:'active'},oracleId:'ORC-ACCESS',applicability:'Two synthetic actors',weight:5}))}]};
const observations={$schema:'argus/coverage-observations@2',schemaVersion:2,engagementId:'schema-fixture',observations:[{observationId:'atalanta:SRF-API-ORDER',lane:'atalanta',surfaceId:'SRF-API-ORDER',executions:[{evidenceId:'EVD-0001'}],assertions:[{id:'A1',oracleId:'ORC-ACCESS',evidenceIds:['EVD-0001'],controlEvidenceIds:['EVD-0002']}],evidenceIds:['EVD-0001'],defectRefs:['ATA-001'],cases:[{obligationId:'CASE-OWNER',oracleId:'ORC-ACCESS',outcome:'passed',evidenceIds:['EVD-0001'],controlEvidenceIds:['EVD-0002']}]}]};
writeFileSync(join(work,'inventory.json'),JSON.stringify(inventory));writeFileSync(join(work,'observations.json'),JSON.stringify(observations));
NODE
jq '.engagementId = "schema-fixture"' "$FIXTURES/valid/bug-ledger.json" >"$WORK/proven-ledger.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --canonical solution/surface-inventory.json --id case-plan --input "$WORK/inventory.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kalchas --token "$KALCHAS" --canonical solution/surface-inventory.json >/dev/null
"$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/coverage-observations.json --id cases --input "$WORK/observations.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-observations.json >/dev/null
jq -e '."$schema" == "argus/coverage-observations@2" and (.observations | map(.observationId)) == ["atalanta:SRF-API-ORDER"]' "$TARGET/solution/coverage-observations.json" >/dev/null || fail 'coverage observations were not merged as a v2 collection'
# An observation belongs to its lane: another lane cannot write it, and the owner re-records it in
# later passes. The record from the highest write sequence is merged, whatever the fragment IDs.
cp "$TARGET/solution/coverage-observations.json" "$WORK/observations-first.json"
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/coverage-observations.json --id foreign-cases --input "$WORK/observations.json" >"$WORK/observation-foreign.out" 2>&1; then
  fail 'a lane wrote another lane coverage observation'
fi
grep -Fq 'coverage observation atalanta:SRF-API-ORDER belongs to atalanta; talos may write only its own records' "$WORK/observation-foreign.out" || fail "foreign observation failed for another reason: $(<"$WORK/observation-foreign.out")"
jq '.observations[0].evidenceIds += ["EVD-0002"]' "$WORK/observations.json" >"$WORK/observations-deep-1.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/coverage-observations.json --id a-deep-1 --input "$WORK/observations-deep-1.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-observations.json >/dev/null || fail 'a re-recorded coverage observation broke the observations merge'
jq -e '(.observations | length) == 1 and .observations[0].evidenceIds == ["EVD-0001", "EVD-0002"]' "$TARGET/solution/coverage-observations.json" >/dev/null || fail 'the later coverage observation did not supersede the earlier one'
"$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/coverage-observations.json --id b-deep-2 --input "$WORK/observations.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-observations.json >/dev/null
cmp -s "$WORK/observations-first.json" "$TARGET/solution/coverage-observations.json" || fail 'the latest coverage observation by write sequence was not merged'
"$CLI" coverage calculate --inventory "$WORK/inventory.json" --observations "$WORK/observations.json" \
  --evidence "$TARGET/solution/evidence-reference.json" --ledger "$WORK/proven-ledger.json" --root "$TARGET" >"$WORK/case-coverage.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/coverage-result.json --id case-result --input "$WORK/case-coverage.json" >/dev/null
if "$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-result.json >"$WORK/coverage-no-ledger.out" 2>&1; then
  fail 'coverage-result merged without the canonical bug ledger while Minos is dispatchable'
fi
grep -Fq 'coverage defect outcomes require the canonical bug ledger' "$WORK/coverage-no-ledger.out" || fail "coverage merge without a ledger failed for another reason: $(<"$WORK/coverage-no-ledger.out")"
test ! -e "$TARGET/solution/coverage-result.json" || fail 'a refused coverage merge wrote the canonical result'

# Exercise the actual canonical merge gate, not only the standalone validator.
ledger_fragment="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/bug-ledger.json --id proven-ledger --input "$WORK/proven-ledger.json")"
# The triager must not wait for the reporter's later canonical registry.
mv "$TARGET/solution/evidence-reference.json" "$WORK/published-registry.json"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null
mv "$WORK/published-registry.json" "$TARGET/solution/evidence-reference.json"
jq -e --slurpfile submitted "$WORK/proven-ledger.json" '. == $submitted[0]' "$TARGET/solution/bug-ledger.json" >/dev/null || fail 'an intact bug-ledger merge changed the submitted ledger'
"$CLI" engagement status --manifest "$MANIFEST" | jq -e '.merges["solution/bug-ledger.json"].quarantined == []' >/dev/null || fail 'an intact bug-ledger merge recorded quarantined rows'
# Evidence drift quarantines every row that cites the changed capture instead of failing the merge.
cp "$TARGET/reports/request-1.txt" "$WORK/original-proof.txt"
printf 'changed evidence' >"$TARGET/reports/request-1.txt"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null || fail 'evidence drift failed the whole ledger merge'
jq -e '.bugs[0].status == "quarantined" and (.bugs[0].quarantine.reasons | index("evidence digest drift EVD-0001")) != null
  and ([.bugs[] | select(.status == "confirmed")] | length) == 0
  and ([.bugs[] | select(.id == "BUG-0003" or .id == "BUG-0005" or .id == "BUG-0006") | .status] == ["needs-oracle", "rejected", "bounced"])' \
  "$TARGET/solution/bug-ledger.json" >/dev/null || fail 'evidence drift did not quarantine exactly the rows that cite it'
"$CLI" engagement status --manifest "$MANIFEST" | jq -e '.merges["solution/bug-ledger.json"].quarantined == ["BUG-0001", "BUG-0002", "BUG-0004", "BUG-0007"]
  and (.ledgerSnapshots[.currentPhase] | (.confirmed == []) and (.quarantined | index("BUG-0001")) != null)' >/dev/null || \
  fail 'the quarantined merge was not recorded in the merge record and ledger snapshot'
cp "$WORK/original-proof.txt" "$TARGET/reports/request-1.txt"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null
jq -e '.bugs[0].status == "confirmed" and (.bugs[0] | has("quarantine") | not)' "$TARGET/solution/bug-ledger.json" >/dev/null || fail 'restored evidence did not restore the submitted confirmed status'
# Tampering with an immutable fragment, the ledger's or a finding-evidence contribution, still aborts the merge.
for tampered in "$(jq -r .path <<<"$ledger_fragment")" "$(jq -r .path <<<"$evidence_fragment")"; do
  cp "$TARGET/$tampered" "$WORK/tampered-original"
  printf ' ' >>"$TARGET/$tampered"
  if "$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >"$WORK/tampered.out" 2>&1; then
    fail "bug-ledger merge accepted a tampered fragment $tampered"
  fi
  grep -Fq 'digest drift' "$WORK/tampered.out" || fail "tampered fragment $tampered did not fail with digest drift"
  cp "$WORK/tampered-original" "$TARGET/$tampered"
done
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/bug-ledger.json >/dev/null

# Minos's markdown ledgers are latest-revision canonicals: only the owner writes numbered
# revisions and the merge publishes the highest one.
printf '# Bug ledger\n\nRevision one.\n' >"$WORK/ledger-r1.md"
printf '# Bug ledger\n\nRevision two.\n' >"$WORK/ledger-r2.md"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/BUG-LEDGER.md --id ledger-r1 --input "$WORK/ledger-r1.md" | jq -e '.revision == 1' >/dev/null || fail 'the first markdown ledger revision is not revision 1'
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/BUG-LEDGER.md --id ledger-r2 --input "$WORK/ledger-r2.md" | jq -e '.revision == 2' >/dev/null || fail 'the second markdown ledger revision is not revision 2'
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/BUG-LEDGER.md --id ledger-r1 --input "$WORK/ledger-r1.md" | jq -e '.revision == 1' >/dev/null || fail 'an idempotent revision replay minted a new revision'
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/BUG-LEDGER.md --id foreign-ledger --input "$WORK/ledger-r1.md" >"$WORK/foreign-ledger.out" 2>&1; then
  fail 'a non-owner wrote a latest-revision ledger fragment'
fi
grep -Fq 'solution/BUG-LEDGER.md revisions are written only by minos' "$WORK/foreign-ledger.out" || fail 'the non-owner ledger revision was not rejected by the owner rule'
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/BUG-LEDGER.md >/dev/null
cmp -s "$WORK/ledger-r2.md" "$TARGET/solution/BUG-LEDGER.md" || fail 'the markdown ledger merge did not publish only the latest revision'
"$CLI" engagement status --manifest "$MANIFEST" | jq -e '.merges["solution/BUG-LEDGER.md"] | .revision == 2 and .supersededFragments == 1 and .fragments == 2' >/dev/null || \
  fail 'the markdown ledger merge record does not name its revision'
# Atlas revises the runner as lanes are wired: run-tests.sh is a latest-revision, executable
# text canonical, so its merge publishes only the newest revision, mode 0700, runnable as
# ./run-tests.sh, and only Atlas submits revisions.
printf '#!/usr/bin/env bash\necho skeleton-runner\n' >"$WORK/run-tests-r1.sh"
printf '#!/usr/bin/env bash\necho wired-runner\n' >"$WORK/run-tests-r2.sh"
for revision in r1 r2; do
  "$CLI" engagement fragment --manifest "$MANIFEST" --lane atlas --token "$ATLAS" --canonical run-tests.sh --id "runner-$revision" --input "$WORK/run-tests-$revision.sh" >/dev/null
done
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical run-tests.sh --id foreign-runner --input "$WORK/run-tests-r1.sh" >"$WORK/foreign-runner.out" 2>&1; then
  fail 'a non-owner wrote a runner revision'
fi
grep -Fq 'run-tests.sh revisions are written only by atlas' "$WORK/foreign-runner.out" || fail "the non-owner runner revision failed for another reason: $(<"$WORK/foreign-runner.out")"
"$CLI" engagement merge --manifest "$MANIFEST" --owner atlas --token "$ATLAS" --canonical run-tests.sh >/dev/null
cmp -s "$WORK/run-tests-r2.sh" "$TARGET/run-tests.sh" || fail 'the runner merge did not publish only its latest revision'
[ -n "$(find "$TARGET/run-tests.sh" -maxdepth 0 -type f -perm 700 -print)" ] || fail 'the merged runner is not owner-executable mode 0700'
[ "$(cd "$TARGET" && ./run-tests.sh)" = wired-runner ] || fail 'the merged runner does not run as ./run-tests.sh'
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$MINOS" --canonical solution/BUG-LEDGER.md >/dev/null
[ -n "$(find "$TARGET/solution/BUG-LEDGER.md" -maxdepth 0 -type f -perm 600 -print)" ] || fail 'a non-executable canonical is not published mode 0600'
node --input-type=module - "$ROOT/argus/runtime/engagement.mjs" "$MANIFEST" <<'NODE'
import { readFileSync } from 'node:fs';
const [runtime, manifestPath] = process.argv.slice(2);
const { validateEngagementManifest } = await import(runtime);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const withMerge = (path, merge) => {
  const copy = structuredClone(manifest);
  copy.writePolicy.canonicalArtifacts.find(item => item.path === path).merge = merge;
  return validateEngagementManifest(copy);
};
const withExecutable = (path, executable) => {
  const copy = structuredClone(manifest);
  copy.writePolicy.canonicalArtifacts.find(item => item.path === path).executable = executable;
  return validateEngagementManifest(copy);
};
if (validateEngagementManifest(manifest).length) throw new Error('the initialized manifest is invalid');
const runner = manifest.writePolicy.canonicalArtifacts.find(item => item.path === 'run-tests.sh');
if (runner?.merge !== 'latest-revision' || runner.executable !== true || runner.format !== 'text') throw new Error(`the runner canonical is not a latest-revision executable text artifact: ${JSON.stringify(runner)}`);
if (!withMerge('solution/bug-ledger.json', 'latest-revision').includes('latest-revision merge is valid only for markdown and text artifacts')) throw new Error('a JSON canonical accepted latest-revision');
const executableError = 'canonical artifact executable is valid only as true on a text artifact';
if (!withExecutable('solution/BUG-LEDGER.md', true).includes(executableError)) throw new Error('a markdown canonical accepted executable');
if (!withExecutable('run-tests.sh', false).includes(executableError)) throw new Error('a non-true executable flag was accepted');
if (!withMerge('solution/BUG-LEDGER.md', 'append').includes('canonical artifact merge must be concatenate or latest-revision')) throw new Error('an unknown canonical merge mode was accepted');
if (withMerge('solution/TEST-STRATEGY.md', 'concatenate').length) throw new Error('an explicit concatenate merge was rejected');
NODE

# Binary evidence is registered only through the reviewer's own lane fragment, and Kleio's
# registry merge binds it to the collector's audited binary-evidence allow decision.
jq -e '.engagementId == "schema-fixture"' "$TARGET/ai_agents_internal/authorization.json" >/dev/null || fail 'preflight did not bind the authorization manifest to the engagement'
mkdir -p "$TARGET/reports/evidence"
node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"))' "$TARGET/reports/evidence/shot.png" \
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
AUDIT_AT="$(node -e 'process.stdout.write(new Date(Date.now() - 2000).toISOString())')"
node --input-type=module - "$WORK/evidence-source.json" "$TARGET" "$AUDIT_AT" "$WORK/evidence-shot.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [input, target, auditAt, output] = process.argv.slice(2);
const document = JSON.parse(readFileSync(input));
const shot = document.references.find(ref => ref.kind === 'screenshot');
if (shot?.id !== 'EVD-0003' || shot.collectedBy !== 'atalanta' || shot.review?.reviewer !== 'minos' || shot.redaction !== 'masked') throw new Error('valid evidence fixture lost its reviewed screenshot');
shot.sha256 = createHash('sha256').update(readFileSync(join(target, shot.source))).digest('hex');
shot.capturedAt = new Date(Date.parse(auditAt) + 1000).toISOString();
shot.review = { ...shot.review, auditTimestamp: auditAt, reviewedAt: new Date(Date.parse(auditAt) + 1500).toISOString() };
writeFileSync(output, JSON.stringify({ ...document, engagementId: 'schema-fixture', references: [shot] }));
NODE
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane atalanta --token "$ATALANTA" --canonical solution/evidence-reference.json --id evidence-shot-collector --input "$WORK/evidence-shot.json" >"$WORK/shot-collector.out" 2>&1; then
  fail 'the collecting lane registered its own binary evidence'
fi
grep -Fq 'binary evidence EVD-0003 must be registered by its reviewer minos, not atalanta' "$WORK/shot-collector.out" || fail "collector-registered binary evidence was not refused by the reviewer rule: $(<"$WORK/shot-collector.out")"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/evidence-reference.json --id evidence-shot --input "$WORK/evidence-shot.json" >/dev/null
if "$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/evidence-reference.json >"$WORK/shot-merge.out" 2>&1; then
  fail 'binary evidence merged without an audited binary-evidence allow decision'
fi
grep -Fq 'evidence registry verification failed: binary evidence EVD-0003 has no allow binary-evidence audit event for atalanta' "$WORK/shot-merge.out" || fail "unaudited binary evidence failed for another reason: $(<"$WORK/shot-merge.out")"
jq -e '.references | map(.id) == ["EVD-0001", "EVD-0002"]' "$TARGET/solution/evidence-reference.json" >/dev/null || fail 'a refused evidence merge changed the canonical registry'
jq -nc --arg at "$AUDIT_AT" --arg target "$TARGET" '{schemaVersion: 1, timestamp: $at, engagementId: "schema-fixture", lane: "atalanta", action: "binary-evidence", decision: "allow", ruleId: "AUTH-ALLOW", reason: "explicit binary-evidence grant is valid", target: $target, resource: null, account: null, namespace: null, mutation: null, manifestSha256: ("0" * 64), sourceTrust: "user"}' \
  >>"$TARGET/ai_agents_internal/authorization-audit.jsonl"
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/evidence-reference.json >/dev/null || fail 'audited, reviewer-registered binary evidence did not merge'
jq -e '(.references | map(.id)) == ["EVD-0001", "EVD-0002", "EVD-0003"] and .references[2].review.reviewer == "minos" and .references[2].mediaType == "image/png"' \
  "$TARGET/solution/evidence-reference.json" >/dev/null || fail 'the merged registry does not carry the reviewed screenshot'


jq '.engagementId = "schema-fixture" | .tests = [.tests[1]]' "$FIXTURES/valid/automation-status.json" >"$WORK/automation-2.json"
jq '.engagementId = "schema-fixture" | .tests = [.tests[0]]' "$FIXTURES/valid/automation-status.json" >"$WORK/automation-1.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane daidalos --token "$DAIDALOS" --canonical solution/automation-status.json --id a-automation-2 --input "$WORK/automation-2.json" >/dev/null
automation_fragment="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/automation-status.json --id z-automation-1 --input "$WORK/automation-1.json")"
jq -e '."$schema" == "argus/automation-status@2" and .schemaVersion == 2' "$TARGET/$(jq -r .path <<<"$automation_fragment")" >/dev/null || fail 'automation-status fragment was not persisted as v2'
"$CLI" engagement merge --manifest "$MANIFEST" --owner atlas --token "$ATLAS" --canonical solution/automation-status.json >/dev/null
jq -e '.tests | map(.testId) == ["REG-0001", "TST-0002"]' "$TARGET/solution/automation-status.json" >/dev/null || fail 'automation fragments were not merged in deterministic test ID order'
# A test row belongs to its owner: another lane cannot write it, and the owner updates its status.
cp "$TARGET/solution/automation-status.json" "$WORK/automation-first.json"
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane daidalos --token "$DAIDALOS" --canonical solution/automation-status.json --id foreign-automation --input "$WORK/automation-1.json" >"$WORK/automation-foreign.out" 2>&1; then
  fail 'a lane wrote another lane automation test row'
fi
grep -Fq 'automation test REG-0001 belongs to talos; daidalos may write only its own records' "$WORK/automation-foreign.out" || fail "foreign automation row failed for another reason: $(<"$WORK/automation-foreign.out")"
jq '.tests[0] |= (.status = "implemented" | .updatedAt = "2026-07-10T00:05:00.000Z")' "$WORK/automation-1.json" >"$WORK/automation-1-implemented.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/automation-status.json --id a-automation-1-update --input "$WORK/automation-1-implemented.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner atlas --token "$ATLAS" --canonical solution/automation-status.json >/dev/null || fail 'an updated automation test row broke the automation-status merge'
jq -e '(.tests | map(.testId)) == ["REG-0001", "TST-0002"] and .tests[0].status == "implemented"' "$TARGET/solution/automation-status.json" >/dev/null || fail 'the later automation test row did not supersede the earlier one'
"$CLI" engagement fragment --manifest "$MANIFEST" --lane talos --token "$TALOS" --canonical solution/automation-status.json --id b-automation-1-passed --input "$WORK/automation-1.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner atlas --token "$ATLAS" --canonical solution/automation-status.json >/dev/null
cmp -s "$WORK/automation-first.json" "$TARGET/solution/automation-status.json" || fail 'the latest automation test row by write sequence was not merged'

# Aristarchus persists append-only review rounds bound to the test-corpus digest. The check gate
# exits 13 until the latest round APPROVEs the corpus exactly as it is now.
review_check() {
  local expected="$1" text="$2" code=0
  shift 2
  (cd "$TARGET" && "$CLI" automation-review check --manifest "$MANIFEST" "$@") >"$WORK/review-check.out" 2>&1 || code=$?
  [ "$code" -eq "$expected" ] || fail "automation-review check $* exited $code, expected $expected: $(<"$WORK/review-check.out")"
  grep -Fq -- "$text" "$WORK/review-check.out" || fail "automation-review check $* did not report '$text': $(<"$WORK/review-check.out")"
}
review_digest() { "$CLI" automation-review digest --manifest "$MANIFEST"; }
review_fragment() {
  "$CLI" engagement fragment --manifest "$MANIFEST" --lane aristarchus --token "$ARISTARCHUS" --canonical "$REVIEW_CANONICAL" --id "$1" --json "$(<"$2")" "${@:3}"
}
review_merge() { "$CLI" engagement merge --manifest "$MANIFEST" --owner aristarchus --token "$ARISTARCHUS" --canonical "$REVIEW_CANONICAL"; }
REVIEW_CANONICAL=solution/automation-review.json
REVIEW_GATE="$TARGET/reports/automation-review.gate"
review_check 13 "AUTOMATION-REVIEW ABSENT no merged $REVIEW_CANONICAL while aristarchus is dispatchable; re-review required"
mkdir -p "$TARGET/tests"
printf "test('order total', async () => { expect(await total()).toBe(42); });\n" >"$TARGET/tests/a.spec.ts"
printf '#!/usr/bin/env bash\nexec npx playwright test "$@"\n' >"$TARGET/run-tests.sh"
review_digest >"$WORK/review-digest-1.json"
node --input-type=module - "$TARGET" "$WORK/review-digest-1.json" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [target, digestPath] = process.argv.slice(2);
const digest = JSON.parse(readFileSync(digestPath, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lines = ['run-tests.sh', 'tests/a.spec.ts'].map((path) => `${path}\0${hash(readFileSync(join(target, path)))}\n`).sort();
if (digest.sha256 !== hash(lines.join('')) || digest.fileCount !== 2 || JSON.stringify(digest.roots) !== '["run-tests.sh","tests"]') {
  throw new Error(`automation-review digest does not hash the sorted path/sha256 lines: ${JSON.stringify(digest)}`);
}
NODE
# Dependency directories, root-level run output, and packaged-driver files never enter the
# corpus; a symbolic link fails closed.
mkdir -p "$TARGET/tests/node_modules/dep" "$TARGET/test-results" "$TARGET/scripts"
printf 'module.exports = 1;\n' >"$TARGET/tests/node_modules/dep/index.js"
printf 'run output\n' >"$TARGET/test-results/out.txt"
printf '// packaged driver\n' >"$TARGET/scripts/hunt-driver.mjs"
printf '{}\n' >"$TARGET/scripts/driver.config.json"
review_digest >"$WORK/review-digest-2.json"
jq -e --slurpfile first "$WORK/review-digest-1.json" '.sha256 == $first[0].sha256 and .fileCount == 2 and .roots == ["run-tests.sh", "scripts", "tests"]' \
  "$WORK/review-digest-2.json" >/dev/null || fail "excluded corpus paths changed the review digest: $(<"$WORK/review-digest-2.json")"
# Everything that decides what runs is corpus: specs below output-named test directories, root
# runner and dependency configuration, the target-owned runner declarations, and Maven test
# resources. Adding and then editing each one changes the digest.
for corpus_path in tests/api/reports/revenue.spec.ts tests/ui/build/pipeline.spec.ts playwright.config.ts package.json tsconfig.json \
  pyproject.toml conftest.py requirements.txt pom.xml solution/test-lanes.tsv solution/quarantine.tsv solution/counterfactual/BUG-0001.json \
  src/test/resources/junit-platform.properties; do
  review_digest >"$WORK/review-digest-before.json"
  mkdir -p "$(dirname "$TARGET/$corpus_path")"
  printf 'retries: 0\n' >"$TARGET/$corpus_path"
  review_digest >"$WORK/review-digest-added.json"
  printf 'retries: 3\n' >"$TARGET/$corpus_path"
  review_digest >"$WORK/review-digest-edited.json"
  jq -e --slurpfile before "$WORK/review-digest-before.json" --slurpfile added "$WORK/review-digest-added.json" \
    '.sha256 != $added[0].sha256 and $added[0].sha256 != $before[0].sha256 and .fileCount == $before[0].fileCount + 1' \
    "$WORK/review-digest-edited.json" >/dev/null || fail "the review corpus does not cover $corpus_path: $(<"$WORK/review-digest-edited.json")"
done
jq -e '.roots == ["conftest.py", "package.json", "playwright.config.ts", "pom.xml", "pyproject.toml", "requirements.txt", "run-tests.sh", "scripts",
  "solution/counterfactual", "solution/quarantine.tsv", "solution/test-lanes.tsv", "src/test/resources", "tests", "tsconfig.json"]' "$WORK/review-digest-edited.json" >/dev/null || \
  fail "the review corpus roots are wrong: $(<"$WORK/review-digest-edited.json")"
rm -rf "$TARGET/tests/api" "$TARGET/tests/ui" "$TARGET/playwright.config.ts" "$TARGET/package.json" "$TARGET/tsconfig.json" "$TARGET/pyproject.toml" \
  "$TARGET/conftest.py" "$TARGET/requirements.txt" "$TARGET/pom.xml" "$TARGET/solution/test-lanes.tsv" "$TARGET/solution/quarantine.tsv" \
  "$TARGET/solution/counterfactual" "$TARGET/src"
review_digest | jq -e --slurpfile first "$WORK/review-digest-1.json" '.sha256 == $first[0].sha256' >/dev/null || fail 'removing the added corpus files did not restore the review digest'
ln -s ../reports "$TARGET/tests/linked-reports"
if review_digest >"$WORK/review-digest-link.out" 2>&1; then fail 'automation-review digest followed a symbolic link inside the corpus'; fi
grep -Fq 'automation review corpus cannot contain a symbolic link: tests/linked-reports' "$WORK/review-digest-link.out" || fail "corpus symlink failed for another reason: $(<"$WORK/review-digest-link.out")"
rm "$TARGET/tests/linked-reports"

# Round 1 BLOCKs. Only Aristarchus submits the single document, inline through --json.
jq -c --argjson corpus "$(review_digest)" '.engagementId = "schema-fixture" | .reviews = [.reviews[0] | .corpus = $corpus]' \
  "$FIXTURES/valid/automation-review.json" >"$WORK/review-r1.json"
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical "$REVIEW_CANONICAL" --id foreign-review --json "$(<"$WORK/review-r1.json")" >"$WORK/review-foreign.out" 2>&1; then
  fail 'a non-owner submitted an automation review fragment'
fi
grep -Fq "$REVIEW_CANONICAL is a single-document contract; only aristarchus may submit fragments" "$WORK/review-foreign.out" || fail "foreign review fragment failed for another reason: $(<"$WORK/review-foreign.out")"
if review_fragment review-both "$WORK/review-r1.json" --input "$WORK/review-r1.json" >/dev/null 2>&1; then fail 'engagement fragment accepted both --json and --input'; fi
review_fragment review-r01 "$WORK/review-r1.json" >/dev/null
review_merge >/dev/null
review_check 13 'AUTOMATION-REVIEW BLOCKED review=REV-01 round=1 blockers=1 warnings=1; re-review required' --emit-gate reports/automation-review.gate
[ "$(<"$REVIEW_GATE")" = "$(printf 'verdict=BLOCKED\nreviewId=REV-01\ncorpusSha256=%s' "$(jq -r '.reviews[0].corpus.sha256' "$WORK/review-r1.json")")" ] || \
  fail "the BLOCK gate file is wrong: $(<"$REVIEW_GATE")"
review_check 13 '"status": "blocked"' --json
if (cd "$TARGET" && "$CLI" automation-review check --manifest "$MANIFEST" --emit-gate solution/bug-ledger.json) >"$WORK/review-gate-canonical.out" 2>&1; then
  fail 'the automation review gate overwrote a canonical artifact'
fi
grep -Fq 'GUARD-CANONICAL-SINGLE-WRITER' "$WORK/review-gate-canonical.out" || fail "canonical gate output was not refused by the write guard: $(<"$WORK/review-gate-canonical.out")"

# The lane repairs the blocker; the cumulative document appends an APPROVE REV-02 over the repaired corpus.
printf "test('order total rejects a wrong sum', async () => { expect(await total()).not.toBe(41); });\n" >>"$TARGET/tests/a.spec.ts"
review_check 13 'AUTOMATION-REVIEW BLOCKED review=REV-01'
jq -c --argjson corpus "$(review_digest)" --slurpfile fixture "$FIXTURES/valid/automation-review.json" \
  '.reviews += [$fixture[0].reviews[1] | .corpus = $corpus]' "$WORK/review-r1.json" >"$WORK/review-r2.json"
review_fragment review-r02 "$WORK/review-r2.json" >/dev/null
review_merge >/dev/null
jq -e --slurpfile submitted "$WORK/review-r2.json" '. == $submitted[0]' "$TARGET/$REVIEW_CANONICAL" >/dev/null || fail 'the merged review record is not the cumulative REV-02 document'
"$CLI" engagement status --manifest "$MANIFEST" | jq -e --arg path "$REVIEW_CANONICAL" '.merges[$path] | .effectiveFragment == "review-r02" and .supersededFragments == 1' >/dev/null || \
  fail 'the review merge record does not name the superseding round'
review_check 0 'AUTOMATION-REVIEW APPROVED review=REV-02 round=2 warnings=0' --emit-gate reports/automation-review.gate
grep -Fxq 'verdict=APPROVED' "$REVIEW_GATE" && grep -Fxq 'reviewId=REV-02' "$REVIEW_GATE" || fail "the APPROVE gate file is wrong: $(<"$REVIEW_GATE")"
# An approval is re-checked against the live corpus, so an unreadable corpus is invalid input.
ln -s ../reports "$TARGET/tests/linked-reports"
review_check 14 'automation review corpus cannot contain a symbolic link: tests/linked-reports'
rm "$TARGET/tests/linked-reports"

# Any corpus edit after the approval makes it STALE, and re-merging the stale round fails.
cp "$TARGET/tests/a.spec.ts" "$WORK/a.spec.ts.approved"
printf "test.skip('hidden', async () => {});\n" >>"$TARGET/tests/a.spec.ts"
review_check 13 'AUTOMATION-REVIEW STALE review=REV-02 round=2' --emit-gate reports/automation-review.gate
grep -Fq 're-review required' "$WORK/review-check.out" || fail 'the STALE status does not require a re-review'
grep -Fxq 'verdict=STALE' "$REVIEW_GATE" || fail "the STALE gate file is wrong: $(<"$REVIEW_GATE")"
if review_merge >"$WORK/review-stale-merge.out" 2>&1; then fail 'a review round merged against a changed test corpus'; fi
grep -Fq 'automation review REV-02 judged corpus' "$WORK/review-stale-merge.out" || fail "the stale merge failed for another reason: $(<"$WORK/review-stale-merge.out")"
cp "$WORK/a.spec.ts.approved" "$TARGET/tests/a.spec.ts"
review_check 0 'AUTOMATION-REVIEW APPROVED review=REV-02'

# Published rounds are append-only: a fragment that rewrites REV-01 is stored but never merges.
jq -c '.reviews[0].blockers[0].direction = "Accept the swallowed failure."' "$WORK/review-r2.json" >"$WORK/review-altered.json"
review_fragment review-r03 "$WORK/review-altered.json" >/dev/null
if review_merge >"$WORK/review-altered.out" 2>&1; then fail 'an automation review fragment that altered REV-01 merged'; fi
grep -Fq 'automation-review supersession altered REV-01' "$WORK/review-altered.out" || fail "the altered review failed for another reason: $(<"$WORK/review-altered.out")"
jq -e --slurpfile submitted "$WORK/review-r2.json" '. == $submitted[0]' "$TARGET/$REVIEW_CANONICAL" >/dev/null || fail 'a refused review merge changed the published record'
review_check 0 'AUTOMATION-REVIEW APPROVED review=REV-02'
printf '{"schemaVersion":' >"$WORK/broken-engagement.json"
code=0
"$CLI" automation-review check --manifest "$WORK/broken-engagement.json" >"$WORK/review-broken.out" 2>&1 || code=$?
[ "$code" -eq 14 ] || fail "automation-review check of a malformed manifest exited $code, expected 14: $(<"$WORK/review-broken.out")"
# Without a merged record the review is required exactly while Aristarchus is dispatchable.
node --input-type=module - "$ROOT/argus/runtime/engagement.mjs" "$MANIFEST" <<'NODE'
import { readFileSync } from 'node:fs';
const [runtime, manifestPath] = process.argv.slice(2);
const { automationReviewStatus } = await import(runtime);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const status = (dispatchableAgents) => automationReviewStatus(manifest, { dispatchableAgents, merges: {} }).status;
if (status(null) !== 'absent' || status(['aristarchus', 'odysseus']) !== 'absent') throw new Error('an unmerged review was not absent while Aristarchus is dispatchable');
if (status(['kleio', 'odysseus']) !== 'not-applicable') throw new Error('an unmerged review was required although Aristarchus is not dispatchable');
NODE

if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/final-summary.json --id foreign --input "$FIXTURES/valid/final-summary.json" >/dev/null 2>&1; then
  fail "cross-engagement canonical fragment unexpectedly passed"
fi
# The final summary reports a runner outcome only as registered runner-result evidence, so Atlas
# archives the run and registers it before Kleio's closeout merges.
cp "$FIXTURES/valid/runner-result.json" "$TARGET/reports/evidence/runner-result-full-suite.json"
jq -nc --arg sha "$(shasum -a 256 "$TARGET/reports/evidence/runner-result-full-suite.json" | cut -d' ' -f1)" --arg at "$(node -e 'process.stdout.write(new Date().toISOString())')" \
  '{"$schema": "argus/evidence-reference@3", schemaVersion: 3, engagementId: "schema-fixture", references: [{id: "EVD-0004", kind: "runner-result",
    mediaType: "application/json", source: "reports/evidence/runner-result-full-suite.json", collectedBy: "atlas", capturedAt: $at, redaction: "synthetic",
    sha256: $sha, relatedBugIds: [], relatedSurfaceIds: []}]}' >"$WORK/evidence-runner.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane atlas --token "$ATLAS" --canonical solution/evidence-reference.json --id evidence-runner --input "$WORK/evidence-runner.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/evidence-reference.json >/dev/null || fail 'the registered runner result did not merge'
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-result.json >/dev/null
jq -e '."$schema" == "argus/coverage-result@2" and (.sourceSchemas | length) == 4 and .surfaces[0].executed and .surfaces[0].asserted
  and .criticalUnexecuted == [] and .defectOutcomes.headline == 2 and .defectOutcomes.linked == 1 and .defectOutcomes.unlinked == ["BUG-0002"]' \
  "$TARGET/solution/coverage-result.json" >/dev/null || fail 'the merged coverage result does not derive execution and ledger outcomes'
jq -e '.overall.caseDepth.coverage == 0.5 and (.overall.caseDepth.gaps | length) == 1' "$TARGET/solution/coverage-result.json" >/dev/null || fail 'case depth overstated partial coverage'
cp "$TARGET/reports/runner.log" "$WORK/original-control.txt"
printf 'changed control proof' >"$TARGET/reports/runner.log"
if "$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-result.json >/dev/null 2>&1; then
  fail 'coverage merge accepted modified assertion-control evidence'
fi
cp "$WORK/original-control.txt" "$TARGET/reports/runner.log"

# Kleio's final summary: report-facts derives every fact from the merge-verified canonical inputs
# and the runner result, and the merge re-derives and overwrites them; it never raises a status.
SUMMARY_MD="$TARGET/solution/FINAL-SUMMARY.md"
summary_fragment() {
  "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/final-summary.json --id "$1" --input "$2" >/dev/null
}
summary_merge() { "$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/final-summary.json; }
cp "$FIXTURES/valid/runner-result.json" "$TARGET/reports/argus-runner-result.json"
"$CLI" engagement report-facts --manifest "$MANIFEST" >"$WORK/report-facts.json"
jq -e '.statusCeiling == "degraded" and .statusReasons == ["case-depth-gaps", "unresolved-proof-residuals"]
  and .counts.bugs == {confirmed: 1, suspected: 1, needsOracle: 1, bounced: 1, quarantined: 1, duplicate: 1, rejected: 1, headline: 2}
  and .counts.regression == {wired: 1, uncovered: []} and .counts.automated == 2 and .counts.evidence == 4
  and (.unproven | map([.id, .status, .missing])) == [["BUG-0002", "suspected", ["independent-reproduction"]], ["BUG-0003", "needs-oracle", ["oracle"]]]
  and (.residuals | map([.id, .status, .repairRound, .missing])) == [["BUG-0006", "bounced", 1, ["reproduction"]], ["BUG-0007", "quarantined", null, []]]
  and (.residuals[1].reasons | length) > 0
  and .automationReview == {status: "approved", reviewId: "REV-02", round: 2, blockers: 0, warnings: 0}
  and .runner.resultPath == "reports/argus-runner-result.json" and .runner.evidenceId == "EVD-0004" and .runner.exitCode == 0 and .runner.deliveryGate == true
  and .coverage.criticalUnexecuted == [] and .coverage.caseDepth.coverage == 0.5 and (.coverage.caseDepth.gaps | length) == 1
  and .sourceSchemas == ["argus/bug-ledger@2", "argus/evidence-reference@3", "argus/automation-status@2", "argus/runner-result@1", "argus/coverage-result@2", "argus/automation-review@1"]' \
  "$WORK/report-facts.json" >/dev/null || fail "report-facts did not derive the canonical facts: $(<"$WORK/report-facts.json")"
(cd "$TARGET" && "$CLI" engagement report-facts --manifest "$MANIFEST" --output reports/report-facts.json) >/dev/null
# A runner result whose bytes were never registered (hand-written or overwritten by a later run) is refused.
jq -c . "$FIXTURES/valid/runner-result.json" >"$TARGET/reports/argus-runner-result.json"
if "$CLI" engagement report-facts --manifest "$MANIFEST" >"$WORK/report-facts-unregistered.out" 2>&1; then fail 'report-facts accepted an unregistered runner result'; fi
grep -Fq 'reports/argus-runner-result.json (sha256 ' "$WORK/report-facts-unregistered.out" && grep -Fq 'is not registered runner-result evidence' "$WORK/report-facts-unregistered.out" || \
  fail "an unregistered runner result failed for another reason: $(<"$WORK/report-facts-unregistered.out")"
cp "$FIXTURES/valid/runner-result.json" "$TARGET/reports/argus-runner-result.json"
cmp -s "$WORK/report-facts.json" "$TARGET/reports/report-facts.json" || fail 'report-facts --output wrote different facts than stdout'
# Fragment validation needs the complete document, so Kleio's prompt carries the recipe used
# below; a narrative-only fragment and a completed one with copied status reasons are refused.
KLEIO_PROMPT="$ROOT/argus/roles/kleio.md"
# shellcheck disable=SC2016 # The marker quotes literal Markdown code spans.
grep -Fq 'copy every field except `statusCeiling`, set `status` to its `statusCeiling`' "$KLEIO_PROMPT" || \
  fail 'Kleio is not told to build her final-summary fragment from every report-facts field and its status ceiling'
if grep -Fq 'supplies only the narrative' "$KLEIO_PROMPT"; then fail 'Kleio is still told her final-summary fragment is narrative-only'; fi
jq '{"$schema", schemaVersion, engagementId, owner, status, summary, generatedAt}' "$FIXTURES/valid/final-summary.json" >"$WORK/final-summary-narrative.json"
jq --slurpfile facts "$WORK/report-facts.json" '. + ($facts[0] | del(.statusCeiling)) | .status = "completed"' \
  "$FIXTURES/valid/final-summary.json" >"$WORK/final-summary-completed.json"
for partial in narrative completed; do
  if "$CLI" schema validate --kind final-summary --input "$WORK/final-summary-$partial.json" >/dev/null 2>&1; then
    fail "a $partial final-summary fragment passed validation"
  fi
done
jq --slurpfile facts "$WORK/report-facts.json" '.engagementId = "schema-fixture" | . + ($facts[0] | del(.statusCeiling)) | .status = $facts[0].statusCeiling' \
  "$FIXTURES/valid/final-summary.json" >"$WORK/final-summary.json"
summary_fragment summary "$WORK/final-summary.json"
summary_merge >/dev/null
grep -Fq 'Source schema: argus/final-summary@2' "$SUMMARY_MD" || fail "rendered summary has no source schema"
grep -Fxq 'Status: degraded' "$SUMMARY_MD" && grep -Fxq 'Status reason: case-depth-gaps' "$SUMMARY_MD" || fail 'rendered summary does not name its status reason'
grep -Fxq 'Status reason: unresolved-proof-residuals' "$SUMMARY_MD" || fail 'rendered summary does not name its unresolved proof residuals'
grep -Fxq -- '- Defect headline (confirmed + suspected): 2' "$SUMMARY_MD" || fail 'rendered summary has no confirmed + suspected headline'
grep -Fxq -- '- Confirmed with verified regression: 1 (uncovered: none)' "$SUMMARY_MD" || fail 'rendered summary has no regression coverage line'
grep -Fxq '## Likely, unproven' "$SUMMARY_MD" || fail 'rendered summary has no Likely, unproven section'
grep -Fxq -- '- BUG-0002 (Major, suspected): Cart total accepts a negative quantity — would be confirmed by: independent-reproduction — An independent reproduction from fresh synthetic accounts would confirm it.' "$SUMMARY_MD" || \
  fail 'rendered summary dropped the suspected finding'
grep -Fq -- '- BUG-0003 (Minor, needs-oracle): Order total rounds half-cent amounts down — would be confirmed by: oracle' "$SUMMARY_MD" || fail 'rendered summary dropped the needs-oracle finding'
grep -Fxq -- '- Bounced: 1' "$SUMMARY_MD" && grep -Fxq -- '- Quarantined: 1' "$SUMMARY_MD" || fail 'rendered summary does not count the bounced and quarantined findings'
grep -Fxq '## Unresolved proof residuals' "$SUMMARY_MD" || fail 'rendered summary has no Unresolved proof residuals section'
grep -Fxq -- '- BUG-0006 (Major, bounced): Coupon applies twice after a retried checkout — repair round 1 — missing: reproduction' "$SUMMARY_MD" || \
  fail 'rendered summary dropped the bounced proof residual'
grep -Fq -- '- BUG-0007 (Minor, quarantined): Order history omits cancelled orders — reasons: ' "$SUMMARY_MD" || fail 'rendered summary dropped the quarantined proof residual'
grep -Fq 'APPROVE (REV-02' "$SUMMARY_MD" || fail 'rendered summary has no automation review verdict'
grep -Fxq -- '- Result: reports/argus-runner-result.json (registered evidence EVD-0004)' "$SUMMARY_MD" || fail 'rendered summary does not cite the registered runner evidence'
grep -Fq 'Required-case depth: 50%' "$SUMMARY_MD" || fail "rendered summary has no surface-derived coverage"
grep -Fxq -- '- Automated re-execution: 0%' "$SUMMARY_MD" || fail 'rendered summary has no automated re-execution ratio'
jq -e '.status == "degraded" and .statusReasons == ["case-depth-gaps", "unresolved-proof-residuals"]' "$TARGET/solution/final-summary.json" >/dev/null || fail 'the merged summary is not degraded by case-depth gaps and proof residuals'

# An internally consistent but inflated, completed fragment supersedes the first one and merges
# to the derived facts; only the narrative is Kleio's.
jq -c '.counts.bugs = {confirmed: 9, suspected: 0, needsOracle: 2, bounced: 0, quarantined: 0, duplicate: 0, rejected: 0, headline: 9} | .counts.regression = {wired: 9, uncovered: []}
  | .residuals = []
  | .counts.automated = 40 | .counts.evidence = 99 | .unproven |= map(.status = "needs-oracle") | .coverage.executionCoverage = 1
  | .coverage.caseDepth = {plannedWeight: 10, executedWeight: 10, verifiedWeight: 10, coverage: 1, unplannedSurfaces: [], gaps: []}
  | .automationReview = {status: "not-applicable", reviewId: null, round: null, blockers: 0, warnings: 0}
  | .runner.categories.product = 0 | .status = "completed" | .statusReasons = [] | .summary = "A corrected narrative."' \
  "$WORK/final-summary.json" >"$WORK/final-summary-inflated.json"
"$CLI" schema validate --kind final-summary --input "$WORK/final-summary-inflated.json" >/dev/null || fail 'the inflated fixture is not a self-consistent final summary'
summary_fragment summary-inflated "$WORK/final-summary-inflated.json"
summary_merge >/dev/null
jq -e --slurpfile facts "$WORK/report-facts.json" '.counts == $facts[0].counts and .unproven == $facts[0].unproven and .residuals == $facts[0].residuals and .coverage == $facts[0].coverage
  and .runner == $facts[0].runner and .automationReview == $facts[0].automationReview and .sourceSchemas == $facts[0].sourceSchemas
  and .status == "degraded" and .statusReasons == ["case-depth-gaps", "unresolved-proof-residuals"] and .summary == "A corrected narrative."' \
  "$TARGET/solution/final-summary.json" >/dev/null || fail "an inflated fragment overstated the merged summary: $(<"$TARGET/solution/final-summary.json")"
"$CLI" engagement status --manifest "$MANIFEST" | jq -e '.merges["solution/final-summary.json"].effectiveFragment == "summary-inflated"' >/dev/null || \
  fail 'the final-summary merge did not publish the superseding narrative'

# The runner outcome is read, never declared: a missing runner result or an unfunded claim in Mode A fails.
mv "$TARGET/reports/argus-runner-result.json" "$WORK/runner-result.moved.json"
if summary_merge >"$WORK/summary-no-runner.out" 2>&1; then fail 'the final summary merged without its runner result'; fi
grep -Fq 'final summary runner outcome requires reports/argus-runner-result.json' "$WORK/summary-no-runner.out" || fail "missing runner result failed for another reason: $(<"$WORK/summary-no-runner.out")"
"$CLI" engagement report-facts --manifest "$MANIFEST" | jq -e '.runner == null' >/dev/null || fail 'report-facts invented a runner outcome without a runner result'
mv "$WORK/runner-result.moved.json" "$TARGET/reports/argus-runner-result.json"
jq -c '.runner = null' "$WORK/final-summary.json" >"$WORK/final-summary-unfunded.json"
summary_fragment summary-unfunded "$WORK/final-summary-unfunded.json"
if summary_merge >"$WORK/summary-unfunded.out" 2>&1; then fail 'a Mode A final summary merged without a runner outcome'; fi
grep -Fq 'runner=null is only valid for Mode B without automation' "$WORK/summary-unfunded.out" || fail "unfunded Mode A summary failed for another reason: $(<"$WORK/summary-unfunded.out")"
summary_fragment summary-restored "$WORK/final-summary.json"

# A test-corpus edit after the approval makes the review STALE, and re-merging caps the summary at blocked.
cp "$TARGET/tests/a.spec.ts" "$WORK/a.spec.ts.summary"
printf "test('late edit', async () => { expect(await total()).toBe(42); });\n" >>"$TARGET/tests/a.spec.ts"
summary_merge >/dev/null
jq -e '.status == "blocked" and .statusReasons == ["automation-review-stale", "case-depth-gaps", "unresolved-proof-residuals"] and .automationReview.status == "stale"' \
  "$TARGET/solution/final-summary.json" >/dev/null || fail "a stale automation review did not block the final summary: $(<"$TARGET/solution/final-summary.json")"
grep -Fxq 'Status reason: automation-review-stale' "$SUMMARY_MD" && grep -Fq 'STALE (REV-02' "$SUMMARY_MD" || fail 'the rendered summary does not report the stale review'
cp "$WORK/a.spec.ts.summary" "$TARGET/tests/a.spec.ts"
summary_merge >/dev/null
jq -e '.status == "degraded" and .statusReasons == ["case-depth-gaps", "unresolved-proof-residuals"]' "$TARGET/solution/final-summary.json" >/dev/null || fail 'restoring the approved corpus did not re-derive the degraded summary'

# A coverage input that changes after the coverage merge makes the published coverage stale: a
# second discovery pass adds a critical surface, and the summary refuses until coverage re-merges.
jq -c '.discovery = {candidates: 2, characterized: 2} | .items += [.items[0] | .id = "SRF-UI-REPORTS" | .surfaceType = "ui" | .lane = "ui" | .obligations |= map(.id |= sub("^CASE-"; "CASE-REPORTS-"))]' "$WORK/inventory.json" >"$WORK/inventory-2.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --canonical solution/surface-inventory.json --id case-plan-2 --input "$WORK/inventory-2.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kalchas --token "$KALCHAS" --canonical solution/surface-inventory.json >/dev/null
if summary_merge >"$WORK/summary-stale-coverage.out" 2>&1; then fail 'the final summary merged a coverage result calculated before the inventory changed'; fi
grep -Fq 'solution/coverage-result.json is stale: solution/surface-inventory.json changed after it was merged' "$WORK/summary-stale-coverage.out" || \
  fail "stale coverage failed for another reason: $(<"$WORK/summary-stale-coverage.out")"
if "$CLI" engagement report-facts --manifest "$MANIFEST" >/dev/null 2>&1; then fail 'report-facts derived facts from a stale coverage result'; fi
(cd "$TARGET" && "$CLI" coverage calculate --inventory solution/surface-inventory.json --observations solution/coverage-observations.json \
  --evidence solution/evidence-reference.json --ledger solution/bug-ledger.json --automation-status solution/automation-status.json --root "$TARGET") >"$WORK/coverage-2.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/coverage-result.json --id case-result-2 --input "$WORK/coverage-2.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/coverage-result.json >/dev/null
summary_merge >/dev/null
jq -e '.coverage.criticalUnexecuted == ["SRF-UI-REPORTS"] and (.statusReasons | index("critical-surface-unexecuted")) != null' "$TARGET/solution/final-summary.json" >/dev/null || \
  fail "the re-merged coverage did not reach the final summary: $(<"$TARGET/solution/final-summary.json")"

printf 'PASS  Argus schemas: current fixtures, retired version rejection, deterministic collection merges, fragment rejection, per-bug ledger quarantine, latest-revision ledgers, append-only corpus-bound automation reviews, reviewer-registered audited binary evidence, stable IDs, runner results, and a source-versioned final summary whose facts and status ceiling are derived at merge\n'
