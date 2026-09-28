#!/usr/bin/env bash
# Exercise automatic frontier continuation end to end through the packaged CLI: controller-
# observed checkpoint-less restarts bound to the lane's artifact evidence (RACI accountable
# artifacts, filed candidates, sole-owned ledgers, and submitted fragments), the refusal of a
# checkpoint-less turn-limit on a checkpointed lane, checkpoint-resume continuation,
# model-unavailable backoff with a real wait, all three retry lineages, lease token rotation,
# and the rule that no issued token is ever persisted in the artifact root.
# The backoff case waits the policy's first unavailability backoff (60 s) for real.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
POLICY="$ROOT/argus/claude/capabilities/model-policy.json"
ENGAGEMENT_LIB="$ROOT/argus/claude/lib/engagement.mjs"
WORK="$(mktemp -d)"
HOST="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOST"' EXIT

source "$ROOT/scripts/lib/argus-smoke-model-control.sh"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

jq -e '.fallbackPolicies["frontier-fail-closed"].autoContinue | .enabled == true and .maxCheckpointlessRetries == 1 and .unavailableBackoffSeconds[0] == 60' \
  "$POLICY" >/dev/null || fail 'packaged model policy no longer enables autoContinue with one checkpoint-less restart and a 60 s first backoff'

TARGET="$WORK/target"
mkdir -p "$TARGET"
"$CLI" engagement init --target "$TARGET" --artifact-root "$TARGET" --mode B --engagement-id continuation-fixture >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
argus_smoke_prepare_model_control "$CLI" "$MANIFEST" "$TARGET" "$TARGET" B \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST"
DECISIONS="$TARGET/ai_agents_internal/model-decisions"

ODYSSEUS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" odysseus | jq -r .token)"
ORION="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" orion "$ODYSSEUS" | jq -r .token)"
KALCHAS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" kalchas "$ODYSSEUS" | jq -r .token)"
PERSEUS="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" perseus "$ODYSSEUS" | jq -r .token)"
ISSUED_TOKENS=("$ODYSSEUS" "$ORION" "$KALCHAS" "$PERSEUS")
for token in "${ISSUED_TOKENS[@]}"; do
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || fail 'allocation did not return a 64-hex lease token'
done

ODYSSEUS_INITIAL="$(argus_smoke_model_decision "$MANIFEST" "$HOST" odysseus)"
ORION_INITIAL="$(argus_smoke_model_decision "$MANIFEST" "$HOST" orion)"
KALCHAS_INITIAL="$(argus_smoke_model_decision "$MANIFEST" "$HOST" kalchas)"
PERSEUS_INITIAL="$(argus_smoke_model_decision "$MANIFEST" "$HOST" perseus)"
ORION_DISPATCH="$(jq -r .dispatchId "$ORION_INITIAL")"
KALCHAS_DISPATCH="$(jq -r .dispatchId "$KALCHAS_INITIAL")"
PERSEUS_DISPATCH="$(jq -r .dispatchId "$PERSEUS_INITIAL")"
ORION_TURNS="$(jq -r '.roles[] | select(.slug == "orion") | .maxTurns' "$POLICY")"

# route <agent> <dispatch-id> <signal> <attempt> [extra options]: the controller routes
# every post-allocation decision with its own token.
route() {
  local agent="$1" dispatch="$2" signal="$3" attempt="$4"
  shift 4
  "$CLI" model route --manifest "$MANIFEST" --agent "$agent" --runtime claude --signal "$signal" \
    --dispatch-id "$dispatch" --attempt "$attempt" --controller-token "$ODYSSEUS" "$@"
}

# telemetry <decision-file> <decision-owning-lane-token>
telemetry() {
  "$CLI" model telemetry --manifest "$MANIFEST" --decision "$1" --token "$2" \
    --input-tokens 1200 --output-tokens 300 --duration-ms 4500 --success false >/dev/null
}

# start_attempt <lane> <next-decision-file> <current-lane-token> [extra options]
start_attempt() {
  local lane="$1" decision="$2" token="$3"
  shift 3
  "$CLI" engagement start-attempt --manifest "$MANIFEST" --lane "$lane" --decision "$decision" \
    --token "$token" --controller-token "$ODYSSEUS" "$@"
}

