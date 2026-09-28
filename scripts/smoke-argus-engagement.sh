#!/usr/bin/env bash
# Verify packaged target immutability and deterministic, resumable engagement coordination.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
WORK="$(mktemp -d)"
HOST="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOST"' EXIT

source "$ROOT/scripts/lib/argus-smoke-model-control.sh"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

# Exercise canonical runtime state migration and adversarial filesystem cases
# independently from the packaged CLI wiring checked below.
node "$ROOT/scripts/smoke-argus-engagement-state.mjs"
node "$ROOT/scripts/smoke-argus-evidence-ids.mjs"

token_for() {
  jq -r .token "$ALLOCATIONS/$1.json"
}

digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

guard_write() {
  local path="$1" expected_rule="$2" output
  output="$(jq -nc --arg cwd "$TARGET" --arg path "$path" \
    '{tool_name:"Write",cwd:$cwd,tool_input:{file_path:$path,content:"not audited"}}' | "$CLI" guard)"
  if [ "$expected_rule" = allow ]; then
    [ -z "$output" ] || fail "allowed Write was denied: $path: $output"
  else
    grep -Fq "$expected_rule" <<<"$output" || fail "Write $path did not return $expected_rule: $output"
  fi
}

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

# A PreToolUse payload as Claude Code writes it: a subagent carries agent_id and agent_type,
# "main" is the main thread (the controller) and carries neither, and "untyped" is a subagent
# without an agent_type. The optional fifth argument is the working directory.
guard_as() {
  local agent="$1" tool="$2" subject="$3" expected_rule="$4" cwd="${5:-$TARGET}" output
  output="$(jq -nc --arg agent "$agent" --arg tool "$tool" --arg subject "$subject" --arg cwd "$cwd" '
    {hook_event_name:"PreToolUse",session_id:"smoke-session",tool_name:$tool,cwd:$cwd,
     tool_input:(if $tool == "Bash" then {command:$subject} else {file_path:$subject,content:"not audited"} end)}
    + (if $agent == "main" then {} elif $agent == "untyped" then {agent_id:"smoke-untyped"}
       else {agent_id:("smoke-" + ($agent | gsub("[^a-z0-9-]"; "-"))),agent_type:$agent} end)' | "$CLI" guard)"
  if [ "$expected_rule" = allow ]; then
    [ -z "$output" ] || fail "allowed $tool by $agent was denied: $subject: $output"
  else
    grep -Fq "$expected_rule" <<<"$output" || fail "$tool $subject by $agent did not return $expected_rule: $output"
  fi
}

TARGET="$WORK/target"
ALLOCATIONS="$WORK/allocations"
mkdir -p "$TARGET/app" "$TARGET/tests" "$TARGET/reports" "$TARGET/solution" "$ALLOCATIONS"
printf 'application source\n' >"$TARGET/app/source.ts"
ln -s ../app "$TARGET/tests/symlink-app"

"$CLI" engagement init --target "$TARGET" --artifact-root "$TARGET" --mode A --engagement-id phase0-smoke >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
"$CLI" engagement validate --manifest "$MANIFEST" >/dev/null
argus_smoke_prepare_model_control "$CLI" "$MANIFEST" "$TARGET" "$TARGET" A \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST/main"

# A reclaimed lock leaves no lock directory, reclaim claim, or quarantine behind.
assert_lock_released() {
  local lock="$1" label="$2" leftover
  for leftover in "$lock" "$lock".*; do
    [ ! -e "$leftover" ] || fail "$label: ${leftover##*/} remains"
  done
}
DEAD_LOCK_OWNER='{"pid":2147483647,"acquiredAt":"2026-07-12T00:00:00.000Z"}'

# Parallel allocation is atomic and every resource coordinate is unique. The controller
# first meets an abandoned model-control lock that still holds the claim of a caller that
# lost a reclaim race; reclaim claims live beside a lock, so that claim cannot wedge it.
# The parallel workers then reclaim a lock whose owner died.
lanes=(odysseus kalchas metis tiresias minos tyche hermes atlas kleio)
CONTROL_LOCK="$TARGET/ai_agents_internal/model-decisions/.initial-control.lock"
mkdir -p "$CONTROL_LOCK/.reclaim"
printf '%s\n' "$DEAD_LOCK_OWNER" >"$CONTROL_LOCK/.reclaim/owner.json"
touch -t 202001010000 "$CONTROL_LOCK"
argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST/main" odysseus >"$ALLOCATIONS/odysseus.json" ||
  fail 'a reclaim claim left inside an abandoned model-control lock wedged the lock'
CONTROLLER_TOKEN="$(token_for odysseus)"
mkdir "$CONTROL_LOCK"
printf '%s\n' "$DEAD_LOCK_OWNER" >"$CONTROL_LOCK/owner.json"
pids=()
for lane in "${lanes[@]:1}"; do
  argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST/main" "$lane" "$CONTROLLER_TOKEN" >"$ALLOCATIONS/$lane.json" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail 'a parallel allocation failed'; done
assert_lock_released "$CONTROL_LOCK" 'parallel allocations did not safely reclaim the abandoned model-control lock'
for field in port accountAlias dataNamespace browserProfile outputDirectory; do
  count="$(jq -r ".$field" "$ALLOCATIONS"/*.json | sort -u | wc -l | tr -d ' ')"
  [ "$count" -eq "${#lanes[@]}" ] || fail "parallel allocations collide on $field"
done

# Heartbeats use a bounded append command; they are progress only, never evidence.
"$CLI" engagement heartbeat --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --phase discovery --completed 0 --total 4 --status started >/dev/null
"$CLI" engagement heartbeat --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --completed 1 --total 4 --status running >/dev/null
grep -Eq $'^[^\t]+\todysseus\tdiscovery\t0/4\tstarted\t[a-f0-9]{24}\t[^\t]+\t1$' "$TARGET/ai_agents_internal/heartbeat/odysseus.log" || fail 'controller heartbeat generation format drifted'
grep -Eq $'^[^\t]+\thermes\thunting\t1/4\trunning\t[a-f0-9]{24}\t[^\t]+\t1$' "$TARGET/ai_agents_internal/heartbeat/hermes.log" || fail 'worker heartbeat generation format drifted'
ln -s "$TARGET/app/source.ts" "$TARGET/ai_agents_internal/heartbeat/atlas.log"
if "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" --phase automation --completed 1 --total 4 --status running >/dev/null 2>&1; then
  fail 'heartbeat followed a symbolic-link log'
fi
grep -Fxq 'application source' "$TARGET/app/source.ts" || fail 'heartbeat modified a symbolic-link target'
rm "$TARGET/ai_agents_internal/heartbeat/atlas.log"
if "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --completed 5 --total 4 --status running >/dev/null 2>&1; then
  fail 'heartbeat accepted impossible progress'
fi

# Persisted allocation paths are derived from the manifest, never trusted from state.
STATE="$TARGET/ai_agents_internal/engagement-state.json"
cp "$STATE" "$WORK/engagement-state.clean.json"
mkdir -p "$WORK/state-poison-victim"
printf 'outside sentinel\n' >"$WORK/state-poison-victim/sentinel.txt"
for field in browserProfile browserArtifactsDirectory authDirectory temporaryDirectory outputDirectory; do
  jq --arg field "$field" --arg victim "$WORK/state-poison-victim" \
    'setpath(["allocations", "atlas", $field]; $victim)' "$WORK/engagement-state.clean.json" >"$STATE"
  if "$CLI" engagement cleanup --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" --outcome failure >/dev/null 2>&1; then
    fail "cleanup trusted poisoned allocation field: $field"
  fi
  test -f "$WORK/state-poison-victim/sentinel.txt" || fail "cleanup followed poisoned allocation field: $field"
done
cp "$WORK/engagement-state.clean.json" "$STATE"

# The derived plan names every discovery participant; the barrier waits for all of them.
jq -e '[.phasePlan[].id] == ["preflight","discovery","hunting","proof","deep-hunt-1","deep-proof-1","deep-hunt-2","deep-proof-2","deep-hunt-3","deep-proof-3","automation","verification","reporting","complete"]' \
  "$MANIFEST" >/dev/null || fail 'engagement init did not derive the Mode A phase plan'
jq -e '.schemaVersion == 3 and .skippedPhases == {} and .ledgerSnapshots == {}' "$TARGET/ai_agents_internal/engagement-state.json" >/dev/null \
  || fail 'engagement init did not create v3 state'
if "$CLI" engagement barrier advance --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" >/dev/null 2>&1; then
  fail "discovery barrier advanced before any participant arrived"
fi
"$CLI" engagement barrier arrive --manifest "$MANIFEST" --lane kalchas --token "$(token_for kalchas)" --phase discovery >/dev/null
if "$CLI" engagement barrier advance --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" >/dev/null 2>&1; then
  fail "discovery barrier advanced with only Kalchas arrived"
fi
for lane in metis tiresias atlas; do
  "$CLI" engagement barrier arrive --manifest "$MANIFEST" --lane "$lane" --token "$(token_for "$lane")" --phase discovery >/dev/null
done
"$CLI" engagement barrier advance --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" >/dev/null
[ "$("$CLI" engagement status --manifest "$MANIFEST" | jq -r .currentPhase)" = hunting ] || fail "phase did not advance to hunting"
# Only a skippable deep-hunt pass can start a recorded skip; hunting is never skippable.
if skip_output="$("$CLI" engagement barrier skip --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --reason converged 2>&1)"; then
  fail "hunting phase accepted a converged skip"
fi
grep -Fq 'phase hunting is not skippable' <<<"$skip_output" || fail "hunting skip failed for the wrong reason: $skip_output"
if skip_output="$("$CLI" engagement barrier skip --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" 2>&1)"; then
  fail "barrier skip ran without a reason"
fi
grep -Fq -- '--reason' <<<"$skip_output" || fail "reasonless skip failed for the wrong reason: $skip_output"
[ "$("$CLI" engagement status --manifest "$MANIFEST" | jq -r '.currentPhase + ":" + (.skippedPhases | length | tostring)')" = hunting:0 ] \
  || fail "refused skip changed the phase cursor or recorded a skip"
# The top-level help advertises every operation the barrier dispatcher accepts, and skip's reasons.
if barrier_usage="$("$CLI" engagement barrier unknown-operation --manifest "$MANIFEST" 2>&1)"; then
  fail "unknown barrier operation was accepted"
fi
barrier_operations="$(sed -nE 's/.*engagement barrier <([a-z|]+)>.*/\1/p' <<<"$barrier_usage")"
[ -n "$barrier_operations" ] || fail "barrier usage does not name its operations: $barrier_usage"
cli_help="$("$CLI" --help)"
grep -Fq -- "barrier $barrier_operations --manifest" <<<"$cli_help" || fail "argus-assets --help does not list barrier $barrier_operations"
grep -Fq -- '--reason converged|controller-budget' <<<"$cli_help" || fail "argus-assets --help does not document the barrier skip reasons"

# Reset/fault windows are owner-restricted and exclusive.
"$CLI" engagement claim --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --resource fault >/dev/null
if "$CLI" engagement claim --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" --resource fault >/dev/null 2>&1; then
  fail "non-owner acquired the fault window"
fi
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null

# Atomic canonical ID allocation remains unique under parallel callers.
mkdir -p "$WORK/ids"
mkdir "$STATE.lock"
touch -t 202001010000 "$STATE.lock"
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
"$CLI" engagement release --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
mkdir "$STATE.lock"
printf '{' >"$STATE.lock/owner.json"
touch -t 202001010000 "$STATE.lock"
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
"$CLI" engagement release --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
# A caller that lost a reclaim race cannot wedge the lock with a claim left inside it.
mkdir -p "$STATE.lock/.reclaim"
printf '%s\n' "$DEAD_LOCK_OWNER" >"$STATE.lock/.reclaim/owner.json"
touch -t 202001010000 "$STATE.lock"
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null ||
  fail 'a reclaim claim left inside an abandoned state lock wedged the lock'
"$CLI" engagement release --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
mkdir "$STATE.lock"
printf '%s\n' "$DEAD_LOCK_OWNER" >"$STATE.lock/owner.json"
pids=()
for index in $(seq 1 24); do
  "$CLI" engagement id --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" --kind bug --identity "finding-$index" >"$WORK/ids/$index" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail 'a parallel engagement id caller failed'; done
