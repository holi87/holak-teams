#!/usr/bin/env bash
# Exercise the controller batch verbs end to end through the packaged CLI: one batch route
# selects the whole initial model-control set before the first allocation, and one batch
# allocate starts a wave of worker lanes against their sealed decisions. Refusals must be
# non-mutating, the write guard must accept both argv shapes only for the active manifest,
# and no issued lease or controller token may ever be persisted in the artifact root.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
WORK="$(mktemp -d)"
HOST="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOST"' EXIT

source "$ROOT/scripts/lib/argus-smoke-model-control.sh"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

guard_shell() {
  local command="$1" expected_rule="$2" output
  output="$(jq -nc --arg cwd "$TARGET" --arg command "$command" \
    '{tool_name:"Bash",cwd:$cwd,tool_input:{command:$command}}' | "$CLI" guard)"
  if [ "$expected_rule" = allow ]; then
    [ -z "$output" ] || fail "allowed Bash was denied: $command: $output"
  else
    grep -Fq "$expected_rule" <<<"$output" || fail "Bash did not return $expected_rule: $output"
  fi
}

TARGET="$WORK/target"
mkdir -p "$TARGET"
"$CLI" engagement init --target "$TARGET" --artifact-root "$TARGET" --mode A --engagement-id controller-batch-fixture >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
argus_smoke_prepare_model_control "$CLI" "$MANIFEST" "$TARGET" "$TARGET" A \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST" claude none
DECISIONS="$TARGET/ai_agents_internal/model-decisions"
PREFIX="wave0"

decision_count() {
  if [ -d "$DECISIONS" ]; then find "$DECISIONS" -maxdepth 1 -name 'MDR-*.json' | wc -l | tr -d ' '
  else printf '0'
  fi
}

batch_route() {
  "$CLI" model route --manifest "$MANIFEST" --agents "$1" --runtime claude --signal normal \
    --dispatch-prefix "${2:-$PREFIX}" --attempt 1
}

batch_allocate() {
  "$CLI" engagement allocate --manifest "$MANIFEST" --lanes "$1" --controller-token "$2"
}

lane_status() {
  "$CLI" engagement status --manifest "$MANIFEST" | jq -r --arg lane "$1" '.allocations[$lane].status // "none"'
}

# The write guard classifies both batch argv shapes as bounded controller mutations of the
# active engagement and refuses them for any other manifest.
guard_shell "argus-assets model route --manifest $MANIFEST --agents dispatchable --runtime claude --signal normal --dispatch-prefix $PREFIX --attempt 1" allow
guard_shell "argus-assets engagement allocate --manifest $MANIFEST --lanes kalchas,metis --controller-token 0000" allow
guard_shell "argus-assets model route --manifest $WORK/alternate-engagement.json --agents dispatchable --runtime claude --signal normal --dispatch-prefix $PREFIX --attempt 1" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets engagement allocate --manifest $WORK/alternate-engagement.json --lanes kalchas --controller-token 0000" GUARD-SHELL-AMBIGUOUS

# The expected initial set is Odysseus plus every selected lane the preflight report makes
# dispatchable. `conditional` is listed for the conditional-lane disposition, whose
# attempt-1 decisions are sealed before the first allocation as well.
PREFLIGHT="$TARGET/ai_agents_internal/preflight.json"
EXPECTED="$(jq -r '[.agents[] | select(.selected and (.status == "ready" or .status == "degraded" or .status == "conditional") and (.slug == "odysseus" or .dispatchAllowed == true)) | .slug] | length' "$PREFLIGHT")"
[ "$EXPECTED" -gt 3 ] || fail "the Mode A preflight fixture has only $EXPECTED dispatchable lanes"

