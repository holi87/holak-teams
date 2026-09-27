#!/usr/bin/env bash
# Exercise the controller batch verbs end to end through the packaged CLI: one batch route
# selects the whole initial model-control set before the first allocation, and one batch
# allocate starts a wave of worker lanes against their sealed decisions. Batched telemetry,
# barrier arrival, and cleanup then run on controller authority with inline single-line
# --json input, and a worker retry and escalation request need only the controller token.
# Refusals must be non-mutating, the write guard must accept every batch argv shape only for
# the active manifest and only with inline input, and no issued lease or controller token may
# ever be persisted in the artifact root.

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
# Controller-authorized batch arrival and cleanup take one inline single-line JSON object;
# file, stdin, and here-string input is refused before the command runs.
ARRIVE_GUARD_JSON='{"lanes":["kalchas","metis"]}'
CLEANUP_GUARD_JSON='{"cleanups":[{"lane":"kalchas","outcome":"interrupted"}]}'
guard_shell "argus-assets engagement barrier arrive --manifest $MANIFEST --phase discovery --json '$ARRIVE_GUARD_JSON' --controller-token 0000" allow
guard_shell "argus-assets engagement cleanup --manifest $MANIFEST --json '$CLEANUP_GUARD_JSON' --controller-token 0000" allow
guard_shell "argus-assets engagement cleanup --manifest $WORK/alternate-engagement.json --json '$CLEANUP_GUARD_JSON' --controller-token 0000" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets engagement cleanup --manifest $MANIFEST --json - --controller-token 0000" 'GUARD-SHELL-AMBIGUOUS: batch --json input must be one inline single-line JSON object'
guard_shell "argus-assets engagement cleanup --manifest $MANIFEST --json @reports/cleanups.json --controller-token 0000" 'GUARD-SHELL-AMBIGUOUS: batch --json input must be one inline single-line JSON object'
guard_shell "argus-assets engagement barrier arrive --manifest $MANIFEST --phase discovery --json '$ARRIVE_GUARD_JSON' --controller-token 0000 <<< ignored" 'GUARD-SHELL-AMBIGUOUS: batch input is inline only'
guard_shell "argus-assets engagement barrier arrive --manifest $MANIFEST --phase discovery --json '$ARRIVE_GUARD_JSON' --controller-token 0000 < reports/lanes.json" 'GUARD-SHELL-AMBIGUOUS: batch input is inline only'
guard_shell "printf '%s' '$CLEANUP_GUARD_JSON' | argus-assets engagement cleanup --manifest $MANIFEST --json - --controller-token 0000" GUARD-SHELL-AMBIGUOUS

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

# refuse <label> <expected stderr> <command...>: the command must fail with the expected message.
refuse() {
  local label="$1" expected="$2"
  shift 2
  if "$@" >"$WORK/refused.out" 2>"$WORK/refused.err"; then
    fail "$label was accepted"
  fi
  grep -Fq -- "$expected" "$WORK/refused.err" || fail "$label was not refused with '$expected': $(cat "$WORK/refused.err")"
}

TELEMETRY="$TARGET/ai_agents_internal/model-telemetry.jsonl"
telemetry_count() {
  if [ -f "$TELEMETRY" ]; then wc -l <"$TELEMETRY" | tr -d ' '
  else printf '0'
  fi
}
decision_id() { jq -r .decisionId "$(decision_for "$1")"; }
# telemetry_json <decision-id...>: one inline events object with fixed sanitized metrics.
telemetry_json() {
  jq -nc '{events: [$ARGS.positional[] | {decisionId: ., inputTokens: 1200, outputTokens: 300, durationMs: 4500, success: true}]}' --args "$@"
}
batch_telemetry() {
  "$CLI" model telemetry --manifest "$MANIFEST" --json "$1" --controller-token "$2"
}

# Batch telemetry is validated whole before anything is appended: closed keys with no token,
# unique decisions, the argv controller token, and inline single-line input.
K1="$(decision_id kalchas)"
M1="$(decision_id metis)"
A1="$(decision_id atlas)"
O1="$(decision_id odysseus)"
refuse 'batch telemetry with a token key' "batch model telemetry events[0] may not carry a token key" \
  batch_telemetry "{\"events\":[{\"decisionId\":\"$K1\",\"inputTokens\":1,\"outputTokens\":1,\"durationMs\":1,\"success\":true,\"token\":\"$KALCHAS\"}]}" "$ODYSSEUS"