assert_lock_released "$STATE.lock" 'parallel callers did not safely reclaim the abandoned state lock'
[ "$(sort -u "$WORK"/ids/* | wc -l | tr -d ' ')" -eq 24 ] || fail "parallel bug IDs are not unique"
stable_id="$("$CLI" engagement id --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" --kind bug --identity finding-1)"
[ "$stable_id" = "$(cat "$WORK/ids/1")" ] || fail "stable identity did not deduplicate across resume"
grep -Fxq 'BUG-0001' "$WORK"/ids/* || fail "bug ID sequence did not start at BUG-0001"
grep -Fxq 'BUG-0024' "$WORK"/ids/* || fail "bug ID sequence did not reach BUG-0024"

# Every active lane uses a namespaced, replay-stable evidence allocator through the guarded CLI.
first_evidence="$("$CLI" engagement id --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --kind evidence --identity hermes:reports/capture.txt)"
[ "$first_evidence" = EVD-0001 ] || fail "evidence allocator did not start at EVD-0001"
[ "$("$CLI" engagement id --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --kind evidence --identity hermes:reports/capture.txt)" = "$first_evidence" ] || fail "evidence identity replay changed its ID"
[ "$("$CLI" engagement id --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --kind evidence --identity tyche:reports/capture.txt)" = EVD-0002 ] || fail "evidence IDs collided across lanes"
guard_as argus:hermes Bash "argus-assets engagement id --manifest $MANIFEST --lane hermes --token $(token_for hermes) --kind evidence --identity hermes:reports/capture.txt" allow

# Checkpoints are resumable and idempotent, but sequence/content conflicts fail closed.
printf '%s\n' '{"completed":["surface-a"],"next":"surface-b"}' >"$WORK/checkpoint-1.json"
printf '%s\n' '{"completed":["surface-a","surface-b"],"next":"surface-c"}' >"$WORK/checkpoint-2.json"
hermes_dispatch_id="$("$CLI" engagement status --manifest "$MANIFEST" | jq -r .allocations.hermes.dispatchId)"
"$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 1 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-1.json" >/dev/null
"$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 1 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-1.json" >/dev/null
if "$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 1 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-2.json" >/dev/null 2>&1; then
  fail "checkpoint sequence accepted conflicting content"
fi
"$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 2 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-2.json" >/dev/null
resumed="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST/main" hermes "$CONTROLLER_TOKEN" "$(token_for hermes)")"
[ "$(jq -r .resumed <<<"$resumed")" = true ] || fail "interrupted worker allocation did not resume"
[ "$(jq -r .token <<<"$resumed")" = "$(token_for hermes)" ] || fail "resumed worker lease changed"

# Workers create immutable fragments; only the canonical owner performs deterministic merge.
printf '# Strategy\n\nSecond fragment.\n' >"$WORK/fragment-20.md"
printf '# Strategy\n\nFirst fragment.\n' >"$WORK/fragment-10.md"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$(token_for kalchas)" \
  --canonical solution/TEST-STRATEGY.md --id 020-recon --input "$WORK/fragment-20.md" >/dev/null
"$CLI" engagement fragment --manifest "$MANIFEST" --lane metis --token "$(token_for metis)" \
  --canonical solution/TEST-STRATEGY.md --id 010-plan --input "$WORK/fragment-10.md" >/dev/null
if "$CLI" engagement merge --manifest "$MANIFEST" --owner kalchas --token "$(token_for kalchas)" \
  --canonical solution/TEST-STRATEGY.md >/dev/null 2>&1; then
  fail "non-owner merged a canonical artifact"
fi
"$CLI" engagement merge --manifest "$MANIFEST" --owner metis --token "$(token_for metis)" \
  --canonical solution/TEST-STRATEGY.md >/dev/null
first_digest="$(digest_file "$TARGET/solution/TEST-STRATEGY.md")"
"$CLI" engagement merge --manifest "$MANIFEST" --owner metis --token "$(token_for metis)" \
  --canonical solution/TEST-STRATEGY.md >/dev/null
second_digest="$(digest_file "$TARGET/solution/TEST-STRATEGY.md")"
[ "$first_digest" = "$second_digest" ] || fail "repeated canonical merge is not byte-stable"
[ "$(grep -n 'First fragment' "$TARGET/solution/TEST-STRATEGY.md" | cut -d: -f1)" -lt \
  "$(grep -n 'Second fragment' "$TARGET/solution/TEST-STRATEGY.md" | cut -d: -f1)" ] || fail "fragment merge order is not deterministic"
printf '%s\n' '{"$schema":"argus/bug-ledger@2","schemaVersion":2,"engagementId":"phase0-smoke","bugs":[]}' >"$WORK/ledger.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json --id complete-ledger --input "$WORK/ledger.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json >/dev/null
jq -e '."$schema" == "argus/bug-ledger@2" and .schemaVersion == 2 and .bugs == []' "$TARGET/solution/bug-ledger.json" >/dev/null || fail "canonical JSON document merge is invalid"

# Only the owner submits fragments to a single-document contract. A newer fragment supersedes
# the earlier one, keeps every earlier bug ID and origin, and alone reaches the canonical file.
jq -c '.bugs = [{id:"BUG-0001",origin:["HER-001"],title:"Order search echoes an unescaped query",severity:"Minor",priority:"P3",
  lane:"hermes",oracleId:"ORC-API-001",status:"suspected",wired:false,testId:null,evidenceIds:[],
  missingProof:{elements:["evidence","reproduction"],detail:"A captured response and an ordered reproduction would decide it.",owner:"hermes"}}]' \
  "$WORK/ledger.json" >"$WORK/ledger-r002.json"
ledger_r002="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json --id ledger-r002 --input "$WORK/ledger-r002.json")"
jq -e --argjson first "$("$CLI" engagement status --manifest "$MANIFEST" | jq '.fragments["solution/bug-ledger.json"][] | select(.id == "complete-ledger") | .sequence')" \
  '.sequence > $first' <<<"$ledger_r002" >/dev/null || fail "a newer single-document fragment did not receive a higher sequence: $ledger_r002"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json >/dev/null
jq -e '.bugs | length == 1 and .[0].id == "BUG-0001" and .[0].status == "suspected"' "$TARGET/solution/bug-ledger.json" >/dev/null \
  || fail "single-document merge did not publish the latest ledger fragment"
"$CLI" engagement status --manifest "$MANIFEST" | jq -e '.merges["solution/bug-ledger.json"] | .effectiveFragment == "ledger-r002" and .supersededFragments == 1 and .fragments == 2' >/dev/null \
  || fail "single-document merge record does not name its effective fragment"
superseded_digest="$(digest_file "$TARGET/solution/bug-ledger.json")"
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json >/dev/null
[ "$superseded_digest" = "$(digest_file "$TARGET/solution/bug-ledger.json")" ] || fail "repeated single-document merge is not byte-stable"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json --id ledger-r002 --input "$WORK/ledger-r002.json" | jq -e --argjson original "$ledger_r002" '. == $original' >/dev/null \
  || fail "an identical single-document replay did not keep its original record"
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$(token_for kleio)" \
  --canonical solution/bug-ledger.json --id foreign-ledger --input "$WORK/ledger.json" >"$WORK/foreign-ledger.out" 2>&1; then
  fail "a non-owner submitted a single-document fragment"
fi
grep -Fq 'solution/bug-ledger.json is a single-document contract; only minos may submit fragments' "$WORK/foreign-ledger.out" \
  || fail "non-owner single-document fragment failed for the wrong reason: $(<"$WORK/foreign-ledger.out")"
"$CLI" engagement status --manifest "$MANIFEST" | jq -e '.fragments["solution/bug-ledger.json"] | length == 2' >/dev/null \
  || fail "a refused non-owner fragment reached engagement state"
jq -c '.bugs = []' "$WORK/ledger.json" >"$WORK/ledger-r003.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json --id ledger-r003 --input "$WORK/ledger-r003.json" >/dev/null
if "$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json >"$WORK/unstable-ledger.out" 2>&1; then
  fail "a superseding ledger that dropped a bug ID was merged"
fi
grep -Fq 'bug-ledger supersession removed or re-pointed BUG-0001' "$WORK/unstable-ledger.out" \
  || fail "unstable ledger merge failed for the wrong reason: $(<"$WORK/unstable-ledger.out")"
[ "$superseded_digest" = "$(digest_file "$TARGET/solution/bug-ledger.json")" ] || fail "a refused supersession changed the canonical ledger"

# Lane outcomes count the merged ledger and automation status per selected lane. A test owned
# by an unselected lane is counted as unattributed, never dropped; a decision whose integrity
# digest does not match fails the whole report instead of undercounting it.
jq -c '.engagementId = "phase0-smoke" | .tests = [
  (.tests[0] | .owner = "hermes" | .status = "failed" | .evidenceIds = []),
  (.tests[1] | .owner = "hermes" | .evidenceIds = []),
  (.tests[1] | .testId = "TST-0003" | .owner = "not-selected" | .evidenceIds = [])]' \
  "$ROOT/scripts/fixtures/argus-schemas/valid/automation-status.json" >"$WORK/automation-status.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" \
  --canonical solution/automation-status.json --id lane-outcomes --input "$WORK/automation-status.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner atlas --token "$(token_for atlas)" \
  --canonical solution/automation-status.json >/dev/null
"$CLI" engagement lane-outcomes --manifest "$MANIFEST" --controller-token "$CONTROLLER_TOKEN" >/dev/null
jq -e --arg ledger "$superseded_digest" --arg automation "$(digest_file "$TARGET/solution/automation-status.json")" '
  .sources.bugLedgerSha256 == $ledger and .sources.automationStatusSha256 == $automation
  and .sources.unattributedLedgerRows == 0 and .sources.unattributedTests == 1
  and (.lanes | length == 27)
  and (.lanes[] | select(.agent == "hermes") | .ledger == {reported:1,confirmed:0,suspected:1,needsOracle:0,bounced:0,quarantined:0,duplicate:0,rejected:0,wired:0,severe:0}
    and .automation == {tests:2,coveringBugs:1,failed:1})
  and ([.lanes[] | select(.agent != "hermes") | .ledger.reported + .automation.tests] | add == 0)' \
  "$TARGET/ai_agents_internal/lane-outcomes.json" >/dev/null || fail "lane-outcomes miscounted the merged canonicals: $(cat "$TARGET/ai_agents_internal/lane-outcomes.json")"
DECISIONS="$TARGET/ai_agents_internal/model-decisions"
tampered="$(find "$DECISIONS" -maxdepth 1 -name 'MDR-*.json' | sort | head -n 1)"
jq '.decisionId = "MDR-ffffffffffffffffffffffff" | .relativePath = "ai_agents_internal/model-decisions/MDR-ffffffffffffffffffffffff.json"' \
  "$tampered" >"$DECISIONS/MDR-ffffffffffffffffffffffff.json"
if outcomes_error="$("$CLI" engagement lane-outcomes --manifest "$MANIFEST" --controller-token "$CONTROLLER_TOKEN" 2>&1)"; then
  fail 'lane-outcomes counted a decision that fails its integrity digest'
fi
grep -Fq 'failed its integrity digest' <<<"$outcomes_error" || fail "tampered-decision lane-outcomes failed for the wrong reason: $outcomes_error"
rm "$DECISIONS/MDR-ffffffffffffffffffffffff.json"
if "$CLI" engagement lane-outcomes --manifest "$MANIFEST" --controller-token "$(token_for hermes)" >/dev/null 2>&1; then
  fail 'lane-outcomes accepted a worker token as the controller token'
fi

# The per-contract stability invariants, exercised directly on packaged contract semantics.
node --input-type=module - "$ROOT" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root] = process.argv.slice(2);
const { assertSupersession, isCollectionContract } = await import(pathToFileURL(join(root, 'argus/claude/lib/contracts.mjs')).href);
const fixture = (name) => JSON.parse(readFileSync(join(root, 'scripts/fixtures/argus-schemas/valid', name), 'utf8'));
const refused = (label, expected, kind, previous, next) => {
  try { assertSupersession(kind, previous, next); }
  catch (error) {
    if (!error.message.includes(expected)) throw new Error(`${label} failed for the wrong reason: ${error.message}`);
    return;
  }
  throw new Error(`${label} was accepted`);
};
const ledger = fixture('bug-ledger.json');
const grown = structuredClone(ledger);
grown.bugs[2].status = 'suspected';
grown.bugs[2].origin.push('MIN-003');
grown.bugs.push({ ...structuredClone(ledger.bugs[5]), id: 'BUG-0008', origin: ['ATA-008'] });
assertSupersession('bug-ledger', ledger, grown);
const repointed = structuredClone(ledger);
repointed.bugs[1].origin = ['ATA-002'];
refused('re-pointed bug origin', 'bug-ledger supersession removed or re-pointed BUG-0002', 'bug-ledger', ledger, repointed);
refused('removed bug', 'bug-ledger supersession removed or re-pointed BUG-0007', 'bug-ledger', ledger, { ...ledger, bugs: ledger.bugs.slice(0, 6) });
const inventory = fixture('surface-inventory.json');
const expanded = structuredClone(inventory);
expanded.discovery.candidates += 1;
expanded.items.push({ ...structuredClone(inventory.items[0]), id: 'SRF-API-SUPERSESSION-NEW' });
assertSupersession('surface-inventory', inventory, expanded);
refused('removed surface', `surface-inventory supersession removed ${inventory.items[0].id}`, 'surface-inventory', inventory, { ...inventory, items: inventory.items.slice(1) });
refused('shrunk discovery', 'surface-inventory supersession decreased discovery.candidates', 'surface-inventory', expanded, inventory);
assertSupersession('final-summary', fixture('final-summary.json'), { ...fixture('final-summary.json'), summary: 'A corrected narrative.' });
if (!isCollectionContract('lane-plan') || isCollectionContract('bug-ledger')) throw new Error('collection contract classification drifted');
refused('collection supersession', 'lane-plan is a collection contract', 'lane-plan', fixture('lane-plan.json'), fixture('lane-plan.json'));
NODE

parallel_merge_digest() {
  local run="$1" target="$WORK/repeat-$1" manifest controller allocation controller_token token index host="$HOST/repeat-$1"
  mkdir -p "$target" "$WORK/repeat-fragments-$run"
  "$CLI" engagement init --target "$target" --artifact-root "$target" --mode A --engagement-id "repeat-$run" >/dev/null
  manifest="$target/ai_agents_internal/engagement.json"
  argus_smoke_prepare_model_control "$CLI" "$manifest" "$target" "$target" A \
    "$ROOT/scripts/fixtures/argus-preflight/full.json" "$host"
  controller="$(argus_smoke_allocate "$CLI" "$manifest" "$host" odysseus)"
  controller_token="$(jq -r .token <<<"$controller")"
  allocation="$(argus_smoke_allocate "$CLI" "$manifest" "$host" metis "$controller_token")"
  token="$(jq -r .token <<<"$allocation")"
  for index in $(seq -w 1 16); do
    printf 'Stable section %s.\n' "$index" >"$WORK/repeat-fragments-$run/$index.md"
    "$CLI" engagement fragment --manifest "$manifest" --lane metis --token "$token" \
      --canonical solution/TEST-STRATEGY.md --id "$index" --input "$WORK/repeat-fragments-$run/$index.md" >/dev/null &
  done
  wait
  "$CLI" engagement merge --manifest "$manifest" --owner metis --token "$token" \
    --canonical solution/TEST-STRATEGY.md >/dev/null
  digest_file "$target/solution/TEST-STRATEGY.md"
}

repeat_one="$(parallel_merge_digest 1)"
repeat_two="$(parallel_merge_digest 2)"
repeat_three="$(parallel_merge_digest 3)"
[ "$repeat_one" = "$repeat_two" ] && [ "$repeat_two" = "$repeat_three" ] || fail "repeated parallel merges produced different artifacts"

# The packaged guard covers direct tools, traversal, symlinks, shell writes, and subprocesses.
guard_write tests/generated.spec.ts allow
guard_write scripts/hunt-driver.mjs allow
guard_write scripts/generated-helper.mjs GUARD-TARGET-IMMUTABLE
guard_write src/application.ts GUARD-TARGET-IMMUTABLE
guard_write package.json GUARD-TARGET-IMMUTABLE
guard_write reports/result.json allow
guard_write app/source.ts GUARD-TARGET-IMMUTABLE
guard_write "$TARGET/app/source.ts" GUARD-TARGET-IMMUTABLE
guard_write tests/../app/source.ts GUARD-TARGET-IMMUTABLE
guard_write tests/symlink-app/source.ts GUARD-TARGET-IMMUTABLE
guard_write solution/TEST-STRATEGY.md GUARD-CANONICAL-SINGLE-WRITER
guard_write ai_agents_internal/operator-decisions/forged.json GUARD-TARGET-IMMUTABLE
ln "$TARGET/app/source.ts" "$TARGET/reports/source-hardlink.txt"
guard_write reports/source-hardlink.txt GUARD-HARDLINK-ALIAS
guard_shell 'printf compromised > reports/source-hardlink.txt' GUARD-HARDLINK-ALIAS
printf '{"password":"hardlink-guard-sentinel"}\n' >"$TARGET/reports/hardlink-input.json"
if (cd "$TARGET" && "$CLI" redact --input reports/hardlink-input.json --output reports/source-hardlink.txt >/dev/null 2>&1); then
  fail 'packaged redactor wrote through an allowed-path hard link to target source'
fi
grep -Fxq 'application source' "$TARGET/app/source.ts" || fail 'allowed-path hard link modified target source'
rm "$TARGET/reports/source-hardlink.txt"
guard_shell 'printf x > reports/result.txt' allow
guard_shell 'printf x > app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'rm app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'mv tests/generated.spec.ts app/generated.spec.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'chmod 777 app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'patch app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell "node -e \"require('fs').writeFileSync('app/subprocess.ts','supersecret')\"" GUARD-TARGET-IMMUTABLE
guard_shell "python3 -c \"open('app/python-write.txt','w').write('supersecret')\"" GUARD-TARGET-IMMUTABLE
guard_shell "bash -c 'printf x > app/nested-shell.txt'" GUARD-TARGET-IMMUTABLE
guard_shell "node -e \"require('fs').writeFileSync(process.env.P,'supersecret')\"" GUARD-SHELL-AMBIGUOUS
guard_shell "node -e \"import('./runtime/engagement.mjs').then(m => m.allocateWorker({}, 'odysseus', {}))\"" GUARD-SHELL-AMBIGUOUS
guard_shell "node -e \"require('fs').rmSync('app/source.ts')\"" GUARD-TARGET-IMMUTABLE
guard_shell "python3 -c \"import shutil; shutil.rmtree('app')\"" GUARD-TARGET-IMMUTABLE
guard_shell 'argus-assets verify & rm -rf app' GUARD-SHELL-AMBIGUOUS
guard_shell 'rm -rf app argus-assets verify' GUARD-SHELL-AMBIGUOUS
guard_shell $'argus-assets verify\n# harmless comment' GUARD-SHELL-AMBIGUOUS
guard_shell 'cd . && argus-assets verify' GUARD-SHELL-AMBIGUOUS
guard_shell 'ARGUS_TEST=1 argus-assets verify' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets verify | true' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets verify > reports/verify.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus\-assets redact --input reports/result.txt --output reports/redacted-escaped-command.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-as\sets redact --input reports/result.txt --output reports/redacted-escaped-fragment.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-"assets" redact --input reports/result.txt --output reports/redacted-quoted-fragment.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'A=argus-assets; $A redact --input reports/result.txt --output reports/redacted-variable-command.txt' GUARD-SHELL-AMBIGUOUS
printf '{"password":"guard-sentinel"}\n' >"$TARGET/reports/result.txt"
if (cd "$TARGET" && A="$CLI" && "$A" redact --input reports/result.txt --output app/self-guarded.txt >/dev/null 2>&1); then
  fail 'packaged redactor bypassed its active-engagement write guard through a shell variable'
fi
test ! -e "$TARGET/app/self-guarded.txt" || fail 'self-guarded redactor created a target-source file'
if (cd "$TARGET" && ARGUS_ENGAGEMENT_MANIFEST="$WORK/missing-engagement.json" \
  "$CLI" redact --input reports/result.txt --output app/env-bypassed.txt >/dev/null 2>&1); then
  fail 'invalid ARGUS_ENGAGEMENT_MANIFEST bypassed the packaged write guard'
fi
test ! -e "$TARGET/app/env-bypassed.txt" || fail 'invalid manifest override created a target-source file'
(cd "$TARGET" && "$CLI" redact --input reports/result.txt --output reports/self-guard-allowed.json >/dev/null)
test -f "$TARGET/reports/self-guard-allowed.json" || fail 'self-guard denied an allowed report output'
guard_shell "argus-assets engagement init --target app --artifact-root app --mode A" GUARD-SHELL-AMBIGUOUS
cp "$MANIFEST" "$WORK/alternate-engagement.json"
guard_shell "argus-assets engagement validate --manifest $WORK/alternate-engagement.json" GUARD-SHELL-AMBIGUOUS
# The guard reads whole shell words, as bash and zsh build argv. A quote joined to unquoted
# text, an open quote, and expansion, glob, brace, escape, or tilde syntax make a packaged
# command ambiguous, so the manifest binding and every destination check see the real word.
LITERAL_WORDS='GUARD-SHELL-AMBIGUOUS: packaged command words must be literal'
for quote in "'" '"'; do
  concatenated="${quote}ai_agents_internal/engagement.json${quote}/../../reports/alt/ai_agents_internal/engagement.json"
  guard_as argus:hermes Bash "argus-assets engagement status --manifest $concatenated" "$LITERAL_WORDS"
  guard_as argus:hermes Bash "argus-assets engagement merge --manifest $concatenated --owner hermes --token x --canonical solution/BUG-LEDGER.md" "$LITERAL_WORDS"
  guard_as argus:hermes Bash "argus-assets engagement claim --manifest $concatenated --lane hermes --token x --resource fault" "$LITERAL_WORDS"
  guard_as argus:hermes Bash "argus-assets engagement fragment --manifest $concatenated --lane hermes --token x --canonical solution/BUG-LEDGER.md --id forged --input reports/x.md" "$LITERAL_WORDS"
  guard_as argus:hermes Bash "argus-assets model telemetry --manifest $concatenated --decision reports/decision.json" "$LITERAL_WORDS"
  guard_as argus:hermes Bash "argus-assets redact --input reports/result.txt --output ${quote}reports${quote}/../app/escape.txt" "$LITERAL_WORDS"
  guard_as argus:hermes Bash "printf x > ${quote}reports${quote}/../app/escape.txt" GUARD-TARGET-IMMUTABLE
  guard_as argus:hermes Bash "printf x > reports/${quote}../app/escape.txt${quote}" GUARD-TARGET-IMMUTABLE
done
guard_as argus:hermes Bash 'argus-assets engagement status --manifest ${X:-reports/alt/ai_agents_internal/engagement.json}' "$LITERAL_WORDS"
guard_as argus:hermes Bash 'argus-assets engagement status --manifest {reports/alt/,}ai_agents_internal/engagement.json' "$LITERAL_WORDS"
guard_as argus:hermes Bash 'argus-assets engagement status --manifest ai_agents_internal/engagement.jso?' "$LITERAL_WORDS"
guard_as argus:hermes Bash 'argus-assets engagement status --manifest ~/ai_agents_internal/engagement.json' "$LITERAL_WORDS"
guard_as argus:hermes Bash 'argus-assets engagement status --manifest ai_agents_internal/engagement.json\ x' "$LITERAL_WORDS"
guard_as argus:hermes Bash "argus-assets engagement status --manifest 'ai_agents_internal/engagement.json" "$LITERAL_WORDS"
guard_as argus:hermes Bash 'argus-assets redact --input reports/result.txt --output "reports/$HOME.txt"' "$LITERAL_WORDS"
guard_as argus:hermes Bash 'argus-assets redact --input reports/result.txt --output =reports' "$LITERAL_WORDS"
guard_as argus:hermes Bash "argus-assets redact --input reports/result.txt --output 'reports/quoted output.txt'" allow
guard_as argus:hermes Bash "argus-assets engagement status --manifest \"ai_agents_internal/engagement.json\"" allow
guard_as argus:hermes Bash "rm -rf reports/'../app'" GUARD-TARGET-IMMUTABLE
# The CLI binds --manifest to the active engagement on its own, so a manifest copy that a lane
# writes under reports/ never lends its owners or exclusive operations to the shared state.
mkdir -p "$TARGET/reports/alt/ai_agents_internal"
FORGED="$TARGET/reports/alt/ai_agents_internal/engagement.json"
jq '(.writePolicy.canonicalArtifacts[] | select(.path == "solution/BUG-LEDGER.md") | .owner) = "hermes"
  | .resourcePolicy.exclusiveOperations.fault = "hermes"' "$MANIFEST" >"$FORGED"
chmod 600 "$FORGED"
printf '# BUG ledger forged by hermes\n' >"$TARGET/reports/forged-ledger.md"
state_before_forgery="$(digest_file "$STATE")"
solution_before_forgery="$(ls -la "$TARGET/solution")"
forged_operations=(
  "fragment --lane hermes --token $(token_for hermes) --canonical solution/BUG-LEDGER.md --id forged --input reports/forged-ledger.md"
  "merge --owner hermes --token $(token_for hermes) --canonical solution/BUG-LEDGER.md"
  "claim --lane hermes --token $(token_for hermes) --resource fault"
  "status"
  "validate"
)
for operation in "${forged_operations[@]}"; do
  # shellcheck disable=SC2086 # each entry is a word list of fixed, space-free arguments
  if (cd "$TARGET" && "$CLI" engagement $operation --manifest reports/alt/ai_agents_internal/engagement.json) >"$WORK/forged.out" 2>&1; then
    fail "engagement ${operation%% *} accepted a lane-written manifest copy"
  fi
  grep -Fq 'is not the active engagement manifest' "$WORK/forged.out" || fail "forged-manifest ${operation%% *} failed for the wrong reason: $(<"$WORK/forged.out")"
done
if ARGUS_NATIVE_LAUNCH_RECEIPT="$TARGET/ai_agents_internal/native-launch-receipt.json" \
  "$CLI" engagement claim --manifest "$FORGED" --lane hermes --token "$(token_for hermes)" --resource fault >"$WORK/forged.out" 2>&1; then
  fail 'a lane-written manifest copy was accepted outside the artifact root of a launched engagement'
fi
grep -Fq 'is not the active engagement manifest' "$WORK/forged.out" || fail "receipt-bound forged claim failed for the wrong reason: $(<"$WORK/forged.out")"
if (cd "$TARGET" && "$CLI" model telemetry --manifest reports/alt/ai_agents_internal/engagement.json --decision reports/decision.json \
  --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true) >"$WORK/forged.out" 2>&1; then
  fail 'model telemetry accepted a lane-written manifest copy'
fi
grep -Fq 'is not the active engagement manifest' "$WORK/forged.out" || fail "forged-manifest telemetry failed for the wrong reason: $(<"$WORK/forged.out")"
[ "$(digest_file "$STATE")" = "$state_before_forgery" ] || fail 'a forged-manifest operation changed the real engagement state'
[ "$(ls -la "$TARGET/solution")" = "$solution_before_forgery" ] || fail 'a forged-manifest merge changed the canonical artifacts'
rm -rf "$TARGET/reports/alt" "$TARGET/reports/forged-ledger.md"
guard_shell "argus-assets engagement heartbeat --manifest $MANIFEST --lane odysseus --token $(token_for odysseus) --phase hunting --completed 1 --total 4 --status running" allow
guard_shell "argus-assets engagement barrier skip --manifest $MANIFEST --lane odysseus --token $(token_for odysseus) --reason converged" allow
guard_shell "argus-assets engagement barrier skip --manifest $WORK/alternate-engagement.json --lane odysseus --token $(token_for odysseus) --reason converged" GUARD-SHELL-AMBIGUOUS
# Abandoning a released lane is a bounded controller mutation of the active engagement only.
guard_shell "argus-assets engagement barrier abandon --manifest $MANIFEST --lane hermes --controller-token $(token_for odysseus) --reason worker-failure" allow
guard_shell "argus-assets engagement barrier abandon --manifest $WORK/alternate-engagement.json --lane hermes --controller-token $(token_for odysseus) --reason worker-failure" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets engagement resolve-gates --manifest $MANIFEST --controller-token $(token_for odysseus)" allow
guard_shell "argus-assets engagement resolve-gates --manifest $MANIFEST --controller-token $(token_for odysseus) --evidence solution/discovery/capability-evidence.json" allow
guard_shell "argus-assets engagement resolve-gates --manifest $WORK/alternate-engagement.json --controller-token $(token_for odysseus)" GUARD-SHELL-AMBIGUOUS
# report-facts only reads the merge-verified canonicals; a file output keeps the write-root checks.
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST" allow
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST --output -" allow
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST --output reports/report-facts.json" allow
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST --output solution/final-summary.json" GUARD-CANONICAL-SINGLE-WRITER
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST --output app/report-facts.json" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets engagement report-facts --manifest $WORK/alternate-engagement.json" 'GUARD-SHELL-AMBIGUOUS: engagement report-facts must bind to the active engagement manifest'
guard_shell 'argus-assets engagement report-facts' 'GUARD-SHELL-AMBIGUOUS: engagement report-facts must bind to the active engagement manifest'
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST --token $(token_for kleio)" 'GUARD-SHELL-AMBIGUOUS: engagement report-facts accepts only --manifest <path> and --output <json|->'
guard_shell "argus-assets engagement report-facts --manifest $MANIFEST --output" 'GUARD-SHELL-AMBIGUOUS: engagement report-facts accepts only'
# lane-outcomes writes only its fixed control artifact; the options are closed.
guard_shell "argus-assets engagement lane-outcomes --manifest $MANIFEST --controller-token $CONTROLLER_TOKEN" allow
guard_shell "argus-assets engagement lane-outcomes --manifest $WORK/alternate-engagement.json --controller-token $CONTROLLER_TOKEN" 'GUARD-SHELL-AMBIGUOUS: engagement lane-outcomes must bind to the active engagement manifest'
guard_shell "argus-assets engagement lane-outcomes --manifest $MANIFEST" 'GUARD-SHELL-AMBIGUOUS: engagement lane-outcomes requires --controller-token'
guard_shell "argus-assets engagement lane-outcomes --manifest $MANIFEST --controller-token $CONTROLLER_TOKEN --output reports/lane-outcomes.json" 'GUARD-SHELL-AMBIGUOUS: engagement lane-outcomes accepts only --manifest <path> and --controller-token <odysseus-token>'
guard_shell "argus-assets engagement lane-outcomes --manifest $MANIFEST --token $(token_for kleio)" 'GUARD-SHELL-AMBIGUOUS: engagement lane-outcomes accepts only'
guard_shell "argus-assets engagement lane-outcomes --manifest $MANIFEST --controller-token" 'GUARD-SHELL-AMBIGUOUS: engagement lane-outcomes accepts only'
# No arrow function here: its ">" alone would already look like a redirection.
guard_shell "node -e \"import('./runtime/engagement.mjs').then(function (m) { m.resolveConditionalGates({}, 'token', {}) })\"" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets redact --input reports/result.txt --output app/redacted.txt" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets redact --input reports/result.txt --output ai_agents_internal/operator-decisions/forged.json" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets preflight --target app --artifact-root app --mode A" GUARD-TARGET-IMMUTABLE
# Preflight resolves --output against the artifact root, as the CLI does, and writes only its
# report or a new diagnostic beside it; the artifact root defaults to a path target.
PREFLIGHT_OUTPUT='GUARD-SHELL-AMBIGUOUS: preflight --output must be ai_agents_internal/preflight.json or a diagnostic'
guard_shell "argus-assets preflight --target $TARGET --artifact-root $TARGET --mode A" allow
guard_shell "argus-assets preflight --target $TARGET --artifact-root $TARGET --mode A --output ai_agents_internal/preflight-diagnostic.json" allow
guard_shell "argus-assets preflight --target $TARGET --mode A --output ./ai_agents_internal/preflight.json" allow
for output in ai_agents_internal/../solution/preflight-escape.json ai_agents_internal/../solution/BUG-LEDGER.md \
  ai_agents_internal/../app/preflight.json ai_agents_internal/engagement-state.json ai_agents_internal/heartbeat/preflight.json \
  reports/preflight.json; do
  guard_shell "argus-assets preflight --target $TARGET --artifact-root $TARGET --mode A --output $output" "$PREFLIGHT_OUTPUT"
done
guard_shell 'argus-assets preflight --target app --mode A' GUARD-TARGET-IMMUTABLE
if (cd "$TARGET" && "$CLI" preflight --target "$TARGET" --artifact-root "$TARGET" --mode A \
  --output ai_agents_internal/../solution/preflight-escape.json) >"$WORK/preflight-escape.out" 2>&1; then
  fail 'preflight accepted a report path outside the control directory'
fi
grep -Fq 'preflight --output must stay inside <artifact-root>/ai_agents_internal' "$WORK/preflight-escape.out" \
  || fail "preflight output escape failed for the wrong reason: $(<"$WORK/preflight-escape.out")"
test ! -e "$TARGET/solution/preflight-escape.json" || fail 'a refused preflight wrote outside the control directory'
guard_shell "argus-assets copy-browser-driver $TARGET" allow
guard_shell "argus-assets copy-browser-driver $WORK/outside-target" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets browser provision --artifact-root $TARGET" GUARD-SHELL-AMBIGUOUS
# Binary-evidence reviews bind to the collector's audited decision at its real timestamp: a lane
# asks only for itself, as the PreToolUse payload names it, and the test clock override is refused.
AUTH_CHECK="argus-assets authorization check --manifest ai_agents_internal/authorization.json --action binary-evidence --target $TARGET --source-trust user --binary-reviewed true"
guard_as orion Bash "$AUTH_CHECK --lane orion" allow
guard_as main Bash "$AUTH_CHECK --lane odysseus" allow
guard_as lynceus Bash "$AUTH_CHECK --lane atalanta" 'GUARD-SHELL-AMBIGUOUS: authorization check --lane must name the calling lane lynceus'
guard_as main Bash "$AUTH_CHECK --lane atalanta" 'GUARD-SHELL-AMBIGUOUS: authorization check --lane must name the calling lane odysseus'
guard_as untyped Bash "$AUTH_CHECK --lane orion" 'GUARD-SHELL-AMBIGUOUS: authorization check requires an identified calling lane'
guard_shell "$AUTH_CHECK --lane orion" 'GUARD-SHELL-AMBIGUOUS: authorization check requires an identified calling lane'
# The hunt driver runs its own binary-evidence check as --agent, so that agent must be the caller.
guard_as lynceus Bash "ARGUS_BINARY_EVIDENCE_REVIEWED=true node scripts/hunt-driver.mjs --agent lynceus --goto / --shot home" allow
guard_as lynceus Bash "ARGUS_BINARY_EVIDENCE_REVIEWED=true node scripts/hunt-driver.mjs --agent atalanta --goto / --shot home" \
  'GUARD-SHELL-AMBIGUOUS: the packaged hunt driver --agent must name the calling lane lynceus'
guard_as lynceus Bash "node scripts/hunt-driver.mjs --agent 'atal'anta --goto / --shot home" 'GUARD-SHELL-AMBIGUOUS: the packaged hunt driver --agent must name the calling lane lynceus'
guard_as untyped Bash "node scripts/hunt-driver.mjs --agent orion --goto /" 'GUARD-SHELL-AMBIGUOUS: the packaged hunt driver requires an identified calling lane'
guard_as lynceus Bash "wc -l scripts/hunt-driver.mjs" allow
# Role prompts run the packaged driver in place (BROWSER-ISOLATION.md): print its directory,
# then invoke that literal path under the managed engagement bindings.
guard_as penelope Bash "argus-assets path typescript-template" allow
MANAGED_DRIVER="ARGUS_ENGAGEMENT_MANIFEST=$MANIFEST ARGUS_BROWSER_PROFILE=$WORK/penelope-profile ARGUS_BROWSER_ARTIFACTS=$WORK/penelope-artifacts node $ROOT/argus/claude/templates/typescript/scripts/hunt-driver.mjs"
guard_as penelope Bash "$MANAGED_DRIVER --agent penelope --role student --goto / --snapshot" allow
guard_as penelope Bash "$MANAGED_DRIVER --agent orion --goto /" 'GUARD-SHELL-AMBIGUOUS: the packaged hunt driver --agent must name the calling lane penelope'
guard_shell "argus-assets authorization check --manifest ai_agents_internal/authorization.json --lane orion --action binary-evidence --target $TARGET --source-trust user --binary-reviewed true --at 2026-07-10T12:00:00.000Z" GUARD-SHELL-AMBIGUOUS
if (cd "$TARGET" && "$CLI" authorization check --manifest ai_agents_internal/authorization.json --lane orion --action read --target "$TARGET" --source-trust manifest --at 2026-07-10T12:00:00.000Z) >"$WORK/authorization-at.out" 2>&1; then
  fail 'authorization check accepted --at inside an active engagement'
fi
grep -Fq 'authorization check --at is a test-only clock override and is refused while an engagement is active' "$WORK/authorization-at.out" || fail "authorization check --at was not refused by the engagement rule: $(<"$WORK/authorization-at.out")"
# The CLI appends its audit beside --manifest, so inside an engagement only the engagement's
# own authorization manifest is accepted, by the guard and by the CLI on its own.
printf '{"name":"app"}\n' >"$TARGET/app/package.json"
AUTH_READ="--lane talos --action read --target $TARGET --source-trust manifest"
for manifest in app/package.json solution/package.json ai_agents_internal/../reports/authorization.json "$WORK/alternate-authorization.json"; do
  guard_as talos Bash "argus-assets authorization check --manifest $manifest $AUTH_READ" \
    'GUARD-SHELL-AMBIGUOUS: authorization check must name the active engagement authorization manifest'
done
guard_as talos Bash "argus-assets authorization check --manifest $TARGET/ai_agents_internal/authorization.json $AUTH_READ" allow
# shellcheck disable=SC2086 # AUTH_READ is a word list of fixed, space-free arguments
if (cd "$TARGET" && "$CLI" authorization check --manifest app/package.json $AUTH_READ) >"$WORK/authorization-bind.out" 2>&1; then
  fail 'authorization check accepted a foreign manifest inside an active engagement'
fi
grep -Eq 'authorization check inside an active engagement must name /.*/ai_agents_internal/authorization\.json$' "$WORK/authorization-bind.out" \
  || fail "foreign-manifest authorization check failed for the wrong reason: $(<"$WORK/authorization-bind.out")"