# Batch route validates every option and agent before it persists any decision.
refuse_route() {
  local label="$1" expected="$2"
  shift 2
  if "$CLI" model route --manifest "$MANIFEST" --runtime claude "$@" >"$WORK/refused.out" 2>"$WORK/refused.err"; then
    fail "batch route accepted $label"
  fi
  grep -Fq "$expected" "$WORK/refused.err" || fail "batch route $label was not refused with '$expected': $(cat "$WORK/refused.err")"
  [ "$(decision_count)" = 0 ] || fail "a refused batch route ($label) persisted a decision"
}
refuse_route 'an unknown agent' 'nobody is not selected for engagement controller-batch-fixture' \
  --agents nobody --signal normal --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'an unknown agent after valid ones' 'nobody is not selected for engagement controller-batch-fixture' \
  --agents odysseus,kalchas,nobody --signal normal --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'duplicate agents' 'batch model route --agents contains duplicate agents' \
  --agents kalchas,kalchas --signal normal --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'a retry signal' 'batch model route is valid only for the initial --signal normal --attempt 1 set' \
  --agents dispatchable --signal turn-limit --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'a later attempt' 'batch model route is valid only for the initial --signal normal --attempt 1 set' \
  --agents dispatchable --signal normal --dispatch-prefix "$PREFIX" --attempt 2
refuse_route 'a single-lane --agent' 'batch model route does not accept --agent' \
  --agents dispatchable --agent kalchas --signal normal --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'a single-lane --dispatch-id' 'batch model route does not accept --dispatch-id' \
  --agents dispatchable --dispatch-id "$PREFIX-kalchas" --signal normal --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'a controller token' 'batch model route does not accept --controller-token' \
  --agents dispatchable --controller-token 0000 --signal normal --dispatch-prefix "$PREFIX" --attempt 1
refuse_route 'an unstable dispatch prefix' 'batch model route --dispatch-prefix must be a stable identifier' \
  --agents dispatchable --signal normal --dispatch-prefix '-wave' --attempt 1
refuse_route 'a missing dispatch prefix' 'batch model route requires --dispatch-prefix' \
  --agents dispatchable --signal normal --attempt 1
if "$CLI" model route --manifest "$MANIFEST" --agent kalchas --runtime claude --signal normal \
  --dispatch-id "$PREFIX-kalchas" --dispatch-prefix "$PREFIX" --attempt 1 >/dev/null 2>&1; then
  fail 'single-lane model route accepted --dispatch-prefix'
fi

# One batch call selects the complete initial set, Odysseus first.
batch_route dispatchable >"$WORK/route.json"
jq -e --argjson expected "$EXPECTED" --arg prefix "$PREFIX" '
  .schema == "argus/model-route-batch@1" and .runtime == "claude" and .dispatchPrefix == $prefix and
  (.decisions | length) == $expected and .decisions[0].agent == "odysseus" and
  all(.decisions[]; .status == "selected" and .reasonCode != null and .dispatchId == ($prefix + "-" + .agent) and
    (.decisionId | test("^MDR-[a-f0-9]{24}$")) and .relativePath == ("ai_agents_internal/model-decisions/" + .decisionId + ".json")) and
  ([.decisions[].agent] | length == (unique | length)) and
  ([.decisions[1:][].agent] == ([.decisions[1:][].agent] | sort))' \
  "$WORK/route.json" >/dev/null || fail "batch route did not select the dispatchable set odysseus-first: $(cat "$WORK/route.json")"
[ "$(decision_count)" = "$EXPECTED" ] || fail 'batch route persisted a different number of decisions than it reported'
while IFS=$'\t' read -r agent relative; do
  jq -e --arg agent "$agent" --arg dispatch "$PREFIX-$agent" \
    '.agent == $agent and .status == "selected" and .signal == "normal" and .attempt == 1 and .dispatchId == $dispatch and .runtime == "claude"' \
    "$TARGET/$relative" >/dev/null || fail "batch route persisted an inexact decision for $agent"
done < <(jq -r '.decisions[] | [.agent, .relativePath] | @tsv' "$WORK/route.json")

# An exact replay is idempotent; a different prefix cannot add a second initial decision.
batch_route dispatchable >"$WORK/replay.json"
[ "$(jq -c '[.decisions[] | [.agent, .decisionId]]' "$WORK/replay.json")" = "$(jq -c '[.decisions[] | [.agent, .decisionId]]' "$WORK/route.json")" ] || \
  fail 'a batch route replay returned different decision IDs'