refuse 'batch telemetry with a duplicate decision' "batch model telemetry decisionIds contains duplicate $K1" \
  batch_telemetry "$(telemetry_json "$K1" "$M1" "$K1")" "$ODYSSEUS"
refuse 'batch telemetry without a controller token' 'batch model telemetry requires --controller-token' \
  "$CLI" model telemetry --manifest "$MANIFEST" --json "$(telemetry_json "$K1")"
refuse 'batch telemetry with a worker token as controller token' 'batch model telemetry requires the active Odysseus controller token' \
  batch_telemetry "$(telemetry_json "$K1")" "$METIS"
refuse 'batch telemetry with --decision' 'model telemetry accepts exactly one of --decision or --json' \
  "$CLI" model telemetry --manifest "$MANIFEST" --decision "$(decision_for kalchas)" --json "$(telemetry_json "$K1")" --controller-token "$ODYSSEUS"
refuse 'batch telemetry with a multi-line object' 'batch model telemetry --json must be one inline single-line JSON object' \
  batch_telemetry "$(jq -n --arg id "$K1" '{events: [{decisionId: $id, inputTokens: 1, outputTokens: 1, durationMs: 1, success: true}]}')" "$ODYSSEUS"
refuse 'batch telemetry with an unknown key' 'batch model telemetry events[0] has unknown keys: prompt' \
  batch_telemetry "{\"events\":[{\"decisionId\":\"$K1\",\"inputTokens\":1,\"outputTokens\":1,\"durationMs\":1,\"success\":true,\"prompt\":\"x\"}]}" "$ODYSSEUS"
refuse 'batch telemetry above its bound' 'batch model telemetry --json events must list 1 to 64 entries' \
  batch_telemetry "$(jq -nc --arg id "$K1" '{events: [range(65) | {decisionId: $id, inputTokens: 1, outputTokens: 1, durationMs: 1, success: true}]}')" "$ODYSSEUS"
refuse 'batch telemetry with an unknown decision' 'model telemetry decision is missing' \
  batch_telemetry "$(telemetry_json "$K1" MDR-000000000000000000000000)" "$ODYSSEUS"
[ "$(telemetry_count)" = 0 ] || fail 'a refused telemetry batch appended an event'

# One batch records the three attempt-1 worker decisions; a replay or any overlap is refused
# whole, so the log keeps exactly one event per decision.
batch_telemetry "$(telemetry_json "$K1" "$M1" "$A1")" "$ODYSSEUS" >"$WORK/telemetry.out" || fail 'the telemetry batch was refused'
grep -Eq '^MODEL_TELEMETRY_BATCH  recorded output=[^ ]+ count=3 events=MDL-[a-f0-9]{24},MDL-[a-f0-9]{24},MDL-[a-f0-9]{24}$' "$WORK/telemetry.out" || \
  fail "the telemetry batch did not report three events: $(cat "$WORK/telemetry.out")"
[ "$(telemetry_count)" = 3 ] || fail 'the telemetry batch did not append exactly three lines'
jq -s -e --arg k "$K1" --arg m "$M1" --arg a "$A1" \
  'map(.decisionId) == [$k, $m, $a] and all(.[]; .schema == "argus/model-telemetry-event@3" and .attempt == 1 and .success == true and .totalTokens == 1500)' \
  "$TELEMETRY" >/dev/null || fail 'the telemetry batch appended inexact events'
refuse 'a replayed telemetry batch' "model telemetry already contains events for" \
  batch_telemetry "$(telemetry_json "$K1" "$M1" "$A1")" "$ODYSSEUS"
refuse 'a telemetry batch overlapping recorded decisions' "model telemetry already contains events for $K1" \
  batch_telemetry "$(telemetry_json "$O1" "$K1")" "$ODYSSEUS"
[ "$(telemetry_count)" = 3 ] || fail 'a refused telemetry replay changed the event count'

# Batch arrival records kalchas at the discovery barrier on controller authority; every lane
# is attempted, so an unallocated lane fails alone.
ARRIVE_JSON='{"lanes":["kalchas"]}'
refuse 'batch arrival with a worker token as controller token' 'batch engagement barrier arrive requires the active Odysseus controller token' \
  "$CLI" engagement barrier arrive --manifest "$MANIFEST" --phase discovery --json "$ARRIVE_JSON" --controller-token "$METIS"