test ! -e "$TARGET/app/authorization-audit.jsonl" || fail 'authorization check appended its audit beside a target-source file'
# shellcheck disable=SC2086
(cd "$TARGET" && "$CLI" authorization check --manifest ai_agents_internal/authorization.json $AUTH_READ) >"$WORK/authorization-bind.out" 2>&1 || true
grep -Eq '^AUTHORIZATION  (ALLOW|DENY) .* audit=/.*/ai_agents_internal/authorization-audit\.jsonl ' "$WORK/authorization-bind.out" \
  || fail "the engagement authorization manifest was not audited in the control directory: $(<"$WORK/authorization-bind.out")"
rm "$TARGET/app/package.json"
# The exclusive reset/fault window handshake the prompts document passes the guard as written.
guard_as main Bash "argus-assets engagement claim --manifest $MANIFEST --lane odysseus --token $CONTROLLER_TOKEN --resource reset" allow
guard_as argus:tyche Bash "argus-assets engagement claim --manifest $MANIFEST --lane tyche --token $(token_for tyche) --resource fault" allow
guard_as argus:tyche Bash "argus-assets engagement release --manifest $MANIFEST --lane tyche --token $(token_for tyche) --resource fault" allow
guard_as argus:atlas Bash 'ARGUS_ENGAGEMENT_LANE=atlas ARGUS_ENVIRONMENT_RESET=execute ./run-tests.sh --mode full-suite' allow
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./run-tests.sh --mode candidate-regression' allow
atlas_tmp="$(jq -r .temporaryDirectory "$ALLOCATIONS/atlas.json")"
guard_shell "argus-assets copy-template typescript $atlas_tmp/template" allow
guard_shell "argus-assets copy-runner-kit typescript $atlas_tmp/runner-kit" allow
guard_shell "argus-assets copy-runner-kit java $WORK/outside-target" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets copy-runner-kit python" GUARD-SHELL-AMBIGUOUS
if (cd "$TARGET" && "$CLI" copy-runner-kit python app/runner-kit) >"$WORK/runner-kit-guard.out" 2>&1; then
  fail 'copy-runner-kit bypassed its active-engagement write guard'