heartbeat() {
  "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane "$1" --token "$2" \
    --phase hunting --completed 1 --total 4 --status running
}

decision_file() { printf '%s/%s' "$TARGET" "$(jq -r .relativePath "$1")"; }
decision_count() { find "$DECISIONS" -maxdepth 1 -name 'MDR-*.json' | wc -l | tr -d ' '; }

# refuse_route <label> <expected stderr> <agent> <dispatch-id> <signal> <attempt>: the route
# must fail with the exact refusal and persist no decision.
refuse_route() {
  local label="$1" expected="$2" count
  shift 2
  count="$(decision_count)"
  if route "$@" >"$WORK/refused.out" 2>"$WORK/refused.err"; then
    fail "$label: $3 for $1 routed although the artifact root contradicts it"
  fi
  grep -Fq -- "$expected" "$WORK/refused.err" || fail "$label: $3 for $1 was not refused with '$expected': $(cat "$WORK/refused.err")"
  [ "$(decision_count)" = "$count" ] || fail "$label: a refused $3 route for $1 persisted a decision"
}

# k1: a no-artifact claim contradicted by an accountable artifact on disk is refused before
# any decision exists.
mkdir -p "$TARGET/solution"
printf '{}\n' >"$TARGET/solution/surface-inventory.json"
before="$(decision_count)"
if route kalchas "$KALCHAS_DISPATCH" no-artifact 2 >"$WORK/k1.out" 2>"$WORK/k1.err"; then
  fail 'k1: no-artifact routed although solution/surface-inventory.json exists'
fi
grep -Fq 'no-artifact is contradicted by solution/surface-inventory.json; route turn-limit instead' "$WORK/k1.err" || \
  fail "k1: contradicted no-artifact was not refused with its evidence: $(cat "$WORK/k1.err")"
[ "$(decision_count)" = "$before" ] || fail 'k1: a refused no-artifact route persisted a decision'
rm "$TARGET/solution/surface-inventory.json"

# Controller-observed signals never accept a worker envelope or an operator decision.
if route kalchas "$KALCHAS_DISPATCH" no-artifact 2 --request "$WORK/k1.out" >/dev/null 2>"$WORK/k1-request.err"; then
  fail 'no-artifact accepted a worker escalation request'
fi
grep -Fq 'no-artifact is controller-observed and does not accept --request' "$WORK/k1-request.err" || fail 'no-artifact --request was not refused by the outcome binding'

# k2: zero-candidates applies only to candidate-producing roles; Kalchas is recon.
status=0
route kalchas "$KALCHAS_DISPATCH" zero-candidates 2 >"$WORK/k2.json" || status=$?
[ "$status" -eq 2 ] || fail "k2: kalchas zero-candidates exited $status instead of a blocked decision"
jq -e '.status == "blocked" and .reasonCode == "SIGNAL_NOT_ALLOWED" and .continuation == null and
  .outcomeBinding.priorCheckpointlessRetries == 0 and .outcomeBinding.observedArtifacts == []' \
  "$WORK/k2.json" >/dev/null || fail 'k2: kalchas zero-candidates was not SIGNAL_NOT_ALLOWED'

# k3: the first no-artifact on the dispatch restarts the unchanged baseline in a fresh thread.
route kalchas "$KALCHAS_DISPATCH" no-artifact 2 >"$WORK/k3.json" || fail 'k3: no-artifact at attempt 2 did not select'
jq -e --arg previous "$(jq -r .decisionId "$KALCHAS_INITIAL")" \
  '.status == "selected" and .reasonCode == "AUTO_CONTINUE_SELECTED" and .signal == "no-artifact" and
   .continuation.kind == "fresh-restart" and .continuation.sequence == 1 and .continuation.backoffSeconds == 0 and
   .selectedConfig == .baselineConfig and .adapter.mode == "baseline" and
   .escalationBinding == null and .availabilityBinding == null and
   .outcomeBinding.previousDecisionId == $previous and .outcomeBinding.priorCheckpointlessRetries == 0 and
   .outcomeBinding.observedArtifacts == []' \
  "$WORK/k3.json" >/dev/null || fail 'k3: no-artifact at attempt 2 was not an outcome-bound fresh restart'