refuse 'batch arrival with --lane' 'batch engagement barrier arrive does not accept --lane' \
  "$CLI" engagement barrier arrive --manifest "$MANIFEST" --lane kalchas --phase discovery --json "$ARRIVE_JSON" --controller-token "$ODYSSEUS"
refuse 'batch arrival with duplicate lanes' 'batch engagement barrier arrive lanes contains duplicate kalchas' \
  "$CLI" engagement barrier arrive --manifest "$MANIFEST" --phase discovery --json '{"lanes":["kalchas","kalchas"]}' --controller-token "$ODYSSEUS"
"$CLI" engagement barrier status --manifest "$MANIFEST" --phase discovery | jq -e '.arrived == []' >/dev/null || \
  fail 'a refused batch arrival recorded an arrival'
"$CLI" engagement barrier arrive --manifest "$MANIFEST" --phase discovery --json "$ARRIVE_JSON" --controller-token "$ODYSSEUS" >"$WORK/arrive.json" || \
  fail "the batch arrival was refused: $(cat "$WORK/arrive.json")"
jq -e '.schema == "argus/engagement-barrier-batch@1" and .phase == "discovery" and .failed == [] and
  .results == [{lane: "kalchas", authority: "controller", arrived: true}] and (.barrier.arrived | index("kalchas") != null)' \
  "$WORK/arrive.json" >/dev/null || fail "the batch arrival did not record kalchas: $(cat "$WORK/arrive.json")"
"$CLI" engagement barrier status --manifest "$MANIFEST" --phase discovery | jq -e '.arrived == ["kalchas"] and (.missing | index("kalchas") == null)' >/dev/null || \
  fail 'barrier status does not reflect the batch arrival of kalchas'
status=0
"$CLI" engagement barrier arrive --manifest "$MANIFEST" --phase discovery --json '{"lanes":["tiresias","metis"]}' --controller-token "$ODYSSEUS" >"$WORK/arrive-partial.json" || status=$?
[ "$status" -eq 1 ] || fail "a partially failed batch arrival exited $status instead of 1"
jq -e '.results == [{lane: "metis", authority: "controller", arrived: true}] and
  (.failed | length) == 1 and .failed[0].lane == "tiresias" and (.failed[0].error | contains("no active allocation exists for tiresias")) and
  .barrier.arrived == ["kalchas", "metis"]' \
  "$WORK/arrive-partial.json" >/dev/null || fail "a batch arrival did not attempt every lane independently: $(cat "$WORK/arrive-partial.json")"

# The controller routes a checkpoint-less kalchas restart and starts it without ever holding
# the kalchas token: start-attempt returns the rotated lane token to the controller.
"$CLI" model route --manifest "$MANIFEST" --agent kalchas --runtime claude --signal no-artifact \
  --dispatch-id "$PREFIX-kalchas" --attempt 2 --controller-token "$ODYSSEUS" >"$WORK/k2.json" || fail 'the controller no-artifact route did not select'
jq -e '.status == "selected" and .reasonCode == "AUTO_CONTINUE_SELECTED" and .continuation.kind == "fresh-restart"' "$WORK/k2.json" >/dev/null || \
  fail 'the controller no-artifact route was not an automatic fresh restart'
K2="$TARGET/$(jq -r .relativePath "$WORK/k2.json")"
refuse 'start-attempt without any token' 'engagement start-attempt requires --token or, for a worker lane, --controller-token' \
  "$CLI" engagement start-attempt --manifest "$MANIFEST" --lane kalchas --decision "$K2"
refuse 'start-attempt with a worker token as controller token' 'kalchas controller authority requires the active Odysseus controller token' \
  "$CLI" engagement start-attempt --manifest "$MANIFEST" --lane kalchas --decision "$K2" --controller-token "$METIS"
refuse 'start-attempt for odysseus without its own token' 'engagement start-attempt for odysseus requires --token' \
  "$CLI" engagement start-attempt --manifest "$MANIFEST" --lane odysseus --decision "$K2" --controller-token "$ODYSSEUS"
