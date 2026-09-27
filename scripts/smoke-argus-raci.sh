#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

jq empty "$ROOT/argus/raci.json" "$ROOT/argus/schemas/raci.schema.json"
node "$ROOT/scripts/sync-argus-raci.mjs" --check
node "$ROOT/scripts/sync-argus-runtime-assets.mjs" --check >/dev/null

[ "$(jq -r '.accountable' <<<"$($CLI raci route --surface event-protocol --activity discover)")" = proteus ] || fail 'event discovery did not route to Proteus'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --surface data-direct --activity automate)")" = mnemosyne ] || fail 'direct-data automation did not route to Mnemosyne'
[ "$(jq -r '.gate' <<<"$($CLI raci route --surface data-direct --activity discover)")" = db-access ] || fail 'direct-data route lost its DB gate'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --activity persist)")" = minos ] || fail 'canonical defect persistence did not route to Minos'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --artifact solution/STATE_MODEL.md)")" = ariadne ] || fail 'STATE_MODEL ownership did not route to Ariadne'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --transition defect:confirmed:automated)")" = atlas ] || fail 'defect automation transition did not route to Atlas'
# Aristarchus owns the persisted review record and its verdict transitions, yet stays without Write.
[ "$(jq -r '.accountable' <<<"$($CLI raci route --artifact solution/automation-review.json)")" = aristarchus ] || fail 'automation review ownership did not route to Aristarchus'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --transition automation-review:blocked:approved)")" = aristarchus ] || fail 'automation review re-approval did not route to Aristarchus'
jq -e '.agents[] | select(.slug == "aristarchus") | .persistence == "owned-artifact" and .accountableArtifacts == ["solution/automation-review.json"]' "$ROOT/argus/raci.json" >/dev/null || fail 'Aristarchus RACI does not own the automation review record'
jq -e '.agents[] | select(.slug == "aristarchus") | (.requiredTools | index("Write")) == null and (.artifactPaths | index("solution/automation-review.json")) != null' "$ROOT/argus/capabilities/capability-matrix.json" >/dev/null || fail 'Aristarchus capability contract gained Write or lost its review record path'
if grep -Eq '^tools: .*Write' "$ROOT/argus/claude/agents/aristarchus.md"; then fail 'Aristarchus unexpectedly has Write'; fi
if "$CLI" raci route --surface unknown --activity discover >/dev/null 2>&1; then fail 'unknown surface route was accepted'; fi

# Independent reproduction, proof repair and source-oracle routes, and plan-derived transitions.
reproduce="$($CLI raci route --surface api-rest --activity reproduce)"
[ "$(jq -r '.candidates[0]' <<<"$reproduce")" = ariadne ] || fail 'api-rest reproduction did not prefer Ariadne'
[ "$(jq -r '.accountable' <<<"$reproduce")" = minos ] || fail 'surface reproduction is not accountable to Minos'
jq -e '.selector == "surface" and .surface == "api-rest" and .activity == "reproduce" and .candidates == ["ariadne","perseus","talos"] and .gate == null' <<<"$reproduce" >/dev/null \
  || fail "api-rest reproduction route has the wrong shape: $reproduce"
jq -e '.candidates == [] and .accountable == "minos"' <<<"$($CLI raci route --surface resilience --activity reproduce)" >/dev/null \
  || fail 'resilience must route no independent reproducer'
[ "$(jq -r '.gate' <<<"$($CLI raci route --surface data-direct --activity reproduce)")" = db-access ] || fail 'direct-data reproduction lost its DB gate'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --activity repair)")" = odysseus ] || fail 'proof repair did not route to Odysseus'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --activity source-oracle)")" = metis ] || fail 'source oracle did not route to Metis'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --activity reproduce)")" = minos ] || fail 'defect reproduction activity did not route to Minos'
jq -e '.accountable == "minos" and .responsible == ["minos"]' <<<"$($CLI raci route --activity review-evidence)" >/dev/null || fail 'binary evidence review did not route to Minos'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --transition engagement:hunting:proof)")" = odysseus ] || fail 'hunting-to-proof transition did not route to Odysseus'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --transition engagement:deep-hunt-2:verification)")" = odysseus ] || fail 'Mode B deep-hunt skip exit did not route to Odysseus'
if "$CLI" raci route --transition engagement:hunting:automation >/dev/null 2>&1; then fail 'retired hunting-to-automation transition was accepted'; fi
[ "$(jq -r '.accountable' <<<"$($CLI raci route --transition defect:confirmed:quarantined)")" = minos ] || fail 'defect quarantine transition did not route to Minos'
activity_error="$("$CLI" raci route --surface api-rest --activity judge 2>&1 >/dev/null || true)"
grep -Fq 'report, or reproduce for a surface' <<<"$activity_error" || fail "surface activity error does not name reproduce: $activity_error"
routes="$("$CLI" raci list)"
grep -Eq $'^api-rest\t.*\treproduce=ariadne,perseus,talos$' <<<"$routes" || fail 'raci list does not print api-rest reproducers'
grep -Eq $'^source\t.*\treproduce=\tgate=source-access$' <<<"$routes" || fail 'raci list does not print an empty reproducer list before the gate'