KALCHAS_K3="$(decision_file "$WORK/k3.json")"
# Telemetry belongs to the still-active attempt-1 decision and precedes the rebind.
telemetry "$KALCHAS_INITIAL" "$KALCHAS"
k3_start="$(start_attempt kalchas "$KALCHAS_K3" "$KALCHAS")"
jq -e --arg decision "$(jq -r .decisionId "$WORK/k3.json")" \
  '.attemptStarted == true and .attempt == 2 and .previousAttempt == 1 and .modelDecisionId == $decision' \
  <<<"$k3_start" >/dev/null || fail 'k3: start-attempt did not rebind kalchas to the outcome-bound decision'
KALCHAS_NEXT="$(jq -r .token <<<"$k3_start")"
[[ "$KALCHAS_NEXT" =~ ^[a-f0-9]{64}$ && "$KALCHAS_NEXT" != "$KALCHAS" ]] || fail 'k3: start-attempt did not rotate the kalchas token'
ISSUED_TOKENS+=("$KALCHAS_NEXT")

# k4: the dispatch has consumed its single checkpoint-less restart.
status=0
route kalchas "$KALCHAS_DISPATCH" no-artifact 3 >"$WORK/k4.json" || status=$?
[ "$status" -eq 2 ] || fail "k4: a second no-artifact exited $status instead of a blocked decision"
jq -e '.status == "blocked" and .reasonCode == "AUTO_CONTINUATION_EXHAUSTED" and .operatorEscalation == false and
  .continuation == null and .outcomeBinding.priorCheckpointlessRetries == 1' \
  "$WORK/k4.json" >/dev/null || fail 'k4: a second no-artifact was not AUTO_CONTINUATION_EXHAUSTED'
# A turn-limit without a checkpoint envelope is controller-observed too and shares the same
# single restart, so it cannot reopen the dispatch.
status=0
route kalchas "$KALCHAS_DISPATCH" turn-limit 3 >"$WORK/k4-turn-limit.json" || status=$?
[ "$status" -eq 2 ] || fail "k4: an uncheckpointed turn-limit exited $status instead of a blocked decision"
jq -e '.status == "blocked" and .reasonCode == "AUTO_CONTINUATION_EXHAUSTED" and .escalationBinding == null and
  .outcomeBinding.priorCheckpointlessRetries == 1' \
  "$WORK/k4-turn-limit.json" >/dev/null || fail 'k4: an uncheckpointed turn-limit was not outcome-bound and exhausted'

# c1: a hunter's RACI accountable-artifact list is empty, yet the candidates it files under its
# capability-matrix prefix are its output: they contradict both no-artifact and zero-candidates.
jq -e '.agents[] | select(.slug == "orion" or .slug == "perseus") | .accountableArtifacts == []' \
  "$ROOT/argus/claude/references/raci.json" >/dev/null || fail 'c1: orion or perseus gained a RACI accountable artifact; the fixture no longer isolates filed candidates'
mkdir -p "$TARGET/bugs" "$TARGET/solution"
printf '# ORI-001 cart total ignores the discount\n' >"$TARGET/bugs/ORI-001-cart-total.md"
refuse_route c1 'no-artifact is contradicted by bugs/ORI-001-cart-total.md; route turn-limit instead' \
  orion "$ORION_DISPATCH" no-artifact 2
refuse_route c1 'zero-candidates is contradicted by bugs/ORI-001-cart-total.md; route turn-limit instead' \
  orion "$ORION_DISPATCH" zero-candidates 2
rm "$TARGET/bugs/ORI-001-cart-total.md"

# c2: a lane-submitted fragment is an artifact of that lane, so it contradicts no-artifact.
printf '## Orion notes\n' >"$WORK/orion-fragment.md"
fragment="$("$CLI" engagement fragment --manifest "$MANIFEST" --lane orion --token "$ORION" \
  --canonical solution/FINDINGS.md --id orion-notes --input "$WORK/orion-fragment.md")"