"$CLI" engagement start-attempt --manifest "$MANIFEST" --lane kalchas --decision "$K2" --controller-token "$ODYSSEUS" >"$WORK/k2-start.json" || \
  fail 'a controller-authorized start-attempt without --token was refused'
jq -e --arg decision "$(jq -r .decisionId "$WORK/k2.json")" \
  '.attemptStarted == true and .attempt == 2 and .previousAttempt == 1 and .authority == "controller" and .modelDecisionId == $decision' \
  "$WORK/k2-start.json" >/dev/null || fail 'start-attempt on controller authority did not rebind kalchas'
KALCHAS_NEXT="$(jq -r .token "$WORK/k2-start.json")"
[[ "$KALCHAS_NEXT" =~ ^[a-f0-9]{64}$ && "$KALCHAS_NEXT" != "$KALCHAS" ]] || fail 'start-attempt on controller authority did not return a new kalchas token'
ISSUED_TOKENS+=("$KALCHAS_NEXT")
if "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS" --phase hunting --completed 2 --total 4 --status running >/dev/null 2>&1; then
  fail 'the consumed kalchas token still authenticated after the controller rebind'
fi
"$CLI" engagement heartbeat --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS_NEXT" --phase hunting --completed 2 --total 4 --status running >/dev/null || \
  fail 'the rotated kalchas token was rejected'

# The controller may persist a worker's escalation envelope in place of the lane token.
printf '{"completedUnits":["SRF-API-ORDERS"],"nextUnit":"SRF-API-USERS"}\n' >"$WORK/metis-checkpoint.json"
METIS_CHECKPOINT="$("$CLI" engagement checkpoint --manifest "$MANIFEST" --lane metis --token "$METIS" --phase discovery \
  --sequence 0 --dispatch-id "$PREFIX-metis" --attempt 1 --input "$WORK/metis-checkpoint.json" | jq -r .path)"
request_metis() {
  "$CLI" model request --manifest "$MANIFEST" --agent "$1" --runtime claude --signal turn-limit \
    --dispatch-id "$PREFIX-$1" --attempt 2 --checkpoint-ref "$METIS_CHECKPOINT" "${@:2}"
}
refuse 'model request with both tokens' 'model request accepts --token or --controller-token, not both' \
  request_metis metis --token "$METIS" --controller-token "$ODYSSEUS"
refuse 'model request with a worker token as controller token' 'model request requires the active Odysseus controller token' \
  request_metis metis --controller-token "$ATLAS"
refuse 'model request for odysseus on the controller token' 'model request for odysseus requires its own --token' \
  request_metis odysseus --controller-token "$ODYSSEUS"
request_metis metis --controller-token "$ODYSSEUS" >"$WORK/metis-request.out" || fail 'a controller-authorized model request was refused'
grep -Eq '^MODEL_REQUEST  persisted path=[^ ]+/ai_agents_internal/model-requests/MER-[a-f0-9]{24}\.json sha256=[a-f0-9]{64}$' "$WORK/metis-request.out" || \
  fail "a controller-authorized model request did not persist its envelope: $(cat "$WORK/metis-request.out")"

# Terminal telemetry for the last attempts precedes cleanup; Odysseus's own decision may ride
# in the same batch because the controller token is its lane token.
batch_telemetry "$(telemetry_json "$O1" "$(jq -r .decisionId "$WORK/k2.json")")" "$ODYSSEUS" >/dev/null || fail 'the terminal telemetry batch was refused'
[ "$(telemetry_count)" = 5 ] || fail 'the terminal telemetry batch did not append exactly two more lines'

# Batch cleanup releases every worker on controller authority; Odysseus stays a single-lane
# cleanup on its own token, and a replay is idempotent.
cleanup_json() {
  jq -nc '{cleanups: [$ARGS.positional[] | {lane: ., outcome: "interrupted"}]}' --args "$@"
}
batch_cleanup() {
  "$CLI" engagement cleanup --manifest "$MANIFEST" --json "$1" --controller-token "$2"
}
refuse 'batch cleanup of odysseus' 'batch engagement cleanup cannot clean odysseus' \
  batch_cleanup "$(cleanup_json kalchas odysseus)" "$ODYSSEUS"
refuse 'batch cleanup with a worker token as controller token' 'batch engagement cleanup requires the active Odysseus controller token' \
  batch_cleanup "$(cleanup_json kalchas)" "$KALCHAS_NEXT"