# The generator derives engagement transitions from the orchestration plan and rejects drift.
RACI_CASE="$(mktemp -d)"
trap 'rm -rf "$RACI_CASE"' EXIT
mkdir -p "$RACI_CASE/scripts" "$RACI_CASE/argus/runtime" "$RACI_CASE/argus/schemas" "$RACI_CASE/argus/capabilities" "$RACI_CASE/argus/policies"
cp "$ROOT/scripts/sync-argus-raci.mjs" "$RACI_CASE/scripts/"
cp "$ROOT/argus/runtime/orchestration-plan.mjs" "$ROOT/argus/runtime/json-schema.mjs" "$RACI_CASE/argus/runtime/"
cp "$ROOT/argus/schemas/orchestration-plan.schema.json" "$RACI_CASE/argus/schemas/"
cp "$ROOT/argus/capabilities/capability-matrix.json" "$RACI_CASE/argus/capabilities/"
cp "$ROOT/argus/policies/engagement.template.json" "$RACI_CASE/argus/policies/"
cp "$ROOT/argus/orchestration-plan.json" "$ROOT/argus/RACI-CONTRACT.md" "$ROOT/argus/README.md" "$RACI_CASE/argus/"
expect_raci_failure() {
  local label="$1" expected="$2" filter="$3" output
  jq "$filter" "$ROOT/argus/raci.json" >"$RACI_CASE/argus/raci.json"
  if output="$(node "$RACI_CASE/scripts/sync-argus-raci.mjs" --check 2>&1)"; then fail "$label was accepted"; fi
  grep -Fq "$expected" <<<"$output" || fail "$label: expected '$expected', got: $output"
}
cp "$ROOT/argus/raci.json" "$RACI_CASE/argus/raci.json"
node "$RACI_CASE/scripts/sync-argus-raci.mjs" --check >/dev/null || fail 'isolated RACI generator case rejected the canonical contract'
expect_raci_failure 'stale engagement transition' 'stale engagement transition: engagement:hunting:automation' \
  '.stateTransitions += [{stateMachine: "engagement", from: "hunting", to: "automation", accountable: "odysseus"}]'
expect_raci_failure 'missing derived phase edge' 'missing canonical state transition: engagement:proof:automation' \
  '.stateTransitions |= map(select(.stateMachine != "engagement" or .from != "proof" or .to != "automation"))'
expect_raci_failure 'missing deep-hunt skip exit' 'missing canonical state transition: engagement:deep-hunt-3:verification' \
  '.stateTransitions |= map(select(.stateMachine != "engagement" or .from != "deep-hunt-3" or .to != "verification"))'
expect_raci_failure 'non-controller engagement transition' 'engagement:hunting:proof: engagement transitions must be accountable to odysseus' \
  '(.stateTransitions[] | select(.stateMachine == "engagement" and .from == "hunting" and .to == "proof") | .accountable) = "minos"'
expect_raci_failure 'missing quarantine transition' 'missing canonical state transition: defect:confirmed:quarantined' \
  '.stateTransitions |= map(select(.stateMachine != "defect" or .from != "confirmed" or .to != "quarantined"))'
expect_raci_failure 'missing automation review re-approval' 'missing canonical state transition: automation-review:blocked:approved' \
  '.stateTransitions |= map(select(.stateMachine != "automation-review" or .from != "blocked"))'
expect_raci_failure 'unowned automation review record' 'solution/automation-review.json: agent accountability is missing or inconsistent' \
  '(.agents[] | select(.slug == "aristarchus") | .accountableArtifacts) = []'