fragment_path="$(jq -r .path <<<"$fragment")"
[ -f "$TARGET/$fragment_path" ] || fail "c2: orion could not submit a fragment: $fragment"
refuse_route c2 "no-artifact is contradicted by $fragment_path; route turn-limit instead" \
  orion "$ORION_DISPATCH" no-artifact 2

# c3: another lane's candidate is not perseus's output, while perseus's sole-owned
# technique-coverage ledger is: it contradicts no-artifact but not zero-candidates, which
# selects the fresh restart and records the ledger as the observed evidence.
printf '# ORI-002 checkout total drops the tax line\n' >"$TARGET/bugs/ORI-002-checkout-tax.md"
printf '{}\n' >"$TARGET/solution/perseus-ledger.json"
refuse_route c3 'no-artifact is contradicted by solution/perseus-ledger.json; route turn-limit instead' \
  perseus "$PERSEUS_DISPATCH" no-artifact 2
route perseus "$PERSEUS_DISPATCH" zero-candidates 2 >"$WORK/c3.json" || fail 'c3: perseus zero-candidates with only its ledger did not select'
jq -e --arg previous "$(jq -r .decisionId "$PERSEUS_INITIAL")" \
  '.status == "selected" and .reasonCode == "AUTO_CONTINUE_SELECTED" and .continuation.kind == "fresh-restart" and
   .outcomeBinding.previousDecisionId == $previous and .outcomeBinding.observedArtifacts == ["solution/perseus-ledger.json"]' \
  "$WORK/c3.json" >/dev/null || fail "c3: perseus zero-candidates was not a fresh restart recording its ledger: $(cat "$WORK/c3.json")"

# o1: a checkpointed turn-limit resumes from the checkpoint on the same frontier baseline with
# a fresh native per-attempt cap.
printf '{"completedUnits":["SRF-UI-CART"],"nextUnit":"SRF-UI-CHECKOUT"}\n' >"$WORK/orion-checkpoint.json"
checkpoint="$("$CLI" engagement checkpoint --manifest "$MANIFEST" --lane orion --token "$ORION" --phase hunting \
  --sequence 0 --dispatch-id "$ORION_DISPATCH" --attempt 1 --input "$WORK/orion-checkpoint.json")"
checkpoint_ref="$(jq -r .path <<<"$checkpoint")"
# A turn-limit on a lane that holds a resumable checkpoint is not uncheckpointed: the
# checkpoint-less route is refused, so the lane keeps its checkpoint-resume path and the
# dispatch keeps its single fresh restart.
refuse_route o1 "turn-limit is checkpointed at $checkpoint_ref; persist the envelope with model request --checkpoint-ref $checkpoint_ref and route it with --request" \
  orion "$ORION_DISPATCH" turn-limit 2
request="$("$CLI" model request --manifest "$MANIFEST" --agent orion --runtime claude --signal turn-limit \
  --dispatch-id "$ORION_DISPATCH" --attempt 2 --checkpoint-ref "$checkpoint_ref" --token "$ORION")"
request_path="$(sed -n 's/^MODEL_REQUEST  persisted path=\([^ ]*\) sha256=.*$/\1/p' <<<"$request")"
[ -f "$request_path" ] || fail 'o1: model request did not persist a turn-limit envelope'
route orion "$ORION_DISPATCH" turn-limit 2 --request "$request_path" >"$WORK/o1.json" || fail 'o1: checkpointed turn-limit did not select'
jq -e --argjson turns "$ORION_TURNS" --arg ref "$checkpoint_ref" --arg previous "$(jq -r .decisionId "$ORION_INITIAL")" \
  '.status == "selected" and .reasonCode == "AUTO_CONTINUE_SELECTED" and .continuation.kind == "checkpoint-resume" and
   .selectedConfig.model == "opus" and .selectedConfig.maxTurns == $turns and .selectedConfig == .baselineConfig and
   .continuation.perAttemptMaxTurns == $turns and .continuation.cumulativeTurnBudget == ($turns * 2) and
   .escalationBinding.checkpointRef == $ref and .escalationBinding.previousDecisionId == $previous and
   .availabilityBinding == null and .outcomeBinding == null' \
  "$WORK/o1.json" >/dev/null || fail 'o1: checkpointed turn-limit was not a checkpoint-resume on opus with the policy maxTurns'