refuse 'batch cleanup without a controller token' 'batch engagement cleanup requires --controller-token' \
  "$CLI" engagement cleanup --manifest "$MANIFEST" --json "$(cleanup_json kalchas)"
refuse 'batch cleanup with a token key' 'batch engagement cleanup cleanups[0] may not carry a leaseToken key' \
  batch_cleanup "{\"cleanups\":[{\"lane\":\"kalchas\",\"outcome\":\"interrupted\",\"leaseToken\":\"$KALCHAS_NEXT\"}]}" "$ODYSSEUS"
refuse 'batch cleanup with duplicate lanes' 'batch engagement cleanup lanes contains duplicate metis' \
  batch_cleanup "$(cleanup_json metis metis)" "$ODYSSEUS"
refuse 'batch cleanup with an unknown outcome' 'batch engagement cleanup cleanups[0].outcome must be success, failure, or interrupted' \
  batch_cleanup '{"cleanups":[{"lane":"kalchas","outcome":"abandoned"}]}' "$ODYSSEUS"
for lane in kalchas metis atlas; do
  [ "$(lane_status "$lane")" = active ] || fail "a refused batch cleanup released $lane"
done
batch_cleanup "$(cleanup_json kalchas metis atlas)" "$ODYSSEUS" >"$WORK/cleanup.json" || fail "the batch cleanup failed: $(cat "$WORK/cleanup.json")"
jq -e '.schema == "argus/engagement-cleanup-batch@1" and .failed == [] and ([.results[].lane] == ["kalchas", "metis", "atlas"]) and
  all(.results[]; .released == true and .outcome == "interrupted" and .authority == "controller" and .idempotent == null)' \
  "$WORK/cleanup.json" >/dev/null || fail "the batch cleanup did not release all three lanes: $(cat "$WORK/cleanup.json")"
batch_cleanup "$(cleanup_json kalchas metis atlas)" "$ODYSSEUS" >"$WORK/cleanup-replay.json" || fail 'a batch cleanup replay was refused'
jq -e '.failed == [] and all(.results[]; .released == true and .idempotent == true and .authority == "controller")' \
  "$WORK/cleanup-replay.json" >/dev/null || fail "a batch cleanup replay was not idempotent: $(cat "$WORK/cleanup-replay.json")"
status=0
batch_cleanup "$(cleanup_json tiresias kalchas)" "$ODYSSEUS" >"$WORK/cleanup-partial.json" || status=$?
[ "$status" -eq 1 ] || fail "a partially failed batch cleanup exited $status instead of 1"
jq -e '([.results[].lane] == ["kalchas"]) and .results[0].idempotent == true and
  .failed == [{lane: "tiresias", outcome: "interrupted", error: "no allocation exists for tiresias"}]' \
  "$WORK/cleanup-partial.json" >/dev/null || fail "a batch cleanup did not continue past a failed lane: $(cat "$WORK/cleanup-partial.json")"

"$CLI" engagement cleanup --manifest "$MANIFEST" --lane odysseus --token "$ODYSSEUS" --outcome interrupted >/dev/null
refuse 'batch cleanup after the controller was released' 'batch engagement cleanup requires the active Odysseus controller token' \
  batch_cleanup "$(cleanup_json kalchas)" "$ODYSSEUS"
"$CLI" engagement status --manifest "$MANIFEST" >"$WORK/status.json"
jq -e '[.allocations.odysseus, .allocations.kalchas, .allocations.metis, .allocations.atlas] | all(.status == "released" and .outcome == "interrupted")' \
  "$WORK/status.json" >/dev/null || fail 'cleanup did not release every batch-allocated lane'

# No issued lease or controller token may exist anywhere in the worker-readable artifact root.
for token in "${ISSUED_TOKENS[@]}"; do
  if grep -rqF -- "$token" "$TARGET"; then
    fail 'an issued lease token was persisted under the artifact root'
  fi
done

printf 'PASS  Argus controller batch: one-call initial routing (odysseus first, idempotent, validated before persist), sealed per-wave batch allocation, atomic inline telemetry batches, controller-authorized arrival, retry, escalation request, and cleanup batches, non-mutating refusals, guard classification, and no persisted token\n'