batch_route odysseus,kalchas >"$WORK/subset.json"
jq -e --slurpfile full "$WORK/route.json" '
  [.decisions[].agent] == ["odysseus", "kalchas"] and
  all(.decisions[]; . as $d | $full[0].decisions | any(.agent == $d.agent and .decisionId == $d.decisionId))' \
  "$WORK/subset.json" >/dev/null || fail 'an explicit batch subset did not replay the persisted decisions'
if batch_route dispatchable wave1 >/dev/null 2>"$WORK/reprefix.err"; then
  fail 'batch route accepted a second initial set under a different dispatch prefix'
fi
grep -Fq 'a different selected normal attempt-1 decision already exists for this agent in the engagement' "$WORK/reprefix.err" || \
  fail "a re-prefixed batch route was not refused as a conflicting initial decision: $(cat "$WORK/reprefix.err")"
[ "$(decision_count)" = "$EXPECTED" ] || fail 'a refused re-prefixed batch route persisted a decision'

decision_for() { printf '%s/%s' "$TARGET" "$(jq -r --arg agent "$1" '.decisions[] | select(.agent == $agent) | .relativePath' "$WORK/route.json")"; }

# Batch allocation needs the sealed controller allocation first.
if batch_allocate kalchas 0000 >/dev/null 2>"$WORK/unsealed.err"; then
  fail 'batch allocate ran before the Odysseus allocation sealed the model-control set'
fi
grep -Fq 'engagement allocation requires the immutable initial model-control seal' "$WORK/unsealed.err" || \
  fail "unsealed batch allocate was not refused by the seal: $(cat "$WORK/unsealed.err")"

ODYSSEUS="$("$CLI" engagement allocate --manifest "$MANIFEST" --lane odysseus --decision "$(decision_for odysseus)" | jq -r .token)"
[[ "$ODYSSEUS" =~ ^[a-f0-9]{64}$ ]] || fail 'the Odysseus allocation did not return a 64-hex controller token'
jq -e --argjson expected "$EXPECTED" '(.decisions | length) == $expected' "$TARGET/ai_agents_internal/model-control-seal.json" >/dev/null || \
  fail 'the model-control seal does not bind every batch-routed decision'

# One batch allocate starts a wave of workers against their sealed decisions.
batch_allocate kalchas,metis,atlas "$ODYSSEUS" >"$WORK/wave.json"
jq -e '
  .schema == "argus/engagement-allocation-batch@1" and .failed == [] and
  ([.allocations[].lane] == ["kalchas", "metis", "atlas"]) and
  all(.allocations[]; .status == "active" and .resumed == false and (.token | test("^[a-f0-9]{64}$")) and .attempt == 1) and
  ([.allocations[].token] | unique | length) == 3' \
  "$WORK/wave.json" >/dev/null || fail "batch allocate did not return three distinct 64-hex lane tokens: $(jq -c 'del(.allocations[].token)' "$WORK/wave.json")"
for lane in kalchas metis atlas; do
  jq -e --arg lane "$lane" --arg decision "$(jq -r .decisionId "$(decision_for "$lane")")" \
    '.allocations[] | select(.lane == $lane) | .modelDecisionId == $decision' "$WORK/wave.json" >/dev/null || \
    fail "batch allocate bound $lane to a decision other than its sealed one"
done
KALCHAS="$(jq -r '.allocations[] | select(.lane == "kalchas") | .token' "$WORK/wave.json")"
METIS="$(jq -r '.allocations[] | select(.lane == "metis") | .token' "$WORK/wave.json")"
ATLAS="$(jq -r '.allocations[] | select(.lane == "atlas") | .token' "$WORK/wave.json")"
ISSUED_TOKENS=("$ODYSSEUS" "$KALCHAS" "$METIS" "$ATLAS")
for token in "$KALCHAS" "$METIS" "$ATLAS"; do
  [ "$token" != "$ODYSSEUS" ] || fail 'batch allocate returned the controller token as a lane token'