ORION_O1="$(decision_file "$WORK/o1.json")"
heartbeat orion "$ORION" >/dev/null || fail 'o1: the active orion token could not heartbeat before the rebind'
telemetry "$ORION_INITIAL" "$ORION"
o1_start="$(start_attempt orion "$ORION_O1" "$ORION")"
jq -e '.attemptStarted == true and .attempt == 2 and .previousAttempt == 1' <<<"$o1_start" >/dev/null || \
  fail 'o1: start-attempt did not advance orion to attempt 2'
ORION_NEXT="$(jq -r .token <<<"$o1_start")"
[[ "$ORION_NEXT" =~ ^[a-f0-9]{64}$ && "$ORION_NEXT" != "$ORION" ]] || fail 'o1: start-attempt did not rotate the orion token'
ISSUED_TOKENS+=("$ORION_NEXT")
if heartbeat orion "$ORION" >/dev/null 2>&1; then
  fail 'o1: heartbeat accepted the consumed pre-rotation orion token'
fi
heartbeat orion "$ORION_NEXT" >/dev/null || fail 'o1: heartbeat rejected the rotated orion token'
if telemetry "$ORION_INITIAL" "$ORION_NEXT" 2>/dev/null; then
  fail 'o1: telemetry accepted the superseded attempt-1 decision after the rebind'
fi

# o2: frontier unavailability retries the same baseline after the first policy backoff; the
# retry cannot start before it elapses.
o2_started="$(date +%s)"
route orion "$ORION_DISPATCH" model-unavailable 3 >"$WORK/o2.json" || fail 'o2: model-unavailable at attempt 3 did not select'
jq -e --arg previous "$(jq -r .decisionId "$WORK/o1.json")" \
  '.status == "selected" and .reasonCode == "BACKOFF_RETRY_SELECTED" and .continuation.kind == "backoff-retry" and
   .continuation.backoffSeconds == 60 and .selectedConfig == .baselineConfig and
   .availabilityBinding.priorUnavailableRetries == 0 and .availabilityBinding.previousDecisionId == $previous and
   .escalationBinding == null and .outcomeBinding == null' \
  "$WORK/o2.json" >/dev/null || fail 'o2: model-unavailable was not a 60 s BACKOFF_RETRY_SELECTED'
ORION_O2="$(decision_file "$WORK/o2.json")"
telemetry "$ORION_O1" "$ORION_NEXT"
if start_attempt orion "$ORION_O2" "$ORION_NEXT" >"$WORK/o2-start.out" 2>"$WORK/o2-start.err"; then
  fail 'o2: start-attempt ignored the pending backoff'
fi
grep -Eq 'retry backoff has not elapsed; retry at [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z or pass --wait true' "$WORK/o2-start.err" || \
  fail "o2: pending backoff was not refused with its retry time: $(cat "$WORK/o2-start.err")"
if start_attempt orion "$ORION_O2" "$ORION_NEXT" --wait false >/dev/null 2>&1; then
  fail 'o2: start-attempt --wait false ignored the pending backoff'
fi
# The runtime enforces the same rule under its own state lock for a caller that bypasses the CLI.
node --input-type=module - "$ENGAGEMENT_LIB" "$MANIFEST" "$ORION_O2" "$ORION_NEXT" "$ODYSSEUS" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [library, manifestPath, decisionPath, token, controllerToken] = process.argv.slice(2);
const { startWorkerAttempt } = await import(pathToFileURL(library).href);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
const executionBinding = {
  modelDecisionId: decision.decisionId,
  modelDecisionIntegritySha256: decision.integritySha256,
  dispatchId: decision.dispatchId,
  attempt: decision.attempt,
  runtime: decision.runtime,
};
try {
  startWorkerAttempt(manifest, 'orion', { token, controllerToken, executionBinding });
} catch (error) {
  if (error.message === 'orion retry backoff has not elapsed') process.exit(0);
  console.error(`FAIL  o2: runtime backoff refusal differed: ${error.message}`);
  process.exit(1);
}
console.error('FAIL  o2: the runtime rebound orion before its backoff elapsed');
process.exit(1);
NODE
heartbeat orion "$ORION_NEXT" >/dev/null || fail 'o2: a refused backoff retry consumed the active orion token'