expect_raci_failure 'missing reproduce activity' 'defect lifecycle must define eleven unique activities' \
  '.defectLifecycle |= map(select(.activity != "reproduce"))'
expect_raci_failure 'discover owner as reproducer' 'api-rest: reproduce candidate atalanta is the surface discover owner' \
  '(.surfaceRoutes[] | select(.surface == "api-rest") | .reproduce) = ["atalanta"]'
expect_raci_failure 'unknown reproducer' 'api-rest: unknown reproduce candidate hydra' \
  '(.surfaceRoutes[] | select(.surface == "api-rest") | .reproduce) = ["hydra"]'
expect_raci_failure 'late reproducer' 'raci reproduce candidate aegis for security is not dispatched before the first proof phase' \
  '(.surfaceRoutes[] | select(.surface == "security") | .reproduce) = ["aegis"]'
expect_raci_failure 'missing reproduce list' 'journey-ui: reproduce must be an ordered list of candidates' \
  '(.surfaceRoutes[] | select(.surface == "journey-ui")) |= del(.reproduce)'

for file in "$ROOT/argus/claude/agents/atlas.md" "$ROOT/argus/codex/atlas.toml"; do
  grep -Fq '## Fourteen shared oracle helpers' "$file" || fail "Atlas helper heading is stale in $file"
  count="$(awk '/^## Fourteen shared oracle helpers/{inside=1; next} inside && /^Rules:/{inside=0} inside && /^\| `/{count++} END{print count+0}' "$file")"
  [ "$count" -eq 14 ] || fail "Atlas declares fourteen helpers but lists $count in $file"
done

grep -Eq '^tools: .*Write' "$ROOT/argus/claude/agents/tiresias.md" && fail 'Tiresias unexpectedly has Write'
grep -Fq 'Minos persists' "$ROOT/argus/claude/agents/tiresias.md" || fail 'Tiresias persistence handoff is missing'
grep -Fq 'Execute the engagement unless the user explicitly requests planning only.' "$ROOT/argus/shared-skills/orchestration-core/SKILL.md" || fail 'controller plan-versus-execute behavior is ambiguous'
grep -Fq '<!-- RACI_ROSTER_START -->' "$ROOT/argus/README.md" || fail 'README roster is not generated from RACI'

role_corpus=("$ROOT/argus/roles" "$ROOT/argus/claude/agents" "$ROOT/argus/codex")
for legacy in 'solution/discovery/system-map.md' 'solution/CODE-REVIEW.md'; do
  if rg -Fq "$legacy" "${role_corpus[@]}" "$ROOT/argus/claude/runtime-reference-inventory.json"; then
    fail "legacy non-RACI artifact path remains: $legacy"
  fi
done

arch_nonowners=(metis talos daidalos aegis mnemosyne nike kleio)
trace_nonowners=(metis talos daidalos aegis mnemosyne nike hermes tyche)
for slug in "${arch_nonowners[@]}"; do
  file="$ROOT/argus/roles/$slug.md"
  grep -Fq 'engagement fragment' "$file" || fail "$slug lacks Architecture fragment handoff"
  grep -Fq 'Atlas' "$file" || fail "$slug lacks Architecture owner route"
done
for slug in "${trace_nonowners[@]}"; do
  file="$ROOT/argus/roles/$slug.md"
  grep -Fq 'traceability' "$file" || fail "$slug lacks stable Traceability fragment"
  grep -Fq 'Kleio' "$file" || fail "$slug lacks Traceability owner route"
done
grep -Fq 'engagement merge --canonical solution/ARCHITECTURE.md' "$ROOT/argus/roles/atlas.md" || fail 'Atlas lacks deterministic Architecture owner merge'
grep -Fq 'engagement merge --canonical solution/TRACEABILITY.md' "$ROOT/argus/roles/kleio.md" || fail 'Kleio lacks deterministic Traceability owner merge'
grep -Fq 'solution/surface-inventory.json' "$ROOT/argus/roles/orion.md" || fail 'Orion does not consume Kalchas surface inventory'
grep -Fq 'result envelope' "$ROOT/argus/roles/aristarchus.md" || fail 'Aristarchus review is not a result envelope'

printf 'PASS  Argus RACI: runtime routing, single-owner artifacts/transitions, 27 descriptions, roster, and known contradiction regressions\n'