done

# Refusals are validated before any lane is allocated, so they never leave a partial wave.
refuse_allocate() {
  local label="$1" expected="$2"
  shift 2
  if "$CLI" engagement allocate --manifest "$MANIFEST" "$@" >"$WORK/refused.out" 2>"$WORK/refused.err"; then
    fail "batch allocate accepted $label"
  fi
  grep -Fq "$expected" "$WORK/refused.err" || fail "batch allocate $label was not refused with '$expected': $(cat "$WORK/refused.err")"
  [ "$(lane_status tiresias)" = none ] || fail "a refused batch allocate ($label) allocated tiresias"
}
refuse_allocate 'odysseus in the batch' 'batch engagement allocate cannot allocate odysseus' \
  --lanes tiresias,odysseus --controller-token "$ODYSSEUS"
refuse_allocate 'an already allocated lane' 'kalchas already has an active allocation' \
  --lanes tiresias,kalchas --controller-token "$ODYSSEUS"
refuse_allocate 'a missing controller token' 'batch engagement allocate requires --controller-token' \
  --lanes tiresias
refuse_allocate 'a worker token as controller token' 'batch engagement allocate requires the active Odysseus controller token' \
  --lanes tiresias --controller-token "$KALCHAS"
refuse_allocate 'an unselected lane' 'nobody is not selected for engagement controller-batch-fixture' \
  --lanes tiresias,nobody --controller-token "$ODYSSEUS"
refuse_allocate 'duplicate lanes' 'batch engagement allocate --lanes contains duplicate lanes' \
  --lanes tiresias,tiresias --controller-token "$ODYSSEUS"
refuse_allocate 'a single-lane --decision' 'batch engagement allocate does not accept --decision' \
  --lanes tiresias --decision "$(decision_for tiresias)" --controller-token "$ODYSSEUS"
refuse_allocate 'a resume --token' 'batch engagement allocate does not accept --token' \
  --lanes tiresias --token "$KALCHAS" --controller-token "$ODYSSEUS"

# Initial routing is closed once any allocation is active, with or without a replay.
if batch_route dispatchable >/dev/null 2>"$WORK/late-route.err"; then
  fail 'batch route ran after the first allocation'
fi
grep -Fq 'batch model route selects the initial set and must run before any allocation becomes active' "$WORK/late-route.err" || \
  fail "a late batch route was not refused: $(cat "$WORK/late-route.err")"
[ "$(decision_count)" = "$EXPECTED" ] || fail 'a refused late batch route persisted a decision'

# The allocated lanes stay usable with the tokens the batch returned.
for pair in "kalchas:$KALCHAS" "metis:$METIS" "atlas:$ATLAS"; do
  "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane "${pair%%:*}" --token "${pair#*:}" \
    --phase hunting --completed 1 --total 4 --status running >/dev/null || fail "${pair%%:*} rejected its batch-issued token"
done

"$CLI" engagement cleanup --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --outcome interrupted >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane metis --token "$METIS" --outcome interrupted >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane atlas --token "$ATLAS" --outcome interrupted >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane odysseus --token "$ODYSSEUS" --outcome interrupted >/dev/null
"$CLI" engagement status --manifest "$MANIFEST" >"$WORK/status.json"
jq -e '[.allocations.odysseus, .allocations.kalchas, .allocations.metis, .allocations.atlas] | all(.status == "released" and .outcome == "interrupted")' \
  "$WORK/status.json" >/dev/null || fail 'cleanup did not release every batch-allocated lane'

# No issued lease or controller token may exist anywhere in the worker-readable artifact root.
for token in "${ISSUED_TOKENS[@]}"; do
  if grep -rqF -- "$token" "$TARGET"; then
    fail 'an issued lease token was persisted under the artifact root'
  fi
done

printf 'PASS  Argus controller batch: one-call initial routing (odysseus first, idempotent, validated before persist), sealed per-wave batch allocation, non-mutating refusals, guard classification, and no persisted token\n'