# o3: --wait true sleeps out the remaining backoff, then rebinds on the availability lineage.
o3_start="$(start_attempt orion "$ORION_O2" "$ORION_NEXT" --wait true)"
elapsed=$(( $(date +%s) - o2_started ))
[ "$elapsed" -ge 59 ] || fail "o3: start-attempt --wait true returned after ${elapsed}s, before the 60 s backoff"
node -e 'const [createdAt] = process.argv.slice(1); if (Date.now() < Date.parse(createdAt) + 60000) process.exit(1);' \
  "$(jq -r .createdAt "$WORK/o2.json")" || fail 'o3: the retry started before decision createdAt + backoff'
jq -e --arg decision "$(jq -r .decisionId "$WORK/o2.json")" \
  '.attemptStarted == true and .attempt == 3 and .previousAttempt == 2 and .modelDecisionId == $decision' \
  <<<"$o3_start" >/dev/null || fail 'o3: start-attempt --wait true did not advance orion to the backoff decision'
ORION_FINAL="$(jq -r .token <<<"$o3_start")"
[[ "$ORION_FINAL" =~ ^[a-f0-9]{64}$ && "$ORION_FINAL" != "$ORION_NEXT" ]] || fail 'o3: start-attempt did not rotate the orion token'
ISSUED_TOKENS+=("$ORION_FINAL")

# Terminal cleanup: each lane's last attempt emits telemetry before its lease is released.
telemetry "$ORION_O2" "$ORION_FINAL"
telemetry "$KALCHAS_K3" "$KALCHAS_NEXT"
telemetry "$ODYSSEUS_INITIAL" "$ODYSSEUS"
jq -s -e '
  length == 6 and all(.[]; .schema == "argus/model-telemetry-event@3") and
  (map(.reasonCode) | index("AUTO_CONTINUE_SELECTED") != null and index("BACKOFF_RETRY_SELECTED") != null) and
  (map(select(.agent == "orion") | .attempt) == [1, 2, 3]) and (map(select(.agent == "kalchas") | .attempt) == [1, 2])' \
  "$TARGET/ai_agents_internal/model-telemetry.jsonl" >/dev/null || fail 'telemetry did not record exactly one @3 event per continuation attempt'
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane orion --token "$ORION_FINAL" --outcome interrupted >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane kalchas --token "$KALCHAS_NEXT" --outcome interrupted >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane perseus --token "$PERSEUS" --outcome interrupted >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane odysseus --token "$ODYSSEUS" --outcome interrupted >/dev/null
"$CLI" engagement status --manifest "$MANIFEST" >"$WORK/status.json"
jq -e '[.allocations.odysseus, .allocations.orion, .allocations.kalchas, .allocations.perseus] | all(.status == "released" and .outcome == "interrupted")' \
  "$WORK/status.json" >/dev/null || fail 'cleanup did not release every continuation lane'

# No issued lease or controller token may exist anywhere in the worker-readable artifact root.
for token in "${ISSUED_TOKENS[@]}"; do
  if grep -rqF -- "$token" "$TARGET"; then
    fail 'an issued lease token was persisted under the artifact root'
  fi
done

printf 'PASS  Argus continuation: no-artifact and zero-candidates checked against RACI artifacts, filed candidates, owned ledgers, and fragments, zero-candidates scope, one fresh restart then exhaustion, checkpointed turn-limit kept on the resume path, checkpoint-resume on opus, 60 s backoff enforced and waited, token rotation, and no persisted token\n'