fi
grep -Fq 'copy-runner-kit denied by active engagement rule GUARD-TARGET-IMMUTABLE' "$WORK/runner-kit-guard.out" || fail "copy-runner-kit was not denied by the write guard: $(<"$WORK/runner-kit-guard.out")"
test ! -e "$TARGET/app/runner-kit" || fail 'self-guarded copy-runner-kit created a target-source directory'
# Engagement opt-ins reach the target only through the engagement's run-tests.sh, run by the
# calling lane under its own name; only runner-lib.sh issues the fault-injection grant.
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./run-tests.sh --mode full-suite' allow
guard_as argus:nike Bash "env ARGUS_ENGAGEMENT_LANE=\"nike\" ARGUS_ENGAGEMENT_MANIFEST=$MANIFEST ARGUS_FAULT_INJECTION=authorized bash $TARGET/run-tests.sh --mode full-suite" allow
guard_as main Bash 'ARGUS_ENGAGEMENT_LANE=odysseus ARGUS_ENVIRONMENT_RESET=execute ./run-tests.sh --mode full-suite' allow
guard_as argus:nike Bash 'ARGUS_FAULT_INJECTION=authorized ./run-tests.sh --mode full-suite' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=tyche ARGUS_FAULT_INJECTION=authorized ./run-tests.sh --mode full-suite' GUARD-ENGAGEMENT-OPT-IN
guard_as untyped Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./run-tests.sh --mode full-suite' GUARD-ENGAGEMENT-OPT-IN
guard_shell 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./run-tests.sh --mode full-suite' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized .venv/bin/python -m pytest -m resilience' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized mvn test -Dgroups=resilience' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./tests/run-tests.sh --mode full-suite' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash "cd $TARGET && ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./run-tests.sh" GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'export ARGUS_FAULT_INJECTION=authorized; ./run-tests.sh' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=$MODE ./run-tests.sh' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash "ARGUS_ENGAGEMENT_LANE=nike ARGUS_ENGAGEMENT_MANIFEST=$WORK/forged/engagement.json ARGUS_FAULT_INJECTION=authorized ./run-tests.sh" GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash "ARGUS_ENGAGEMENT_LANE=nike ARGUS_AUTHORIZATION_MANIFEST=$WORK/forged/authorization.json ARGUS_FAULT_INJECTION=authorized ./run-tests.sh" GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ARGUS_FAULT_INJECTION_GRANT=nike ./run-tests.sh' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_FAULT_INJECTION_GRANT=nike .venv/bin/python -m pytest -m resilience' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ./run-tests.sh' GUARD-ENGAGEMENT-OPT-IN
guard_as argus:nike Bash './run-tests.sh --mode full-suite' allow
# A lane waits for the per-root run lock the way qa-framework-runner documents, with or without
# an opt-in.
guard_as argus:daidalos Bash 'ARGUS_RUN_LOCK_WAIT_SECONDS=300 ./run-tests.sh --mode baseline' allow
guard_as argus:nike Bash 'ARGUS_ENGAGEMENT_LANE=nike ARGUS_FAULT_INJECTION=authorized ARGUS_RUN_LOCK_WAIT_SECONDS=300 ./run-tests.sh --mode candidate-regression' allow
guard_shell "argus-assets template detect --target $TARGET" allow
guard_shell "argus-assets template select --target $TARGET --runtime typescript --package-manager npm --test-root tests --harness-root qa-support --output ai_agents_internal/reports/template-selection.json" allow
guard_shell "argus-assets template scaffold --selection ai_agents_internal/reports/template-selection.json --destination $atlas_tmp/scaffold" allow
guard_shell "argus-assets template scaffold --selection ai_agents_internal/reports/template-selection.json --destination $WORK/outside-target" GUARD-TARGET-IMMUTABLE
guard_shell 'argus-assets orchestration plan --mode A' allow
guard_shell 'argus-assets orchestration plan --mode A --output ai_agents_internal/orchestration-plan.json' allow
guard_shell "argus-assets orchestration plan --mode A --artifact-root $TARGET --output ai_agents_internal/orchestration-plan.json" allow
guard_shell 'argus-assets orchestration plan --mode A --output reports/orchestration-plan.json' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets model benchmark' allow
guard_shell "argus-assets model payload --document $TARGET/ai_agents_internal/operator-decisions/unsigned.json" allow
# Read-only packaged queries stay usable inside an engagement; coverage --output keeps write-root checks.
COVERAGE_INPUTS='--inventory solution/surface-inventory.json --observations solution/coverage-observations.json'
COVERAGE_SOURCES='--evidence solution/evidence-reference.json --ledger solution/bug-ledger.json --root .'
guard_shell 'argus-assets technique scopes --role atalanta' allow
guard_shell 'argus-assets technique select --role proteus --inventory solution/surface-inventory.json' allow
guard_shell 'argus-assets technique select --role metis --inventory -' allow
guard_shell 'argus-assets raci list' allow
guard_shell 'argus-assets raci route --surface ui-functional --activity discover' allow
guard_shell 'argus-assets raci route --artifact solution/bug-ledger.json' allow
guard_shell 'argus-assets raci route --transition coverage-result:inputs-ready:calculated' allow
guard_shell "argus-assets coverage validate $COVERAGE_INPUTS" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS --output -" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS --output reports/coverage-result.json" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS --output solution/coverage-result.json" GUARD-CANONICAL-SINGLE-WRITER
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS --output app/coverage-result.json" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets coverage validate $COVERAGE_INPUTS $COVERAGE_SOURCES" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS $COVERAGE_SOURCES --output reports/coverage-result.json" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS $COVERAGE_SOURCES --output solution/coverage-result.json" GUARD-CANONICAL-SINGLE-WRITER
guard_shell "argus-assets coverage validate $COVERAGE_INPUTS $COVERAGE_SOURCES --automation-status solution/automation-status.json" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS --automation-status solution/automation-status.json --output reports/coverage-result.json" allow
guard_shell "argus-assets coverage calculate $COVERAGE_INPUTS --automation-status" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets coverage validate $COVERAGE_INPUTS --root" GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets technique select --role metis --inventory - --output app/selection.json' GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets coverage validate $COVERAGE_INPUTS --output app/coverage-result.json" GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets raci route --artifact' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets technique catalog --role atalanta' 'GUARD-SHELL-AMBIGUOUS: unknown technique operation'
guard_shell 'argus-assets raci assign --artifact solution/bug-ledger.json' 'GUARD-SHELL-AMBIGUOUS: unknown raci operation'
guard_shell 'argus-assets coverage' 'GUARD-SHELL-AMBIGUOUS: unknown coverage operation'
guard_shell 'argus-assets frobnicate --output reports/frobnicated.json' 'GUARD-SHELL-AMBIGUOUS: unknown packaged command operation'
guard_shell 'argus-assets launch verify --request reports/request.json' 'GUARD-SHELL-AMBIGUOUS: unknown packaged command operation'
guard_shell 'argus-assets guard' 'GUARD-SHELL-AMBIGUOUS: unknown packaged command operation'
# Automation review status binds to the active engagement and is read-only; only --emit-gate
# writes, through the ordinary write roots. Aristarchus has no Write tool, so he submits his
# review rounds as one inline single-line --json fragment.
guard_shell "argus-assets automation-review digest --manifest $MANIFEST" allow
guard_shell "argus-assets automation-review check --manifest $MANIFEST" allow
guard_shell "argus-assets automation-review check --manifest $MANIFEST --json" allow
guard_shell "argus-assets automation-review check --manifest $MANIFEST --emit-gate reports/automation-review.gate" allow
guard_shell "argus-assets automation-review check --manifest $MANIFEST --emit-gate solution/automation-review.json" GUARD-CANONICAL-SINGLE-WRITER
guard_shell "argus-assets automation-review check --manifest $MANIFEST --emit-gate app/automation-review.gate" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets automation-review check --manifest $WORK/alternate-engagement.json" 'GUARD-SHELL-AMBIGUOUS: automation review must bind to the active engagement manifest'
guard_shell 'argus-assets automation-review check' 'GUARD-SHELL-AMBIGUOUS: automation review must bind to the active engagement manifest'
guard_shell "argus-assets automation-review digest --manifest $MANIFEST --json" 'GUARD-SHELL-AMBIGUOUS: automation-review digest accepts only its declared options'
guard_shell "argus-assets automation-review check --manifest $MANIFEST --output reports/review.json" 'GUARD-SHELL-AMBIGUOUS: automation-review check accepts only its declared options'
guard_shell "argus-assets automation-review approve --manifest $MANIFEST" 'GUARD-SHELL-AMBIGUOUS: unknown automation-review operation'
# Kleio runs her report-facts, automation-review, and coverage-result publication citations as
# written, so each one, with its placeholders bound to this engagement and her allocation, must
# pass the guard for her lane.
node -e '
  const text = require("node:fs").readFileSync(process.argv[1], "utf8");
  const citations = [...text.matchAll(/`(argus-assets (?:engagement report-facts|automation-review (?:digest|check)|coverage calculate|engagement (?:fragment|merge) [^`]*--canonical solution\/coverage-result\.json)\b[^`]*)`/gu)]
    .map(([, citation]) => citation.replace(/\s+/gu, " ").trim());
  for (const kind of ["engagement report-facts", "automation-review check", "coverage calculate", "engagement fragment", "engagement merge"]) {
    if (!citations.some((citation) => citation.startsWith(`argus-assets ${kind}`))) throw new Error(`kleio.md no longer cites argus-assets ${kind}`);
  }
  process.stdout.write(citations.map((citation) => `${citation}\n`).join(""));
' "$ROOT/argus/roles/kleio.md" >"$WORK/kleio-citations.txt" || fail 'could not extract Kleio report-facts, automation-review, and coverage-result citations'
KLEIO_OUTPUT="$(jq -r .outputDirectory "$ALLOCATIONS/kleio.json")"
while IFS= read -r citation; do
  bound="${citation//<engagement.json>/$MANIFEST}"
  bound="${bound//<artifact-root>/$TARGET}"
  bound="${bound//<allocated outputDirectory>/$KLEIO_OUTPUT}"
  bound="${bound//<lane-token>/$(token_for kleio)}"
  bound="${bound//<coverage-id>/kleio-coverage-result}"
  case "$bound" in *'<'*'>'*) fail "Kleio cites an unbound placeholder: $citation" ;; esac
  guard_as argus:kleio Bash "$bound" allow
done <"$WORK/kleio-citations.txt"
guard_shell "argus-assets engagement fragment --manifest $MANIFEST --lane aristarchus --token lease-token --canonical solution/automation-review.json --id review-r01 --json '{\"owner\":\"aristarchus\",\"reviews\":[]}'" allow
guard_shell "argus-assets engagement fragment --manifest $MANIFEST --lane aristarchus --token lease-token --canonical solution/automation-review.json --id review-r01 --json @reports/review.json" 'GUARD-SHELL-AMBIGUOUS: batch --json input must be one inline single-line JSON object'
# The guard refuses ; & | > backtick and $( anywhere in a packaged command, even inside the
# quoted --json value, and names the character; the same text as JSON escapes is allowed.
REVIEW_FRAGMENT="argus-assets engagement fragment --manifest $MANIFEST --lane aristarchus --token lease-token --canonical solution/automation-review.json --id review-r01 --json"
guard_shell "$REVIEW_FRAGMENT '{\"owner\":\"aristarchus\",\"note\":\"the total bug passes green; the gate is dishonest\"}'" \
  'GUARD-SHELL-AMBIGUOUS: packaged command must be one exact standalone invocation; it contains a semicolon (;), which an inline --json value must write as a JSON'
guard_shell "$REVIEW_FRAGMENT '{\"owner\":\"aristarchus\",\"note\":\"wraps \`api/test_cart.py:42\` in try/except\"}'" 'it contains a backtick (`), which an inline --json value'
guard_shell "$REVIEW_FRAGMENT '{\"owner\":\"aristarchus\",\"note\":\"expect(a && b)\"}'" 'it contains an ampersand (&), which an inline --json value'
guard_shell "$REVIEW_FRAGMENT '{\"owner\":\"aristarchus\",\"note\":\"\$(date)\"}'" 'it contains a command substitution ($(), which an inline --json value'
guard_shell "printf x | argus-assets list" 'GUARD-SHELL-AMBIGUOUS: packaged command must be one exact standalone invocation; it contains a pipe (|); audit='
BS=$'\\'
ESCAPED_NOTE="green${BS}u003b ${BS}u0060x${BS}u0060 ${BS}u0026 ${BS}u0024(y) ${BS}u007c ${BS}u003e ${BS}u0027"
guard_shell "$REVIEW_FRAGMENT '{\"owner\":\"aristarchus\",\"note\":\"$ESCAPED_NOTE\"}'" allow
[ "$(jq -r .note <<<"{\"note\":\"$ESCAPED_NOTE\"}")" = "green; \`x\` & \$(y) | > '" ] || fail 'the JSON escapes Aristarchus is told to use do not decode to the refused characters'
# The automation review stays canonical: no lane writes it directly, and only Aristarchus
# submits its single-document fragments.
guard_as argus:aristarchus Write solution/automation-review.json GUARD-CANONICAL-SINGLE-WRITER
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$(token_for kleio)" \
  --canonical solution/automation-review.json --id foreign-review --input "$WORK/ledger.json" >"$WORK/foreign-review.out" 2>&1; then
  fail 'a non-owner submitted an automation-review fragment'
fi
grep -Fq 'solution/automation-review.json is a single-document contract; only aristarchus may submit fragments' "$WORK/foreign-review.out" \
  || fail "non-owner automation-review fragment failed for the wrong reason: $(<"$WORK/foreign-review.out")"

# The 5.0 harness declarations and runner kit are lane-owned (writePolicy.ownedArtifactRoots):
# the PreToolUse payload names the writing lane, the declared owners write in place, and every
# other lane, the controller, and an unidentified writer are denied. Ownership opens exact
# files only; the rest of scripts/ and every canonical artifact stay closed.
for path in solution/test-lanes.tsv solution/environment.tsv scripts/runner-lib.sh scripts/runner-contract.sh \
  scripts/outcome-event.sh scripts/quarantine-contract.sh scripts/lane-plan.sh scripts/environment-gate.sh \
  scripts/inventory-gate.sh scripts/evidence-gate.sh scripts/argus-playwright-reporter.mjs scripts/baseline-coverage.mjs; do
  guard_as argus:atlas Write "$path" allow
  guard_as argus:talos Write "$path" "GUARD-OWNED-ARTIFACT: lane-owned $path is written only by atlas, not talos"
done
guard_as atlas Write solution/test-lanes.tsv allow
guard_as main Write solution/test-lanes.tsv 'GUARD-OWNED-ARTIFACT: lane-owned solution/test-lanes.tsv is written only by atlas, not odysseus'
guard_write solution/test-lanes.tsv 'GUARD-OWNED-ARTIFACT: lane-owned solution/test-lanes.tsv is written only by atlas; the writing lane is not identified'
guard_write scripts/runner-lib.sh 'the writing lane is not identified'
guard_as untyped Write solution/environment.tsv 'GUARD-OWNED-ARTIFACT: lane-owned solution/environment.tsv is written only by atlas; the writing lane is not identified'
guard_as other:atlas Write solution/environment.tsv 'the writing lane is not identified'
guard_as general-purpose Write solution/environment.tsv 'written only by atlas, not general-purpose'
for lane in atlas asklepios; do guard_as "argus:$lane" Write solution/quarantine.tsv allow; done
guard_as argus:talos Write solution/quarantine.tsv 'GUARD-OWNED-ARTIFACT: lane-owned solution/quarantine.tsv is written only by atlas, asklepios, not talos'
for lane in atlas talos daidalos nike aegis mnemosyne; do
  guard_as "argus:$lane" Write solution/counterfactual/BUG-0001.json allow
done
guard_as argus:minos Write solution/counterfactual/BUG-0001.json 'GUARD-OWNED-ARTIFACT: lane-owned solution/counterfactual is written only by atlas, talos, daidalos, nike, aegis, mnemosyne, not minos'
guard_as argus:kleio Write solution/counterfactual/nested/BUG-0002.json GUARD-OWNED-ARTIFACT
# Each catalog-owning hunter writes its blocking technique-coverage ledger in place; Minos and
# Kleio only read it, and no other lane, the controller, or an unidentified writer may write it.
for pair in perseus:perseus-ledger orion:orion-ledger lynceus:lynceus-ledger antigone:antigone-ledger \
  charon:charon-ledger ariadne:journey-ledger; do
  lane="${pair%%:*}" path="solution/${pair#*:}.json"
  guard_as "argus:$lane" Write "$path" allow
  guard_as argus:minos Write "$path" "GUARD-OWNED-ARTIFACT: lane-owned $path is written only by $lane, not minos"
done
guard_as argus:orion Write solution/perseus-ledger.json 'GUARD-OWNED-ARTIFACT: lane-owned solution/perseus-ledger.json is written only by perseus, not orion'
guard_as main Write solution/journey-ledger.json 'GUARD-OWNED-ARTIFACT: lane-owned solution/journey-ledger.json is written only by ariadne, not odysseus'
guard_write solution/charon-ledger.json 'GUARD-OWNED-ARTIFACT: lane-owned solution/charon-ledger.json is written only by charon; the writing lane is not identified'
guard_as argus:perseus Write solution/perseus-ledger.json.bak GUARD-TARGET-IMMUTABLE
guard_as argus:atlas Write scripts/generated-helper.sh GUARD-TARGET-IMMUTABLE
guard_as argus:atlas Write solution/test-lanes.tsv.orig GUARD-TARGET-IMMUTABLE
guard_as argus:atlas Write src/application.ts GUARD-TARGET-IMMUTABLE
guard_as argus:atlas Write app/source.ts GUARD-TARGET-IMMUTABLE
guard_as argus:atlas Write run-tests.sh GUARD-CANONICAL-SINGLE-WRITER
guard_as argus:atlas Bash "cp $atlas_tmp/runner-kit/scripts/runner-lib.sh scripts/runner-lib.sh" allow
guard_as argus:talos Bash "cp $atlas_tmp/runner-kit/scripts/runner-lib.sh scripts/runner-lib.sh" GUARD-OWNED-ARTIFACT
guard_as argus:atlas Bash 'cp reports/lanes.tsv solution/test-lanes.tsv' allow
guard_as argus:kleio Bash 'cp reports/lanes.tsv solution/test-lanes.tsv' GUARD-OWNED-ARTIFACT
guard_as argus:talos Bash 'printf x > solution/counterfactual/BUG-0003.json' allow
guard_as argus:hermes Bash 'printf x > solution/counterfactual/BUG-0003.json' GUARD-OWNED-ARTIFACT
guard_as argus:talos Bash 'argus-assets redact --input reports/result.txt --output solution/counterfactual/BUG-0004.json' allow
guard_as argus:hermes Bash 'argus-assets redact --input reports/result.txt --output solution/counterfactual/BUG-0004.json' GUARD-OWNED-ARTIFACT
# A packaged command checks its own outputs without a lane identity, so it never writes a
# lane-owned path; the owner redacts into reports/ and copies the result in place.
if (cd "$TARGET" && "$CLI" redact --input reports/result.txt --output solution/counterfactual/BUG-0004.json) >"$WORK/owned-redact.out" 2>&1; then
  fail 'the packaged redactor wrote a lane-owned path without a lane identity'
fi
grep -Fq 'redaction output denied by active engagement rule GUARD-OWNED-ARTIFACT' "$WORK/owned-redact.out" \
  || fail "unidentified owned-path redaction failed for the wrong reason: $(<"$WORK/owned-redact.out")"
test ! -e "$TARGET/solution/counterfactual/BUG-0004.json" || fail 'a denied redaction created a lane-owned file'
# An owned root reached through a symbolic link is denied to its owners as well.
ln -s ../app "$TARGET/solution/counterfactual"
guard_as argus:talos Write solution/counterfactual/BUG-0005.json 'GUARD-OWNED-ARTIFACT: lane-owned solution/counterfactual crosses a symbolic link'
guard_as argus:talos Write app/BUG-0005.json GUARD-OWNED-ARTIFACT
rm "$TARGET/solution/counterfactual"
# The template selection that grants the harness and test roots lives in the control plane,
# which no lane can write, through a direct tool or through `template select`.
guard_as argus:atlas Write ai_agents_internal/template-selection.json GUARD-TARGET-IMMUTABLE
guard_as main Bash "argus-assets template select --target $TARGET --runtime typescript --package-manager npm --test-root quality/specs --harness-root quality/support --output ai_agents_internal/template-selection.json" GUARD-TARGET-IMMUTABLE
# Manifest validation keeps owned roots canonical, disjoint, and outside the canonical set.
node --input-type=module - "$ROOT" "$MANIFEST" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, manifestPath] = process.argv.slice(2);
const { validateEngagementManifest } = await import(pathToFileURL(join(root, 'argus/claude/lib/engagement.mjs')).href);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errorsFor = (mutate) => {
  const copy = structuredClone(manifest);
  mutate(copy.writePolicy);
  return validateEngagementManifest(copy);
};
const expectErrors = (label, errors, expected) => {
  if (expected === null ? errors.length !== 0 : !errors.includes(expected)) throw new Error(`${label}: ${JSON.stringify(errors)}`);
};
expectErrors('declared owned roots', errorsFor(() => {}), null);
expectErrors('omitted owned roots', errorsFor((policy) => { delete policy.ownedArtifactRoots; delete policy.selectedTemplateRoots; }), null);
const invalid = 'owned artifact root path or owners are invalid';
expectErrors('nested owned root', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'solution/counterfactual/nested', owners: ['atlas'] })), 'owned artifact roots overlap: solution/counterfactual/nested');
expectErrors('canonical owned root', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'run-tests.sh', owners: ['atlas'] })), 'owned artifact root is a canonical artifact: run-tests.sh');
expectErrors('control-plane owned root', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'ai_agents_internal/reports/lanes.tsv', owners: ['atlas'] })), invalid);
expectErrors('traversing owned root', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'solution/../app', owners: ['atlas'] })), invalid);
expectErrors('trailing-slash owned root', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'solution/fixtures/', owners: ['atlas'] })), invalid);
expectErrors('ownerless root', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'solution/fixtures', owners: [] })), invalid);
expectErrors('invalid owner', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'solution/fixtures', owners: ['Atlas'] })), invalid);
expectErrors('extra owned key', errorsFor((policy) => policy.ownedArtifactRoots.push({ path: 'solution/fixtures', owners: ['atlas'], mode: 'open' })), invalid);
expectErrors('invalid harness owners', errorsFor((policy) => { policy.selectedTemplateRoots = { harnessRootOwners: [] }; }), 'writePolicy.selectedTemplateRoots must name unique harnessRootOwners');
expectErrors('declared root config owners', errorsFor((policy) => { if (policy.selectedTemplateRoots.rootConfigOwners?.join() !== 'atlas') throw new Error('rootConfigOwners is not atlas'); }), null);
expectErrors('omitted root config owners', errorsFor((policy) => { delete policy.selectedTemplateRoots.rootConfigOwners; }), null);
expectErrors('invalid root config owners', errorsFor((policy) => { policy.selectedTemplateRoots.rootConfigOwners = []; }), 'writePolicy.selectedTemplateRoots.rootConfigOwners must name unique owners');
expectErrors('invalid root config owner', errorsFor((policy) => { policy.selectedTemplateRoots.rootConfigOwners = ['Atlas']; }), 'writePolicy.selectedTemplateRoots.rootConfigOwners must name unique owners');
expectErrors('extra selected-root key', errorsFor((policy) => { policy.selectedTemplateRoots.configOwners = ['atlas']; }), 'writePolicy.selectedTemplateRoots must name unique harnessRootOwners');
NODE

# The operator's explicit template selection grants its roots only in a disjoint layout: the
# test root to every lane and the shared harness root to Atlas, the lane automation engineers,
# and Asklepios. Any doubtful record grants nothing.
HARNESS_OWNERS='atlas, talos, daidalos, nike, aegis, mnemosyne, asklepios'
SELECTED="$WORK/selected-roots"
SELECTED_ROOT="$SELECTED/artifacts"
SELECTION="$SELECTED_ROOT/ai_agents_internal/template-selection.json"
mkdir -p "$SELECTED/target/src" "$SELECTED_ROOT"
printf 'export const app = 1;\n' >"$SELECTED/target/src/app.ts"
"$CLI" engagement init --target "$SELECTED/target" --artifact-root "$SELECTED_ROOT" --mode A --engagement-id selected-roots >/dev/null
guard_as argus:atlas Write quality/support/config.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write package.json GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
"$CLI" template select --target "$SELECTED_ROOT" --runtime typescript --package-manager npm \
  --test-root quality/specs --harness-root quality/support --output "$WORK/selected-roots.json" >/dev/null
cp "$WORK/selected-roots.json" "$SELECTION"
for lane in atlas talos daidalos nike aegis mnemosyne asklepios; do
  guard_as "argus:$lane" Write quality/support/config.ts allow "$SELECTED_ROOT"
done
guard_as argus:atlas Bash 'mkdir -p quality/support/fixtures' allow "$SELECTED_ROOT"
guard_as argus:hermes Write quality/support/config.ts "GUARD-OWNED-ARTIFACT: lane-owned quality/support is written only by $HARNESS_OWNERS, not hermes" "$SELECTED_ROOT"
guard_as argus:kleio Bash 'printf x > quality/support/report.ts' GUARD-OWNED-ARTIFACT "$SELECTED_ROOT"
guard_as main Write quality/support/config.ts 'not odysseus' "$SELECTED_ROOT"
guard_as untyped Write quality/support/config.ts 'the writing lane is not identified' "$SELECTED_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts allow "$SELECTED_ROOT"
guard_as argus:daidalos Write quality/specs/ui/cart.spec.ts allow "$SELECTED_ROOT"
guard_as argus:hermes Write quality/specs/perf/probe.spec.ts allow "$SELECTED_ROOT"
guard_as argus:atlas Write quality/other.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write "$SELECTED/target/src/app.ts" GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write solution/test-lanes.tsv allow "$SELECTED_ROOT"
# The selection also grants Atlas, and only Atlas, the framework's root runner and dependency
# configuration at the artifact root; without it no Mode A/C framework can run there.
for path in package.json package-lock.json playwright.config.ts tsconfig.json tsconfig.build.json pyproject.toml conftest.py \
  pytest.ini requirements.txt requirements-dev.txt pom.xml .gitignore argus-template.json scripts/app-source-guard.mjs; do
  guard_as argus:atlas Write "$path" allow "$SELECTED_ROOT"
done
guard_as argus:talos Write package.json 'GUARD-OWNED-ARTIFACT: lane-owned package.json is written only by atlas, not talos' "$SELECTED_ROOT"
guard_as argus:asklepios Bash 'printf x > tsconfig.json' 'GUARD-OWNED-ARTIFACT: lane-owned tsconfig.json is written only by atlas, not asklepios' "$SELECTED_ROOT"
guard_as main Write playwright.config.ts 'lane-owned playwright.config.ts is written only by atlas, not odysseus' "$SELECTED_ROOT"
guard_as untyped Write pom.xml 'lane-owned pom.xml is written only by atlas; the writing lane is not identified' "$SELECTED_ROOT"
for path in quality/package.json docs/tsconfig.json SECURITY-NOTES.md .claude/settings.json scripts/other.mjs Makefile; do
  guard_as argus:atlas Write "$path" GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
done
# A root configuration path through a symbolic link grants only what it physically names.
ln -s "$SELECTED/target/src/app.ts" "$SELECTED_ROOT/package.json"
ln -s "$SELECTED/target/src" "$SELECTED_ROOT/scripts"
guard_as argus:atlas Write package.json GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write scripts/app-source-guard.mjs GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
rm "$SELECTED_ROOT/package.json" "$SELECTED_ROOT/scripts"
# A manifest without rootConfigOwners grants no root configuration.
SELECTED_MANIFEST="$SELECTED_ROOT/ai_agents_internal/engagement.json"
cp "$SELECTED_MANIFEST" "$WORK/selected-manifest.json"
jq 'del(.writePolicy.selectedTemplateRoots.rootConfigOwners)' "$WORK/selected-manifest.json" >"$SELECTED_MANIFEST"
guard_as argus:atlas Write package.json GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write quality/support/config.ts allow "$SELECTED_ROOT"
cat "$WORK/selected-manifest.json" >"$SELECTED_MANIFEST"
# A URL target has no target root, and its artifact root receives the same grant.
URL_ROOT="$WORK/url-selected/artifacts"
mkdir -p "$URL_ROOT"
"$CLI" engagement init --target https://shop.example.test --artifact-root "$URL_ROOT" --mode A --engagement-id url-selected >/dev/null
guard_as argus:atlas Write package.json GUARD-TARGET-IMMUTABLE "$URL_ROOT"
"$CLI" template select --target "$URL_ROOT" --runtime typescript --package-manager npm \
  --test-root tests --harness-root harness --output "$WORK/url-selection.json" >/dev/null
cp "$WORK/url-selection.json" "$URL_ROOT/ai_agents_internal/template-selection.json"
guard_as argus:atlas Write package.json allow "$URL_ROOT"
guard_as argus:atlas Write harness/config.ts allow "$URL_ROOT"
guard_as argus:talos Write playwright.config.ts 'GUARD-OWNED-ARTIFACT: lane-owned playwright.config.ts is written only by atlas, not talos' "$URL_ROOT"
# Engagement-context scaffold and placement: Atlas scaffolds the selection into its worker
# staging directory, and the guard admits every staged file Atlas places at the same relative
# path under the artifact root, except the staged control plane, Claude settings, security
# notes, example ledger, and canonicals.
STAGED="$SELECTED_ROOT/ai_agents_internal/workers/atlas/scaffold"
guard_as argus:atlas Bash "argus-assets template scaffold --selection $SELECTION --destination $STAGED" allow "$SELECTED_ROOT"
(cd "$SELECTED_ROOT" && "$CLI" template scaffold --selection "$SELECTION" --destination "$STAGED") >/dev/null \
  || fail 'template scaffold into the Atlas worker staging directory failed inside the engagement'
CANONICALS="$(jq -r '.writePolicy.canonicalArtifacts[].path' "$SELECTED_MANIFEST")"
placed=0
while IFS= read -r path; do
  case "$path" in
    .claude/*|ai_agents_internal/*|SECURITY-NOTES.md|solution/bug-ledger.example.json) expected=GUARD-TARGET-IMMUTABLE ;;
    *) if grep -Fxq "$path" <<<"$CANONICALS"; then expected=GUARD-CANONICAL-SINGLE-WRITER; else expected=allow; placed=$((placed + 1)); fi ;;
  esac
  guard_as argus:atlas Bash "cp $STAGED/$path $path" "$expected" "$SELECTED_ROOT"
done < <(cd "$STAGED" && find . -type f ! -path './quality/*' | sed 's#^\./##' | sort)
for path in package.json package-lock.json playwright.config.ts tsconfig.json .gitignore argus-template.json scripts/app-source-guard.mjs; do
  [ -f "$STAGED/$path" ] || fail "the scaffold staged no $path"
done
[ "$placed" -ge 20 ] || fail "only $placed staged files are placeable at the artifact root"
guard_as argus:atlas Bash "cp $STAGED/$(cd "$STAGED" && find quality/support -type f | sort | head -n 1) quality/support/placed.ts" allow "$SELECTED_ROOT"
guard_as argus:talos Bash "cp $STAGED/$(cd "$STAGED" && find quality/specs -type f | sort | head -n 1) quality/specs/placed.spec.ts" allow "$SELECTED_ROOT"
rm -rf "$STAGED"
# A path target's workspace is the target root. A packaged command without --manifest still
# reaches the launch's engagement there, and from any directory below the artifact root; with
# no launch source and no engagement above it, it finds none, and a linked manifest is refused.
(cd "$SELECTED/target" && ARGUS_LAUNCH_ARTIFACT_ROOT="$SELECTED_ROOT" "$CLI" engagement status) | jq -e '.engagementId == "selected-roots"' >/dev/null \
  || fail 'engagement status without --manifest missed the launch engagement from the target workspace'
(cd "$SELECTED_ROOT/ai_agents_internal/workers" && "$CLI" engagement status) | jq -e '.engagementId == "selected-roots"' >/dev/null \
  || fail 'engagement status without --manifest missed the engagement above its working directory'
if (cd "$SELECTED/target" && "$CLI" engagement status) >"$WORK/no-engagement.out" 2>&1; then
  fail 'engagement status found an engagement from a workspace with no launch source'
fi
grep -Fq 'engagement manifest must be a real file' "$WORK/no-engagement.out" || fail "a workspace without an engagement failed for another reason: $(<"$WORK/no-engagement.out")"
ln -s "$SELECTED_MANIFEST" "$WORK/linked-engagement.json"
if (cd "$SELECTED/target" && ARGUS_ENGAGEMENT_MANIFEST="$WORK/linked-engagement.json" "$CLI" engagement status) >"$WORK/linked-engagement.out" 2>&1; then
  fail 'engagement status accepted a symbolic-link manifest'
fi
grep -Fq 'engagement manifest must be a real file' "$WORK/linked-engagement.out" || fail "a linked manifest failed for another reason: $(<"$WORK/linked-engagement.out")"
selected_record() {
  jq "$@" "$WORK/selected-roots.json" >"$SELECTION"
}
selected_record '.harnessRoot = "ai_agents_internal/support"'
guard_as argus:atlas Write ai_agents_internal/support/config.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts allow "$SELECTED_ROOT"
selected_record '.harnessRoot = "scripts"'
guard_as argus:atlas Write scripts/generated-helper.sh GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write scripts/runner-lib.sh allow "$SELECTED_ROOT"
selected_record '.harnessRoot = "reports"'
guard_as argus:talos Write reports/run.json allow "$SELECTED_ROOT"
selected_record '.harnessRoot = "solution"'
guard_as argus:atlas Write solution/harness.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
selected_record '.harnessRoot = "../target/src"'
guard_as argus:atlas Write ../target/src/app.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
selected_record '.choiceSource = "inferred"'
guard_as argus:talos Write quality/specs/api/orders.spec.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:atlas Write package.json GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
selected_record --arg root "$SELECTED/target" '.targetRoot = $root'
guard_as argus:talos Write quality/specs/api/orders.spec.ts allow "$SELECTED_ROOT"
selected_record '.targetRoot = "/nonexistent/argus-selection-root"'
guard_as argus:talos Write quality/specs/api/orders.spec.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
# An ADAPT record may nest the test root inside the harness root; the nested test root stays open.
selected_record '.action = "adapt" | .harnessRoot = "quality" | .testRoot = "quality/specs"'
guard_as argus:atlas Write quality/support/config.ts allow "$SELECTED_ROOT"
guard_as argus:hermes Write quality/support/config.ts "GUARD-OWNED-ARTIFACT: lane-owned quality is written only by $HARNESS_OWNERS, not hermes" "$SELECTED_ROOT"
guard_as argus:hermes Write quality/specs/api/orders.spec.ts allow "$SELECTED_ROOT"
guard_as argus:atlas Write pyproject.toml allow "$SELECTED_ROOT"
# A symbolic link on a selected root, or a linked record, grants nothing.
cp "$WORK/selected-roots.json" "$SELECTION"
mkdir -p "$SELECTED_ROOT/quality"
ln -s ../ai_agents_internal "$SELECTED_ROOT/quality/support"
guard_as argus:atlas Write quality/support/forged.json GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts allow "$SELECTED_ROOT"
rm "$SELECTED_ROOT/quality/support"
rm "$SELECTION"
ln -s "$WORK/selected-roots.json" "$SELECTION"
guard_as argus:atlas Write quality/support/config.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts GUARD-TARGET-IMMUTABLE "$SELECTED_ROOT"
rm "$SELECTION"
# When the artifact root is the target root, a selection would cover target source: nothing is granted.
jq --arg root "$TARGET" '.targetRoot = $root | .harnessRoot = "app"' "$WORK/selected-roots.json" >"$TARGET/ai_agents_internal/template-selection.json"
guard_as argus:atlas Write app/source.ts GUARD-TARGET-IMMUTABLE
guard_as argus:talos Write quality/specs/api/orders.spec.ts GUARD-TARGET-IMMUTABLE
guard_as argus:atlas Write package.json GUARD-TARGET-IMMUTABLE
rm "$TARGET/ai_agents_internal/template-selection.json"

# The record reaches the control plane only through the host-side `template verify|install`
# that argus-launch --template-selection runs before the sandbox: bound to the launch target
# or artifact root and to that tree's current capabilities, never replacing another record,
# and never into a started engagement. Inside an engagement the guard denies both verbs.
INSTALL_CASE="$WORK/install-selection"
mkdir -p "$INSTALL_CASE/target/src" "$INSTALL_CASE/operator" "$INSTALL_CASE/other"
chmod 700 "$INSTALL_CASE/operator"
INSTALL_CASE="$(cd "$INSTALL_CASE" && pwd -P)"
INSTALL_TARGET="$INSTALL_CASE/target"
INSTALL_ROOT="$INSTALL_CASE/artifacts"
OPERATOR_SELECTION="$INSTALL_CASE/operator/template-selection.json"
printf 'export const app = 1;\n' >"$INSTALL_TARGET/src/app.ts"
"$CLI" template select --target "$INSTALL_TARGET" --runtime typescript --package-manager npm \
  --test-root quality/specs --harness-root quality/support --output "$OPERATOR_SELECTION" >/dev/null
# Usage: selection_step <verify|install> [<selection>] [<artifact-root>]
selection_step() {
  "$CLI" template "$1" --selection "${2:-$OPERATOR_SELECTION}" --artifact-root "${3:-$INSTALL_ROOT}" \
    --target "$INSTALL_TARGET" >"$WORK/selection-step.out" 2>&1
}
expect_selection_refusal() {
  local message="$1"
  shift
  if selection_step "$@"; then fail "template ${1} accepted a record it must refuse: $message"; fi
  grep -Fq -- "$message" "$WORK/selection-step.out" || fail "template ${1} refusal did not report: $message: $(<"$WORK/selection-step.out")"
}
selection_step verify || fail "template verify refused a valid record before the artifact root exists: $(<"$WORK/selection-step.out")"
grep -Fq 'TEMPLATE  verified runtime=typescript action=build testRoot=quality/specs harnessRoot=quality/support' "$WORK/selection-step.out" \
  || fail "template verify did not report the record: $(<"$WORK/selection-step.out")"
test ! -e "$INSTALL_ROOT" || fail 'template verify created the artifact root'
expect_selection_refusal 'template install artifact root is unavailable' install
mkdir -m 700 "$INSTALL_ROOT"
selection_step install || fail "template install refused a valid record: $(<"$WORK/selection-step.out")"
cmp -s "$OPERATOR_SELECTION" "$INSTALL_ROOT/ai_agents_internal/template-selection.json" || fail 'template install did not copy the exact record'
[ -n "$(find "$INSTALL_ROOT/ai_agents_internal/template-selection.json" -maxdepth 0 -type f -perm 600 -print)" ] || fail 'installed template selection is not mode 0600'
selection_step install || fail "reinstalling the same record was refused: $(<"$WORK/selection-step.out")"
grep -Fq 'TEMPLATE  unchanged' "$WORK/selection-step.out" || fail "reinstalling the same record was not idempotent: $(<"$WORK/selection-step.out")"
jq '.harnessRoot = "quality/shared"' "$OPERATOR_SELECTION" >"$INSTALL_CASE/operator/changed.json"
chmod 600 "$INSTALL_CASE/operator/changed.json"
expect_selection_refusal 'a different template selection already exists' install "$INSTALL_CASE/operator/changed.json"
jq --arg root "$INSTALL_CASE/other" '.targetRoot = $root' "$OPERATOR_SELECTION" >"$INSTALL_CASE/operator/foreign.json"
chmod 600 "$INSTALL_CASE/operator/foreign.json"
expect_selection_refusal 'targetRoot must name the launch target or the artifact root' verify "$INSTALL_CASE/operator/foreign.json"
jq '.choiceSource = "inferred"' "$OPERATOR_SELECTION" >"$INSTALL_CASE/operator/inferred.json"
chmod 600 "$INSTALL_CASE/operator/inferred.json"
expect_selection_refusal 'does not satisfy its schema' verify "$INSTALL_CASE/operator/inferred.json"
cp -p "$OPERATOR_SELECTION" "$INSTALL_ROOT/selection-copy.json"
expect_selection_refusal 'must stay outside the target and artifact roots' verify "$INSTALL_ROOT/selection-copy.json"
ln -s "$OPERATOR_SELECTION" "$INSTALL_CASE/operator/linked.json"
expect_selection_refusal 'must be a physical single-link regular file' verify "$INSTALL_CASE/operator/linked.json"
printf '{"devDependencies":{"jest":"29.0.0"}}\n' >"$INSTALL_TARGET/package.json"
expect_selection_refusal 'operator template selection is stale' verify
rm "$INSTALL_TARGET/package.json"
# The installed record grants its roots once the engagement starts, and nothing can add one later.
"$CLI" engagement init --target "$INSTALL_TARGET" --artifact-root "$INSTALL_ROOT" --mode A --engagement-id install-selection >/dev/null
guard_as argus:atlas Write quality/support/config.ts allow "$INSTALL_ROOT"
guard_as argus:hermes Write quality/support/config.ts "GUARD-OWNED-ARTIFACT: lane-owned quality/support is written only by $HARNESS_OWNERS, not hermes" "$INSTALL_ROOT"
guard_as argus:talos Write quality/specs/api/orders.spec.ts allow "$INSTALL_ROOT"
for operation in verify install; do
  guard_as main Bash "argus-assets template $operation --selection $OPERATOR_SELECTION --artifact-root $INSTALL_ROOT --target $INSTALL_TARGET" \
    'GUARD-SHELL-AMBIGUOUS: template selection verify/install is host/operator-only' "$INSTALL_ROOT"
done
mkdir -m 700 "$INSTALL_CASE/started"
"$CLI" engagement init --target "$INSTALL_TARGET" --artifact-root "$INSTALL_CASE/started" --mode A --engagement-id install-started >/dev/null
expect_selection_refusal 'the engagement in this artifact root has already started' install "$OPERATOR_SELECTION" "$INSTALL_CASE/started"
test ! -e "$INSTALL_CASE/started/ai_agents_internal/template-selection.json" || fail 'template install added a record to a started engagement'
# Executed from inside the engagement, the allowed queries leave the artifact tree untouched.
COVERAGE_FIXTURES="$ROOT/scripts/fixtures/argus-coverage"
COVERAGE_EVIDENCE=(--evidence "$COVERAGE_FIXTURES/evidence-reference.json" --ledger "$COVERAGE_FIXTURES/bug-ledger.json" --root "$COVERAGE_FIXTURES")
touch "$WORK/query-marker"
(
  cd "$TARGET"
  "$CLI" technique scopes --role atalanta >/dev/null
  "$CLI" technique select --role atalanta --inventory "$COVERAGE_FIXTURES/surface-inventory.json" >/dev/null
  "$CLI" raci list >/dev/null
  "$CLI" raci route --artifact solution/coverage-result.json >/dev/null
  "$CLI" coverage validate --inventory "$COVERAGE_FIXTURES/surface-inventory.json" --observations "$COVERAGE_FIXTURES/coverage-observations.json" "${COVERAGE_EVIDENCE[@]}" >/dev/null
  "$CLI" coverage calculate --inventory "$COVERAGE_FIXTURES/surface-inventory.json" --observations "$COVERAGE_FIXTURES/coverage-observations.json" "${COVERAGE_EVIDENCE[@]}" >/dev/null
)
[ -z "$(find "$TARGET" -newer "$WORK/query-marker" -print -quit)" ] || fail 'a read-only packaged query modified the engagement tree'
(cd "$TARGET" && "$CLI" coverage calculate --inventory "$COVERAGE_FIXTURES/surface-inventory.json" \
  --observations "$COVERAGE_FIXTURES/coverage-observations.json" "${COVERAGE_EVIDENCE[@]}" --output reports/coverage-result.json >/dev/null)
jq -e '.overall' "$TARGET/reports/coverage-result.json" >/dev/null || fail 'coverage calculate did not write an allowed report output'
if (cd "$TARGET" && "$CLI" coverage calculate --inventory "$COVERAGE_FIXTURES/surface-inventory.json" \
  --observations "$COVERAGE_FIXTURES/coverage-observations.json" "${COVERAGE_EVIDENCE[@]}" --output solution/coverage-result.json >/dev/null 2>&1); then
  fail 'coverage calculate wrote a canonical artifact outside its owner merge'
fi
test ! -e "$TARGET/solution/coverage-result.json" || fail 'denied coverage calculation created a canonical artifact'
# A path target's default workspace is the target, outside the physically disjoint artifact
# root, so the walk up from the working directory never reaches the engagement. The launch
# names it instead: the directory of the attested receipt, or the unattested
# ARGUS_LAUNCH_ARTIFACT_ROOT. With either, the guard and the CLI write self-check hold from
# cwd=target exactly as from inside the artifact root, and before preflight has created the
# manifest the session stays open.
DISJOINT_RECEIPT="$INSTALL_ROOT/ai_agents_internal/native-launch-receipt.json"
# Usage: launched <receipt|root> <command...>
launched() {
  local source="$1"
  shift
  case "$source" in
    receipt) ( export ARGUS_NATIVE_LAUNCH_RECEIPT="$DISJOINT_RECEIPT"; "$@" ) ;;
    root) ( export ARGUS_LAUNCH_ARTIFACT_ROOT="$INSTALL_ROOT"; "$@" ) ;;
    *) fail "unknown launch source $source" ;;
  esac
}
guard_as argus:atalanta Write "$INSTALL_ROOT/ai_agents_internal/authorization.json" allow "$INSTALL_TARGET"
printf '{"password":"disjoint-sentinel"}\n' >"$WORK/disjoint-input.json"
for source in receipt root; do
  for control in authorization.json engagement.json engagement-state.json; do
    launched "$source" guard_as argus:atalanta Write "$INSTALL_ROOT/ai_agents_internal/$control" GUARD-TARGET-IMMUTABLE "$INSTALL_TARGET"
  done
  launched "$source" guard_as argus:minos Write "$INSTALL_ROOT/solution/bug-ledger.json" GUARD-CANONICAL-SINGLE-WRITER "$INSTALL_TARGET"
  launched "$source" guard_as argus:atalanta Bash "printf x > $INSTALL_ROOT/solution/bug-ledger.json" GUARD-CANONICAL-SINGLE-WRITER "$INSTALL_TARGET"
  launched "$source" guard_as argus:talos Write "$INSTALL_ROOT/scripts/runner-lib.sh" GUARD-OWNED-ARTIFACT "$INSTALL_TARGET"
  launched "$source" guard_as argus:atlas Write "$INSTALL_ROOT/quality/support/config.ts" allow "$INSTALL_TARGET"
  launched "$source" guard_as argus:atlas Write "$INSTALL_TARGET/src/app.ts" GUARD-TARGET-IMMUTABLE "$INSTALL_TARGET"
  # A packaged command without --manifest reaches the launch's engagement from the target workspace.
  (cd "$INSTALL_TARGET" && launched "$source" "$CLI" engagement status) \
    | jq -e --arg id "$(jq -r .engagementId "$INSTALL_ROOT/ai_agents_internal/engagement.json")" '.engagementId == $id' >/dev/null \
    || fail "engagement status without --manifest missed the launch engagement from the target workspace ($source)"
  # The main smoke engagement is a different manifest than the launch names: deny, never pick one.
  launched "$source" guard_as main Bash 'argus-assets list' 'GUARD-MANIFEST-INVALID: the active engagement cannot be resolved' "$TARGET"
  if (cd "$INSTALL_TARGET" && launched "$source" "$CLI" redact --input "$WORK/disjoint-input.json" \
    --output "$INSTALL_ROOT/solution/bug-ledger.json") >"$WORK/disjoint.out" 2>&1; then
    fail "redact wrote a canonical artifact from a disjoint workspace ($source)"
  fi
  grep -Fq 'redaction output denied by active engagement rule GUARD-CANONICAL-SINGLE-WRITER' "$WORK/disjoint.out" \
    || fail "disjoint redact ($source) failed for the wrong reason: $(<"$WORK/disjoint.out")"
  if (cd "$INSTALL_TARGET" && launched "$source" "$CLI" authorization check --manifest "$INSTALL_ROOT/ai_agents_internal/authorization.json" \
    --lane atalanta --action read --target "$INSTALL_TARGET" --source-trust manifest --at 2026-07-10T12:00:00.000Z) >"$WORK/disjoint.out" 2>&1; then
    fail "authorization check --at ran inside a disjoint-workspace engagement ($source)"
  fi
  grep -Fq 'refused while an engagement is active' "$WORK/disjoint.out" || fail "disjoint --at ($source) failed for the wrong reason: $(<"$WORK/disjoint.out")"
done
if (cd "$INSTALL_TARGET" && launched receipt "$CLI" coverage calculate --inventory "$COVERAGE_FIXTURES/surface-inventory.json" \
  --observations "$COVERAGE_FIXTURES/coverage-observations.json" "${COVERAGE_EVIDENCE[@]}" \
  --output "$INSTALL_ROOT/solution/coverage-result.json") >"$WORK/disjoint.out" 2>&1; then
  fail 'coverage calculate wrote the canonical coverage result from a disjoint workspace'
fi
test ! -e "$INSTALL_ROOT/solution/bug-ledger.json" && test ! -e "$INSTALL_ROOT/solution/coverage-result.json" \
  || fail 'a denied disjoint-workspace command created a canonical artifact'
# Before preflight creates the manifest, the launch source names nothing yet: the controller's
# preflight must pass. A manifest that ARGUS_ENGAGEMENT_MANIFEST names but that does not exist
# denies, as it does for every engagement command.
mkdir -m 700 "$INSTALL_CASE/fresh-artifacts"
(export ARGUS_LAUNCH_ARTIFACT_ROOT="$INSTALL_CASE/fresh-artifacts" && guard_as main Bash \
  "argus-assets preflight --target $INSTALL_TARGET --mode A --artifact-root $INSTALL_CASE/fresh-artifacts --engagement-id fresh" allow "$INSTALL_TARGET")
(export ARGUS_NATIVE_LAUNCH_RECEIPT="$INSTALL_CASE/fresh-artifacts/ai_agents_internal/native-launch-receipt.json" && guard_as main Bash \
  "argus-assets preflight --target $INSTALL_TARGET --mode A --artifact-root $INSTALL_CASE/fresh-artifacts --engagement-id fresh" allow "$INSTALL_TARGET")
(export ARGUS_ENGAGEMENT_MANIFEST="$INSTALL_CASE/fresh-artifacts/ai_agents_internal/engagement.json" && guard_as main Bash 'argus-assets list' \
  'GUARD-MANIFEST-INVALID: the active engagement cannot be resolved: ARGUS_ENGAGEMENT_MANIFEST does not name an existing engagement manifest' "$INSTALL_TARGET")
# Every packaged command family and operation that a prompt references must be classified;
# only the final default deny and the per-family "unknown <family> operation" denials mean unclassified.
node --input-type=module - "$ROOT" "$MANIFEST" "$TARGET" <<'NODE'
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, manifestPath, cwd] = process.argv.slice(2);
const { evaluateWriteGuard } = await import(pathToFileURL(join(root, 'argus/claude/lib/engagement.mjs')).href);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const walk = (dir, keep) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name), keep) : keep(entry.name) ? [join(dir, entry.name)] : []);
const sources = [
  ...walk(join(root, 'argus/roles'), (name) => name.endsWith('.md')),
  ...walk(join(root, 'argus/shared-skills'), (name) => name === 'SKILL.md'),
  join(root, 'argus/claude/skills/run/SKILL.md'),
  ...walk(join(root, 'argus/claude/agents'), (name) => name.endsWith('.md')),
];
const references = new Map();
for (const source of sources) {
  const text = readFileSync(source, 'utf8');
  const fenced = /^```[^\n]*\n([\s\S]*?)^```/gm;
  const spans = [...text.matchAll(fenced), ...text.replace(fenced, '').matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  for (const span of spans) {
    for (const match of span.matchAll(/(?:^|[\s(])argus-assets\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
      const command = ['argus-assets', match[1], match[2]].filter(Boolean).join(' ');
      if (!references.has(command)) references.set(command, relative(root, source));
    }
  }
}
if (references.size < 10) throw new Error(`prompt corpus scan found only ${references.size} packaged command references`);
const unclassified = [];
for (const [command, source] of references) {
  const decision = evaluateWriteGuard({ manifest, manifestPath, payload: { tool_name: 'Bash', tool_input: { command } }, cwd });
  const familyOnly = command.split(' ').length === 2;
  if (familyOnly ? decision.reason === 'unknown packaged command operation' : decision.reason.startsWith('unknown ')) {
    unclassified.push(`${source}: ${command} -> ${decision.ruleId}: ${decision.reason}`);
  }
}
if (unclassified.length) throw new Error(`prompt-referenced packaged commands are unclassified by the write guard:\n${unclassified.join('\n')}`);
NODE
guard_shell "argus-assets model trust --manifest $MANIFEST --runtime-key-id runtime --operator-key-id operator" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model trust --manifest $MANIFEST --manifest $WORK/alternate-engagement.json --runtime-key-id runtime --operator-key-id operator" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model trust --manifest $WORK/alternate-engagement.json --runtime-key-id runtime --operator-key-id operator" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model request --manifest $MANIFEST --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 --checkpoint-ref ai_agents_internal/checkpoints/aegis/00000001.json" allow
# Model telemetry takes exactly one of an immutable decision file or an inline single-line
# --json batch; a batch never arrives through a file, stdin, heredoc, here-string, or pipe.
TELEMETRY_BATCH='{"events":[{"decisionId":"MDR-000000000000000000000000","inputTokens":1200,"outputTokens":300,"durationMs":4500,"success":true}]}'
TELEMETRY_DECISION="$TARGET/ai_agents_internal/model-decisions/MDR-000000000000000000000000.json"
guard_shell "argus-assets model telemetry --manifest $MANIFEST --json '$TELEMETRY_BATCH' --controller-token $CONTROLLER_TOKEN" allow
guard_shell "argus-assets model telemetry --manifest $MANIFEST --decision $TELEMETRY_DECISION --token $CONTROLLER_TOKEN --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true" allow
guard_shell "argus-assets model telemetry --manifest $MANIFEST --decision $TELEMETRY_DECISION --json '$TELEMETRY_BATCH' --controller-token $CONTROLLER_TOKEN" \
  'GUARD-SHELL-AMBIGUOUS: model telemetry requires exactly one of an immutable --decision file or an inline --json batch'
guard_shell "argus-assets model telemetry --manifest $MANIFEST --controller-token $CONTROLLER_TOKEN" \
  'GUARD-SHELL-AMBIGUOUS: model telemetry requires exactly one of an immutable --decision file or an inline --json batch'
guard_shell "argus-assets model telemetry --manifest $WORK/alternate-engagement.json --json '$TELEMETRY_BATCH' --controller-token $CONTROLLER_TOKEN" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model telemetry --manifest $MANIFEST --json reports/telemetry-batch.json --controller-token $CONTROLLER_TOKEN" \
  'GUARD-SHELL-AMBIGUOUS: batch --json input must be one inline single-line JSON object'
guard_shell $'argus-assets model telemetry --manifest '"$MANIFEST"$' --json - --controller-token '"$CONTROLLER_TOKEN"$' <<\'BATCH\'\n'"$TELEMETRY_BATCH"$'\nBATCH' \
  'GUARD-SHELL-AMBIGUOUS: packaged command must be one exact standalone invocation'
guard_shell $'argus-assets model telemetry --manifest '"$MANIFEST"$' --json "$(cat <<\'BATCH\'\n'"$TELEMETRY_BATCH"$'\nBATCH\n)" --controller-token '"$CONTROLLER_TOKEN" \
  'GUARD-SHELL-AMBIGUOUS: packaged command must be one exact standalone invocation'
guard_shell "printf '%s' '$TELEMETRY_BATCH' | argus-assets model telemetry --manifest $MANIFEST --json - --controller-token $CONTROLLER_TOKEN" \
  'GUARD-SHELL-AMBIGUOUS: packaged command must be one exact standalone invocation'
guard_shell "argus-assets model telemetry --manifest $MANIFEST --json '$TELEMETRY_BATCH' --controller-token $CONTROLLER_TOKEN <<< '$TELEMETRY_BATCH'" \
  'GUARD-SHELL-AMBIGUOUS: batch input is inline only'
# The other controller-authority forms are bounded engagement mutations of the active manifest.
guard_shell "argus-assets engagement barrier arrive --manifest $MANIFEST --phase discovery --json '{\"lanes\":[\"kalchas\"]}' --controller-token $CONTROLLER_TOKEN" allow
guard_shell "argus-assets engagement cleanup --manifest $MANIFEST --json '{\"cleanups\":[{\"lane\":\"kalchas\",\"outcome\":\"interrupted\"}]}' --controller-token $CONTROLLER_TOKEN" allow
guard_shell "argus-assets engagement start-attempt --manifest $MANIFEST --lane kalchas --decision $TELEMETRY_DECISION --controller-token $CONTROLLER_TOKEN" allow
guard_shell "argus-assets model request --manifest $MANIFEST --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 --checkpoint-ref ai_agents_internal/checkpoints/aegis/00000001.json --controller-token $CONTROLLER_TOKEN" allow
guard_shell "argus-assets engagement cleanup --manifest $MANIFEST --json - --controller-token $CONTROLLER_TOKEN" \
  'GUARD-SHELL-AMBIGUOUS: batch --json input must be one inline single-line JSON object'
guard_shell "argus-assets model route --manifest $MANIFEST --manifest $WORK/alternate-engagement.json --agent aegis --runtime claude --signal normal --dispatch-id duplicate-manifest --attempt 1" GUARD-SHELL-AMBIGUOUS
if "$CLI" model route --manifest "$MANIFEST" --manifest "$MANIFEST" --agent aegis --runtime claude --signal normal --dispatch-id duplicate-manifest --attempt 1 >/dev/null 2>&1; then
  fail 'model route accepted duplicate --manifest options'
fi
"$CLI" orchestration plan --mode A --artifact-root "$TARGET" --output ai_agents_internal/orchestration-plan.json >/dev/null
plan_digest="$(digest_file "$TARGET/ai_agents_internal/orchestration-plan.json")"
"$CLI" orchestration plan --mode A --artifact-root "$TARGET" --output ai_agents_internal/orchestration-plan.json >/dev/null
[ "$plan_digest" = "$(digest_file "$TARGET/ai_agents_internal/orchestration-plan.json")" ] || fail 'orchestration plan replay changed the persisted projection'
if "$CLI" orchestration plan --mode B --artifact-root "$TARGET" --output ai_agents_internal/orchestration-plan.json >/dev/null 2>&1; then
  fail 'orchestration plan replay replaced an existing projection with a different mode'
fi

# An exact operator bypass works only with its secret token and is audited without raw commands.
BYPASS_TOKEN='operator-approved-phase0-bypass'
node - "$MANIFEST" "$BYPASS_TOKEN" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const [path, token] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.writePolicy.bypass = {
  enabled: true,
  approvedBy: 'phase0-smoke-operator',
  reason: 'Verify exact-path bypass enforcement',
  expiresAt: '2099-01-01T00:00:00.000Z',
  allowedPaths: ['app/approved-output.txt'],
  tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
};
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
output="$(jq -nc --arg cwd "$TARGET" '{tool_name:"Write",cwd:$cwd,tool_input:{file_path:"app/approved-output.txt",content:"safe"}}' | \
  ARGUS_IMMUTABILITY_BYPASS_TOKEN="$BYPASS_TOKEN" "$CLI" guard)"
[ -z "$output" ] || fail "exact bypass was denied: $output"
guard_write app/not-approved.txt GUARD-TARGET-IMMUTABLE
AUDIT="$TARGET/ai_agents_internal/immutability-audit.jsonl"
grep -Fq 'GUARD-EXPLICIT-BYPASS' "$AUDIT" || fail "bypass was not audited"
grep -Fq 'GUARD-SHELL-AMBIGUOUS' "$AUDIT" || fail "ambiguous subprocess denial was not audited"
if grep -Fq 'supersecret' "$AUDIT"; then fail "immutability audit leaked raw command content"; fi
node - "$AUDIT" <<'NODE'
const fs = require('fs');
for (const [index, line] of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').entries()) {
  const event = JSON.parse(line);
  for (const key of ['$schema', 'schemaVersion', 'timestamp', 'engagementId', 'tool', 'decision', 'ruleId', 'reason', 'paths', 'commandSha256']) {
    if (!(key in event)) throw new Error(`audit event ${index + 1} missing ${key}`);
  }
  if (event.command) throw new Error(`audit event ${index + 1} contains raw command`);
}
NODE

# Conditional lanes: resolve-gates re-checks Kalchas's capability evidence once, in discovery.
# The sealed main engagement has no conditional lanes, so resolution is a read-only no-op.
[ "$("$CLI" engagement resolve-gates --manifest "$MANIFEST")" = 'GATES  none' ] || fail 'resolve-gates without conditional lanes did not report none'
[ "$("$CLI" engagement status --manifest "$MANIFEST" | jq -c '[.conditionalAgents, .gateResolution]')" = '[{},null]' ] \
  || fail 'model-control sealing did not bind an empty conditional map'

# Each scenario gets a fresh engagement whose target root is disjoint from its artifact root.
# The conditional map is bound through the packaged runtime before Odysseus and Kalchas
# allocate; Kalchas then merges the surface inventory and arrives at discovery.
prepare_conditional_engagement() {
  local name="$1" conditional="$2" base="$WORK/conditional-$1"
  mkdir -p "$base/target/src/server" "$base/target/tests" "$base/artifacts"
  printf 'export const orders = [];\n' >"$base/target/src/server/orders.ts"
  printf 'test("orders", () => {});\n' >"$base/target/tests/orders.spec.ts"
  "$CLI" engagement init --target "$base/target" --artifact-root "$base/artifacts" --mode A --engagement-id "conditional-$name" >/dev/null
  node --input-type=module - "$ROOT" "$base/artifacts/ai_agents_internal/engagement.json" "$conditional" \
    "$ROOT/scripts/fixtures/argus-coverage/surface-inventory.json" >"$base/tokens.json" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, manifestPath, conditional, inventoryPath] = process.argv.slice(2);
const runtime = await import(pathToFileURL(join(root, 'argus/claude/lib/engagement.mjs')).href);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const binding = (seed) => {
  const digest = createHash('sha256').update(`${manifest.engagementId}:${seed}`).digest('hex');
  return { modelDecisionId: `MDR-${digest.slice(0, 24)}`, modelDecisionIntegritySha256: digest, dispatchId: `dispatch:${seed}`, attempt: 1, runtime: 'claude' };
};
runtime.bindDispatchableAgents(manifest, manifest.selectedAgents, JSON.parse(conditional));
const controller = runtime.allocateWorker(manifest, 'odysseus', { executionBinding: binding('odysseus') });
const kalchas = runtime.allocateWorker(manifest, 'kalchas', { controllerToken: controller.token, executionBinding: binding('kalchas') });
const inventory = { ...JSON.parse(readFileSync(inventoryPath, 'utf8')), engagementId: manifest.engagementId };
runtime.writeFragment(manifest, 'kalchas', kalchas.token, 'solution/surface-inventory.json', 'recon-inventory', `${JSON.stringify(inventory)}\n`);
runtime.mergeCanonical(manifest, 'kalchas', kalchas.token, 'solution/surface-inventory.json');
runtime.arriveBarrier(manifest, 'kalchas', kalchas.token, 'discovery');
console.log(JSON.stringify({ controller: controller.token, kalchas: kalchas.token }));
NODE
}

# The P-06 fixture, rebound to this engagement: source-access points at <source-root>, and
# existing-suite plus non-rest-surface (surface id <surface>) are proven for the scenario.
write_capability_evidence() {
  local base="$1" source_root="$2" read_file="$3" surface="${4:-SRF-API-ORDERS-POST}"
  mkdir -p "$base/artifacts/solution/discovery"
  jq --arg id "$(jq -r .engagementId "$base/artifacts/ai_agents_internal/engagement.json")" --arg surface "$surface" \
    --arg src "$source_root" --arg file "$read_file" --arg suite "$base/target/tests" --arg test "$base/target/tests/orders.spec.ts" '
    .engagementId = $id
    | .gates |= map(
        if .capability == "source-access" then .proof.path = $src | .proof.fileRead = $file
        elif .capability == "existing-suite" then
          .verdict = "proven" | .summary = "The target ships a runnable test suite." | .evidenceIds = ["EVD-0005"]
          | .proof = {kind: "suite-root", path: $suite, runner: "vitest", testFile: $test}
        elif .capability == "non-rest-surface" then
          .verdict = "proven" | .summary = "Order creation is also exposed over GraphQL." | .evidenceIds = ["EVD-0006"]
          | .proof = {kind: "protocol-surface", protocols: ["graphql"], surfaceIds: [$surface]}
        else . end)' \
    "$ROOT/scripts/fixtures/argus-schemas/valid/capability-evidence.json" >"$base/artifacts/solution/discovery/capability-evidence.json"
}

# A host-provisioned fake Playwright comes first in candidate order, so the browser gate's
# functional re-probe is deterministic whatever else the host has installed.
CONDITIONAL_HOME="$WORK/conditional-home"
mkdir -p "$CONDITIONAL_HOME/.cache/argus/browser-runtime/0.0.1/node_modules"
cp -R "$ROOT/scripts/fixtures/argus-preflight/fake-playwright" "$CONDITIONAL_HOME/.cache/argus/browser-runtime/0.0.1/node_modules/playwright"

# Full scenario: every recon-provable gate is re-checked and released; db-access and
# multi-service stay unmet although Kalchas recorded them as proven.
prepare_conditional_engagement gates \
  '{"asklepios":["existing-suite"],"charon":["db-access"],"orion":["browser-runtime"],"pistis":["multi-service"],"proteus":["non-rest-surface"],"tiresias":["source-access"]}'
GATES="$WORK/conditional-gates"
GATES_MANIFEST="$GATES/artifacts/ai_agents_internal/engagement.json"
GATES_CONTROLLER="$(jq -r .controller "$GATES/tokens.json")"
write_capability_evidence "$GATES" "$GATES/target/src" "$GATES/target/src/server/orders.ts"
if gate_output="$(HOME="$CONDITIONAL_HOME" "$CLI" engagement resolve-gates --manifest "$GATES_MANIFEST" --controller-token "$(jq -r .kalchas "$GATES/tokens.json")" 2>&1)"; then
  fail 'resolve-gates accepted a worker token as the controller token'
fi
grep -Fq 'invalid or inactive lease for odysseus' <<<"$gate_output" || fail "worker-token resolve-gates failed for the wrong reason: $gate_output"
test ! -e "$GATES/artifacts/ai_agents_internal/browser-runtime.json" || fail 'a refused resolve-gates re-probed the browser runtime'
if gate_output="$(HOME="$CONDITIONAL_HOME" "$CLI" engagement resolve-gates --manifest "$GATES_MANIFEST" --controller-token "$GATES_CONTROLLER" \
  --evidence reports/capability-evidence.json 2>&1)"; then
  fail 'resolve-gates read capability evidence outside solution/discovery'
fi
grep -Fq 'capability evidence must be a file under <artifactRoot>/solution/discovery' <<<"$gate_output" || fail "misplaced evidence failed for the wrong reason: $gate_output"
# A lane can plant a Playwright package anywhere under the artifact root. Run from the artifact
# root, so the workspace candidate resolves there too: the re-probe must refuse it unimported.
mkdir -p "$GATES/artifacts/node_modules"
cp -R "$ROOT/scripts/fixtures/argus-preflight/fake-playwright" "$GATES/artifacts/node_modules/playwright"
{
  printf 'import { writeFileSync } from "node:fs";\n'
  printf 'writeFileSync(new URL("../../planted-module-ran", import.meta.url), "imported\\n");\n'
  cat "$ROOT/scripts/fixtures/argus-preflight/fake-playwright/index.mjs"
} >"$GATES/artifacts/node_modules/playwright/index.mjs"
(cd "$GATES/artifacts" && HOME="$CONDITIONAL_HOME" ARGUS_ENGAGEMENT_CONTROLLER_TOKEN="$GATES_CONTROLLER" \
  "$CLI" engagement resolve-gates --manifest "$GATES_MANIFEST") >"$WORK/resolve-gates.json"
test ! -e "$GATES/artifacts/planted-module-ran" || fail 'resolve-gates imported a Playwright package planted inside the artifact root'
jq -e --arg planted "$(cd "$GATES/artifacts/node_modules/playwright" && pwd -P)" '
  ([.candidates[] | select(.modulePath == $planted)] == [{source: "workspace", modulePath: $planted, result: "invalid", evidence: "module lies inside the worker-writable artifact root"}])
  and ([.candidates[] | select(.source == "artifact-root")] | length) == 0' \
  "$GATES/artifacts/ai_agents_internal/browser-runtime.json" >/dev/null || \
  fail "resolve-gates did not refuse the planted artifact-root runtime: $(jq -c .candidates "$GATES/artifacts/ai_agents_internal/browser-runtime.json")"
jq -e '(.released == ["asklepios","orion","proteus","tiresias"]) and (.gateUnmet == ["charon","pistis"])' "$WORK/resolve-gates.json" >/dev/null \
  || fail "resolve-gates released the wrong lanes: $(cat "$WORK/resolve-gates.json")"
jq -e --arg digest "$(digest_file "$GATES/artifacts/solution/discovery/capability-evidence.json")" '.gateResolution as $g
  | $g.evidenceSha256 == $digest
  and $g.capabilities["browser-runtime"] == {status: "proven", basis: "runtime-probe", reason: "the runtime probe launched headless Chromium; see ai_agents_internal/browser-runtime.json"}
  and $g.capabilities["source-access"] == {status: "proven", basis: "kalchas-evidence+path-check", reason: "source root and read file re-checked by the runtime"}
  and $g.capabilities["existing-suite"] == {status: "proven", basis: "kalchas-evidence+path-check", reason: "suite root and test file re-checked by the runtime"}
  and $g.capabilities["non-rest-surface"] == {status: "proven", basis: "kalchas-evidence+inventory", reason: "every recon surface id is present in the validated surface inventory"}
  and ([$g.capabilities["db-access"], $g.capabilities["multi-service"]] | map(.status + ":" + .basis)) == ["unmet:operator-feature-required", "unmet:operator-feature-required"]
  and ($g.capabilities["db-access"].reason | contains("credentials are not re-verified by the runtime"))' "$WORK/resolve-gates.json" >/dev/null \
  || fail "resolve-gates recorded unexpected verdicts: $(cat "$WORK/resolve-gates.json")"
jq -e --arg id conditional-gates '.engagementId == $id and .status == "available" and .source == "host-provisioned"' \
  "$GATES/artifacts/ai_agents_internal/browser-runtime.json" >/dev/null || fail 'resolve-gates did not rewrite browser-runtime.json from its re-probe'
GATES_STATE="$GATES/artifacts/ai_agents_internal/engagement-state.json"
jq -e --slurpfile out "$WORK/resolve-gates.json" '.gateResolution == $out[0].gateResolution' "$GATES_STATE" >/dev/null || fail 'resolve-gates output differs from the persisted state'
for proof_value in orders.ts 127.0.0.1 'SELECT 1' shop_test SRF-API-ORDERS-POST; do
  if grep -Fq "$proof_value" "$GATES_STATE"; then fail "engagement state copied a proof value: $proof_value"; fi
done
if gate_output="$(HOME="$CONDITIONAL_HOME" "$CLI" engagement resolve-gates --manifest "$GATES_MANIFEST" --controller-token "$GATES_CONTROLLER" 2>&1)"; then
  fail 'resolve-gates recorded a second resolution'
fi
grep -Fq 'gate resolution is immutable once recorded' <<<"$gate_output" || fail "second resolve-gates failed for the wrong reason: $gate_output"

# Kalchas's proven verdicts stay unmet when the runtime's own checks disagree: a source root
# outside the engagement target root, and a surface id absent from the validated inventory.
prepare_conditional_engagement outside '{"proteus":["non-rest-surface"],"tiresias":["source-access"]}'
OUTSIDE="$WORK/conditional-outside"
mkdir -p "$WORK/elsewhere/src"
printf 'export {};\n' >"$WORK/elsewhere/src/index.ts"
write_capability_evidence "$OUTSIDE" "$WORK/elsewhere/src" "$WORK/elsewhere/src/index.ts" SRF-API-UNKNOWN
"$CLI" engagement resolve-gates --manifest "$OUTSIDE/artifacts/ai_agents_internal/engagement.json" \
  --controller-token "$(jq -r .controller "$OUTSIDE/tokens.json")" >"$WORK/resolve-outside.json"
jq -e '.released == [] and .gateUnmet == ["proteus","tiresias"]
  and .gateResolution.capabilities["source-access"] == {status: "unmet", basis: "kalchas-evidence+path-check", reason: "source root is outside the engagement target root"}
  and .gateResolution.capabilities["non-rest-surface"] == {status: "unmet", basis: "kalchas-evidence+inventory", reason: "a recon surface id is absent from the validated surface inventory"}' \
  "$WORK/resolve-outside.json" >/dev/null || fail "recon verdicts the runtime could not re-check were released: $(cat "$WORK/resolve-outside.json")"

# Foreign evidence is refused without recording anything; missing evidence leaves every
# evidence-backed gate unmet with a null evidence digest.
prepare_conditional_engagement missing '{"proteus":["non-rest-surface"],"tiresias":["source-access"]}'
MISSING="$WORK/conditional-missing"
MISSING_MANIFEST="$MISSING/artifacts/ai_agents_internal/engagement.json"
MISSING_CONTROLLER="$(jq -r .controller "$MISSING/tokens.json")"
write_capability_evidence "$MISSING" "$MISSING/target/src" "$MISSING/target/src/server/orders.ts"
jq '.engagementId = "another-engagement"' "$MISSING/artifacts/solution/discovery/capability-evidence.json" >"$WORK/foreign-evidence.json"
mv "$WORK/foreign-evidence.json" "$MISSING/artifacts/solution/discovery/capability-evidence.json"
if gate_output="$("$CLI" engagement resolve-gates --manifest "$MISSING_MANIFEST" --controller-token "$MISSING_CONTROLLER" 2>&1)"; then
  fail 'resolve-gates accepted capability evidence from another engagement'
fi
grep -Fq 'capability evidence belongs to another engagement' <<<"$gate_output" || fail "foreign evidence failed for the wrong reason: $gate_output"
[ "$("$CLI" engagement status --manifest "$MISSING_MANIFEST" | jq -c .gateResolution)" = null ] || fail 'refused resolve-gates recorded a resolution'
rm "$MISSING/artifacts/solution/discovery/capability-evidence.json"
"$CLI" engagement resolve-gates --manifest "$MISSING_MANIFEST" --controller-token "$MISSING_CONTROLLER" >"$WORK/resolve-missing.json"
jq -e '.gateUnmet == ["proteus","tiresias"] and .gateResolution.evidenceSha256 == null
  and ([.gateResolution.capabilities[] | .status + ":" + .reason] | unique) == ["unmet:capability evidence file missing"]' \
  "$WORK/resolve-missing.json" >/dev/null || fail "missing capability evidence did not leave the gates unmet: $(cat "$WORK/resolve-missing.json")"

# Cleanup removes sensitive/temporary state and held locks on both success and failure.
touch "$TARGET/ai_agents_internal/workers/tyche/browser-profile/session" \
  "$TARGET/ai_agents_internal/workers/tyche/auth/token" \
  "$TARGET/ai_agents_internal/workers/tyche/tmp/transient"
mkdir -p "$TARGET/ai_agents_internal/workers/tyche/locks"
touch "$TARGET/ai_agents_internal/workers/tyche/locks/fault"
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --outcome failure >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --outcome failure >/dev/null
for path in browser-profile auth tmp locks .lease; do
  [ ! -e "$TARGET/ai_agents_internal/workers/tyche/$path" ] || fail "cleanup left tyche/$path"
done
[ -d "$TARGET/ai_agents_internal/workers/tyche/output" ] || fail "cleanup removed durable worker output"
[ "$("$CLI" engagement status --manifest "$MANIFEST" | jq -r '.exclusiveLocks.fault // "released"')" = released ] || fail "cleanup left fault lock"

printf 'PASS  Argus engagement: packaged guard, deterministic ownership, barriers, leases, IDs, resume, and cleanup\n'
