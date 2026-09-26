#!/usr/bin/env bash
# Scenario smoke for the portable runner library (scripts/runner-lib.sh) and its gates: lane
# plan, environment baseline, inventory-based quarantine, adapter status, per-pass evidence,
# contract smoke, and engagement authorization of destructive opt-ins. A replay runtime
# stands in for the frameworks, so no target, browser, or build tool is needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMON="$ROOT/argus/framework-template-common"
FIXTURES="$ROOT/scripts/fixtures/argus-runner-gates"
SCENARIOS="$FIXTURES/scenarios"
CLI="$ROOT/argus/claude/bin/argus-assets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The runner reads these; a hermetic smoke never inherits them from its caller.
unset ARGUS_ENGAGEMENT_MANIFEST ARGUS_ENGAGEMENT_LANE ARGUS_ENVIRONMENT_RESET ARGUS_FAULT_INJECTION \
  ARGUS_CONTRACT_SMOKE ARGUS_OUTCOME_FILE ARGUS_READINESS_URLS ARGUS_TEST_ROOT ARGUS_TODAY \
  ARGUS_RESET_TIMEOUT_SECONDS ARGUS_VERIFY_TIMEOUT_SECONDS ARGUS_AUTHORIZATION_MANIFEST \
  ARGUS_AUTHORIZATION_TARGET ARGUS_AUTHORIZATION_SOURCE_TRUST ARGUS_AUTHORIZATION_ACCOUNT \
  ARGUS_AUTHORIZATION_NAMESPACE ARGUS_AUTHORIZATION_MUTATION ARGUS_AUTHORIZATION_RATE \
  ARGUS_AUTHORIZATION_CONCURRENCY ARGUS_AUTHORIZATION_TOTAL_REQUESTS ARGUS_AUTHORIZATION_DURATION \
  ARGUS_RUNNER_MODE ARGUS_EVIDENCE_PASS ARGUS_INVENTORY_ONLY PERF_BUDGET_MS SECURITY_ENABLED DB_URL

# Readiness probes the default API_URL/UI_URL; curl answers file:// URLs without a server.
READY="$WORK/ready.txt"
printf 'ready\n' >"$READY"
export API_URL="file://$READY" UI_URL="file://$READY"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

# prepare <label> <scenario>: a fresh runner directory holding the common scripts, the
# replay runtime, the green base scenario, and the named scenario layered on top of it.
prepare() {
  local label="$1" scenario="$2" dir="$WORK/$1" file
  mkdir -p "$dir/scripts" "$dir/solution" "$dir/ai_agents_internal" "$dir/scenario"
  cp "$COMMON/scripts/"* "$dir/scripts/"
  cp "$FIXTURES/fake-runtime/run-tests.sh" "$dir/run-tests.sh"
  cp -R "$SCENARIOS/green/." "$dir/scenario/"
  if [ "$scenario" != green ]; then cp -R "$SCENARIOS/$scenario/." "$dir/scenario/"; fi
  for file in test-lanes.tsv environment.tsv quarantine.tsv; do
    if [ -f "$dir/scenario/$file" ]; then cp "$dir/scenario/$file" "$dir/solution/$file"; fi
  done
  if [ -d "$dir/scenario/scripts" ]; then cp "$dir/scenario/scripts/"* "$dir/scripts/"; fi
  printf '{\n  "runtime": "fake",\n  "packageManager": "replay",\n  "choiceSource": "explicit-user"\n}\n' \
    >"$dir/ai_agents_internal/template-selection.json"
}

# run_case <label> <expected-exit> <mode> [env arguments...] [-- passthrough...]
run_case() {
  local label="$1" expected="$2" mode="$3" dir="$WORK/$1" code
  local environment=() passthrough=()
  shift 3
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do environment+=("$1"); shift; done
  if [ "$#" -gt 0 ]; then shift; passthrough=(-- "$@"); fi
  set +e
  (cd "$dir" && env ${environment[@]+"${environment[@]}"} ARGUS_FAKE_SCENARIO="$dir/scenario" \
    ./run-tests.sh --mode "$mode" ${passthrough[@]+"${passthrough[@]}"} >"$dir/run.log" 2>&1)
  code=$?
  set -e
  if [ "$code" -ne "$expected" ]; then
    tail -40 "$dir/run.log" >&2
    fail "$label exited $code instead of $expected"
  fi
  if [ -f "$dir/reports/argus-runner-result.json" ]; then
    jq -e --arg mode "$mode" --argjson code "$expected" '.mode == $mode and .exitCode == $code' \
      "$dir/reports/argus-runner-result.json" >/dev/null || fail "$label result does not record mode $mode and exit $expected"
    "$CLI" schema validate --kind runner-result --input "$dir/reports/argus-runner-result.json" >/dev/null ||
      fail "$label result failed packaged runtime validation"
    grep -Fq "Argus contract: mode=$mode result=reports/argus-runner-result.json exit=$expected" "$dir/run.log" ||
      fail "$label did not print the contract summary"
  fi
}

# case_run <label> <scenario> <expected-exit> <mode> [...]: prepare and run in one step.
case_run() {
  local label="$1" scenario="$2"
  shift 2
  prepare "$label" "$scenario"
  run_case "$label" "$@"
}

has_event() {
  local label="$1"
  shift
  grep -Fxq "$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "$@")" "$WORK/$label/reports/outcomes.raw.tsv" ||
    fail "$label lacks event: $*"
}
lacks_reason() {
  if [ -f "$WORK/$1/reports/outcomes.raw.tsv" ] && cut -f7 "$WORK/$1/reports/outcomes.raw.tsv" | grep -Eq "$2"; then
    fail "$1 unexpectedly recorded a reason matching $2"
  fi
}
result_is() { jq -e "$2" "$WORK/$1/reports/argus-runner-result.json" >/dev/null || fail "$1 result does not satisfy: $2"; }
called() { grep -Fxq -- "$2" "$WORK/$1/reports/fake-calls.log" || fail "$1 hook log lacks: $2"; }
not_called() {
  if [ -f "$WORK/$1/reports/fake-calls.log" ] && grep -Eq -- "$2" "$WORK/$1/reports/fake-calls.log"; then
    fail "$1 unexpectedly called: $2"
  fi
}
call_order() { grep -v '^env ' "$WORK/$1/reports/fake-calls.log" | tr '\n' '|'; }

# ---------------------------------------------------------------------------------------
# The shared kit is byte-identical in the common layer and in every composed template.
for script in runner-lib.sh lane-plan.sh environment-gate.sh quarantine-contract.sh runner-contract.sh; do
  for template in framework-template framework-template-java framework-template-python; do
    cmp "$COMMON/scripts/$script" "$ROOT/argus/$template/scripts/$script" >/dev/null ||
      fail "$template/scripts/$script drifted from the common layer"
  done
done
for declaration in test-lanes.tsv environment.tsv; do
  for template in framework-template framework-template-java framework-template-python; do
    cmp "$COMMON/solution/$declaration" "$ROOT/argus/$template/solution/$declaration" >/dev/null ||
      fail "$template/solution/$declaration drifted from the common layer"
  done
done

# ---------------------------------------------------------------------------------------
# Lane-plan gate, unit level. The shipped default plan is valid and undecided beyond api/ui.
UNIT="$WORK/unit"
mkdir -p "$UNIT"
lanes="$("$COMMON/scripts/lane-plan.sh" validate --plan "$COMMON/solution/test-lanes.tsv" --events "$UNIT/default-baseline.tsv" --mode baseline)"
[ "$lanes" = api,ui ] || fail "default lane plan enabled '$lanes' instead of api,ui"
[ "$(grep -c 'lane-disabled.not-yet-planned' "$UNIT/default-baseline.tsv")" -eq 4 ] || fail "default plan did not record four undecided disabled lanes"
if "$COMMON/scripts/lane-plan.sh" validate --plan "$COMMON/solution/test-lanes.tsv" --events "$UNIT/default-full.tsv" --mode full-suite >/dev/null 2>&1; then
  fail "default lane plan passed the full-suite decision check"
fi
[ "$(grep -c 'lane-decision-missing' "$UNIT/default-full.tsv")" -eq 4 ] || fail "full-suite did not deny every undecided lane"
if env -u UI_URL "$COMMON/scripts/lane-plan.sh" validate --plan "$COMMON/solution/test-lanes.tsv" --events "$UNIT/prerequisite.tsv" --mode baseline >/dev/null 2>&1; then
  fail "enabled ui lane passed without UI_URL"
fi
grep -Fxq "$(printf 'lane.ui\tpolicy\tdenied\tfalse\tn/a\t-\tlane-prerequisite-missing')" "$UNIT/prerequisite.tsv" || fail "missing prerequisite was not denied"

T=$'\t'
invalid_plan() {
  local label="$1" content="$2"
  printf '%s\n' "$content" >"$UNIT/$label.plan"
  if "$COMMON/scripts/lane-plan.sh" validate --plan "$UNIT/$label.plan" --events "$UNIT/$label.tsv" --mode baseline >/dev/null 2>&1; then
    fail "lane plan '$label' was accepted"
  fi
  grep -Fxq "$(printf 'lane-plan\tpolicy\tdenied\tfalse\tn/a\t-\tlane-plan-invalid')" "$UNIT/$label.tsv" || fail "lane plan '$label' was not denied as invalid"
}
body="$(grep -v '^#' "$SCENARIOS/green/test-lanes.tsv")"
api_row="api${T}enabled${T}talos${T}API_URL${T}-"
ui_row="ui${T}enabled${T}daidalos${T}UI_URL${T}-"
invalid_plan missing-lane "$(printf '%s\n' "$body" | grep -v '^resilience')"
invalid_plan unknown-lane "$body
mobile${T}disabled${T}nike${T}-${T}out-of-scope"
invalid_plan duplicate-lane "$body
$api_row"
invalid_plan bad-owner "${body/$api_row/api${T}enabled${T}Talos${T}API_URL${T}-}"
invalid_plan bad-prerequisite "${body/$api_row/api${T}enabled${T}talos${T}api-url${T}-}"
invalid_plan bad-reason "${body/$api_row/api${T}disabled${T}talos${T}API_URL${T}not planned}"
invalid_plan disabled-without-reason "${body/$api_row/api${T}disabled${T}talos${T}API_URL${T}-}"
invalid_plan bad-state "${body/$ui_row/ui${T}skipped${T}daidalos${T}UI_URL${T}-}"
invalid_plan short-row "${body/$ui_row/ui${T}enabled${T}daidalos${T}UI_URL}"
invalid_plan long-row "${body/$ui_row/$ui_row${T}extra}"
invalid_plan empty-field "${body/$ui_row/ui${T}enabled${T}${T}UI_URL${T}-}"
if "$COMMON/scripts/lane-plan.sh" validate --plan "$UNIT/absent.plan" --events "$UNIT/absent.tsv" --mode baseline >/dev/null 2>&1; then
  fail "a missing lane plan was accepted"
fi
all_disabled="${body/$api_row/api${T}disabled${T}talos${T}API_URL${T}out-of-scope}"
all_disabled="${all_disabled/$ui_row/ui${T}disabled${T}daidalos${T}UI_URL${T}out-of-scope}"
printf '%s\n' "$all_disabled" >"$UNIT/empty.plan"
if "$COMMON/scripts/lane-plan.sh" validate --plan "$UNIT/empty.plan" --events "$UNIT/empty.tsv" --mode baseline >/dev/null 2>&1; then
  fail "a plan without an enabled lane was accepted"
fi
grep -Fq 'lane-plan-empty' "$UNIT/empty.tsv" || fail "a plan without an enabled lane was not denied"

# Environment gate, unit level: the shipped default is undecided, which only full-suite denies.
"$COMMON/scripts/environment-gate.sh" --plan "$COMMON/solution/environment.tsv" --events "$UNIT/env-default-baseline.tsv" --mode baseline ||
  fail "the default environment plan blocked a baseline run"
[ ! -s "$UNIT/env-default-baseline.tsv" ] || fail "the default environment plan emitted events in baseline"
if "$COMMON/scripts/environment-gate.sh" --plan "$COMMON/solution/environment.tsv" --events "$UNIT/env-default-full.tsv" --mode full-suite 2>/dev/null; then
  fail "the undecided default environment plan passed full-suite"
fi
grep -Fxq "$(printf 'environment\tpolicy\tdenied\tfalse\tn/a\t-\tenvironment-decision-missing')" "$UNIT/env-default-full.tsv" || fail "undecided environment was not denied"
mkdir -p "$UNIT/env/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$UNIT/env/scripts/verify.sh"
chmod 755 "$UNIT/env/scripts/verify.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$UNIT/env/scripts/not-executable.sh"
invalid_environment() {
  local label="$1" content="$2"
  printf '%b' "$content" >"$UNIT/env/$label.tsv"
  if (cd "$UNIT/env" && "$COMMON/scripts/environment-gate.sh" --plan "$label.tsv" --events "$label.events" --mode baseline) >/dev/null 2>&1; then
    fail "environment plan '$label' was accepted"
  fi
  grep -Fxq "$(printf 'environment\tpolicy\tdenied\tfalse\tn/a\t-\tenvironment-plan-invalid')" "$UNIT/env/$label.events" ||
    fail "environment plan '$label' was not denied as invalid"
}
invalid_environment missing-verify 'reset\t-\tno-reset-capability\n'
invalid_environment duplicate-reset 'reset\t-\tno-reset-capability\nreset\t-\tno-reset-capability\nverify\t-\tno-verify\n'
invalid_environment unknown-kind 'reset\t-\tno-reset-capability\nverify\t-\tno-verify\nseed\t-\tno-seed\n'
invalid_environment outside-scripts 'reset\t-\tno-reset-capability\nverify\t/bin/true\tprobe\n'
invalid_environment traversal 'reset\t-\tno-reset-capability\nverify\tscripts/../scripts/verify.sh\tprobe\n'
invalid_environment not-executable 'reset\t-\tno-reset-capability\nverify\tscripts/not-executable.sh\tprobe\n'
invalid_environment absent-script 'reset\t-\tno-reset-capability\nverify\tscripts/absent.sh\tprobe\n'
invalid_environment undecided-command 'reset\t-\tno-reset-capability\nverify\tscripts/verify.sh\tnot-yet-planned\n'
invalid_environment unsafe-note 'reset\t-\tno reset\nverify\tscripts/verify.sh\tprobe\n'
printf 'reset\t-\tno-reset-capability\nverify\tscripts/verify.sh\tprobe\n' >"$UNIT/env/valid.tsv"
if (cd "$UNIT/env" && ARGUS_VERIFY_TIMEOUT_SECONDS=0 "$COMMON/scripts/environment-gate.sh" --plan valid.tsv --events timeout.events --mode baseline) >/dev/null 2>&1; then
  fail "a zero verify timeout was accepted"
fi
grep -Fq 'environment-timeout-invalid' "$UNIT/env/timeout.events" || fail "an invalid timeout was not denied"

# Quarantine evaluator: exactly one evaluation basis, and --inventory needs a real file.
printf 'case.one\tapi\tfalse\ttrue\t-\t-\t-\t-\n' >"$UNIT/inventory.tsv"
for arguments in "--inventory $UNIT/inventory.tsv --tagged-count 1" "--inventory $UNIT/missing-inventory.tsv" ""; do
  set +e
  # shellcheck disable=SC2086
  "$COMMON/scripts/quarantine-contract.sh" --events "$UNIT/quarantine-usage.tsv" $arguments >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -eq 14 ] || fail "quarantine-contract accepted invalid arguments '$arguments' with exit $code"
done

# ---------------------------------------------------------------------------------------
# Runner library, scenario level.

# Green baseline: hook order, lane selection, absolute outcome file, per-pass evidence.
case_run green-baseline green 0 baseline
called green-baseline "run baseline live api,ui"
called green-baseline "env mode=baseline pass=live outcome=$WORK/green-baseline/reports/outcomes.raw.tsv fault="
called green-baseline "inventory only=1"
called green-baseline "collect live"
called green-baseline "post baseline"
[ "$(call_order green-baseline)" = "prepare|verify|inventory only=1|run baseline live api,ui|collect live|post baseline|" ] ||
  fail "green baseline ran hooks out of order: $(call_order green-baseline)"
grep -Fxq 'native report for pass live' "$WORK/green-baseline/reports/evidence/passes/live/native-report.txt" ||
  fail "the per-pass collect hook did not store the live pass evidence"
has_event green-baseline lane.api policy pass false n/a - lane-executed
has_event green-baseline lane.ui policy pass false n/a - lane-executed
has_event green-baseline lane.perf policy pass false n/a - lane-disabled.residual.not-in-fixture
has_event green-baseline lane.resilience policy pass false n/a - lane-disabled.residual.not-in-fixture
has_event green-baseline environment infrastructure pass false n/a - environment-baseline-verified
result_is green-baseline '.deliveryGate == false and .status == "pass"'

# Stale inputs from an earlier run never leak into the next result.
printf 'BUG-0009\n' >"$WORK/green-baseline/reports/expected-bugs.txt"
printf 'stale\tproduct\tfail\tfalse\tn/a\t-\tassertion-failed\n' >"$WORK/green-baseline/reports/outcomes.raw.tsv"
run_case green-baseline 0 baseline
[ ! -e "$WORK/green-baseline/reports/expected-bugs.txt" ] || fail "a stale expected-bugs file survived the next run"

case_run green-full green 0 full-suite
called green-full "run full live api,ui"
result_is green-full '.deliveryGate == true and .categories.product == 3'
case_run green-candidate green 0 candidate-regression
called green-candidate "run regression live api,ui"
called green-candidate "post candidate-regression"
lacks_reason green-candidate '^lane-executed$|^lane-not-executed$'

# Mode handling.
prepare invalid-mode green
run_case invalid-mode 14 smoke
[ ! -e "$WORK/invalid-mode/reports/argus-runner-result.json" ] || fail "an invalid mode wrote a result"
case_run narrowing green 13 full-suite -- --grep checkout
has_event narrowing runner-selection policy denied false n/a - full-suite-narrowing-forbidden
not_called narrowing '^run '
case_run baseline-selectors green 0 baseline -- --grep checkout
called baseline-selectors "run baseline live api,ui --grep checkout"

# Template selection is checked before anything else.
prepare unselected green
rm "$WORK/unselected/ai_agents_internal/template-selection.json"
run_case unselected 13 baseline
result_is unselected '.categories.policy == 1 and (.events | length) == 1 and .events[0].caseId == "template-selection"'
not_called unselected '.'

# Lane plan.
case_run invalid-plan invalid-plan 13 baseline
has_event invalid-plan lane-plan policy denied false n/a - lane-plan-invalid
not_called invalid-plan '.'
case_run missing-prerequisite green 13 baseline -u UI_URL
has_event missing-prerequisite lane.ui policy denied false n/a - lane-prerequisite-missing
case_run undecided-full undecided-lane 13 full-suite
has_event undecided-full lane.perf policy denied false n/a - lane-decision-missing
not_called undecided-full '.'
case_run undecided-baseline undecided-lane 0 baseline
has_event undecided-baseline lane.perf policy pass false n/a - lane-disabled.not-yet-planned
case_run lane-not-executed lane-not-executed 15 baseline
has_event lane-not-executed lane.ui skip skipped false n/a - lane-not-executed
has_event lane-not-executed lane.api policy pass false n/a - lane-executed

# Environment baseline.
case_run reset-fails reset-fails 12 full-suite ARGUS_ENVIRONMENT_RESET=execute
has_event reset-fails environment infrastructure fail false n/a - environment-reset-failed
not_called reset-fails '^verify$|^inventory'
case_run reset-not-requested reset-fails 0 baseline
has_event reset-not-requested environment policy pass false n/a - environment-reset-not-requested
not_called reset-not-requested '^reset$'
started="$(date +%s)"
case_run reset-timeout reset-timeout 12 full-suite ARGUS_ENVIRONMENT_RESET=execute ARGUS_RESET_TIMEOUT_SECONDS=1
[ $(($(date +%s) - started)) -lt 15 ] || fail "the reset timeout did not stop the reset"
has_event reset-timeout environment infrastructure fail false n/a - environment-reset-failed
not_called reset-timeout '^reset-finished$'
case_run verify-fails verify-fails 12 baseline
has_event verify-fails environment infrastructure fail false n/a - environment-not-at-baseline
case_run baseline-unproven reset-ok 13 full-suite
has_event baseline-unproven environment policy pass false n/a - environment-reset-not-requested
has_event baseline-unproven environment policy denied false n/a - environment-baseline-unproven
case_run reset-executed reset-ok 0 full-suite ARGUS_ENVIRONMENT_RESET=execute
has_event reset-executed environment infrastructure pass false n/a - environment-reset-executed
[ "$(call_order reset-executed)" = "prepare|reset|inventory only=1|run full live api,ui|collect live|post full-suite|" ] ||
  fail "reset ran out of order: $(call_order reset-executed)"

# Contract smoke: no lane plan, environment, or readiness, the contract-smoke lane only, and
# never a delivery gate, even in full-suite mode with selectors.
prepare contract-smoke contract-smoke
rm "$WORK/contract-smoke/solution/test-lanes.tsv"
run_case contract-smoke 0 full-suite ARGUS_CONTRACT_SMOKE=1 -- --grep contract
called contract-smoke "run full live contract-smoke --grep contract"
has_event contract-smoke contract-smoke policy pass false n/a - contract-smoke-mode
result_is contract-smoke '.deliveryGate == false'
lacks_reason contract-smoke '^lane-|^environment-'
not_called contract-smoke '^verify$'

# Inventory-based quarantine.
case_run quarantine-orphaned quarantine-orphaned 13 baseline
has_event quarantine-orphaned api.retired policy denied false n/a - quarantine-entry-orphaned
lacks_reason quarantine-orphaned '^quarantine\.'
not_called quarantine-orphaned '^run '
case_run quarantine-unregistered quarantine-unregistered 13 baseline
has_event quarantine-unregistered api.flaky policy denied false n/a - quarantine-unregistered
case_run quarantine-regression quarantine-regression 13 baseline
has_event quarantine-regression api.widget-regression policy denied false n/a BUG-0001 regression-quarantine-forbidden
lacks_reason quarantine-regression '^quarantine\.'
case_run quarantine-approved quarantine-approved 0 baseline
has_event quarantine-approved api.flaky skip skipped true n/a - quarantine.flaky-clock

# Adapter status and native outcomes.
case_run no-status no-status 11 baseline
has_event no-status adapter automation fail false n/a - outcome-adapter-missing
case_run status-error status-error 11 baseline
has_event status-error adapter automation fail false n/a - outcome-adapter-failed
case_run product-failure product-failure 10 full-suite
case_run prepare-fails prepare-fails 11 baseline
has_event prepare-fails prepare automation fail false n/a - fake-prepare-failed
not_called prepare-fails '^inventory|^run '
case_run inventory-fails inventory-fails 11 baseline
has_event inventory-fails test-inventory automation fail false n/a - test-inventory-failed
not_called inventory-fails '^run '
case_run inventory-empty inventory-empty 11 baseline
has_event inventory-empty test-inventory automation fail false n/a - test-inventory-failed
case_run post-fails post-fails 11 baseline
has_event post-fails post-gate automation fail false n/a - fake-post-failed
# A hook that exits instead of returning still ends in a result, as a wrapper failure.
case_run hook-exits hook-exits 12 baseline
has_event hook-exits wrapper infrastructure fail false n/a - wrapper-command-failed
not_called hook-exits '^collect '

# Readiness: an explicitly empty ARGUS_READINESS_URLS probes nothing; an unreachable URL
# stops the run before the environment gate.
case_run readiness-skipped green 0 baseline "API_URL=file://$WORK/absent" "UI_URL=file://$WORK/absent" ARGUS_READINESS_URLS=
case_run not-ready green 12 baseline "ARGUS_READINESS_URLS=file://$WORK/absent"
has_event not-ready readiness infrastructure fail false n/a - target-not-ready
not_called not-ready '^verify$|^inventory'

# Regression modes and the confirmed-defect list written by the inventory pass.
case_run defect-evidence defect-evidence 0 defect-evidence
called defect-evidence "run regression live api,ui"
called defect-evidence "env mode=defect-evidence pass=live outcome=$WORK/defect-evidence/reports/outcomes.raw.tsv fault="
case_run expected-bugs expected-bugs 0 candidate-regression
result_is expected-bugs '.missingExpectedBugs == 0'
case_run expected-bugs-missing expected-bugs-missing 13 candidate-regression
result_is expected-bugs-missing '.missingExpectedBugs == 1'

# ---------------------------------------------------------------------------------------
# Engagement authorization of destructive opt-ins (reset: destructive; fault: chaos). A PATH
# stub stands in for the packaged CLI and records every call it receives.
FAKE_BIN="$WORK/fake-bin"
mkdir -p "$FAKE_BIN" "$WORK/engagement/ai_agents_internal"
cat >"$FAKE_BIN/argus-assets" <<'STUB'
#!/usr/bin/env bash
# Stand-in for the packaged CLI: records argv and answers from the smoke's fixture state.
printf '%s\n' "$*" >>"$FAKE_ARGUS_LOG"
case "${1:-} ${2:-}" in
  'engagement status') cat "$FAKE_ARGUS_STATE" ;;
  'authorization check')
    if [ "${FAKE_ARGUS_DECISION:-allow}" = allow ]; then echo 'AUTHORIZATION  ALLOW rule=FAKE-ALLOW'; exit 0; fi
    echo 'AUTHORIZATION  DENY rule=FAKE-DENY'
    exit 3 ;;
  *) exit 64 ;;
esac
STUB
chmod 755 "$FAKE_BIN/argus-assets"
MANIFEST="$WORK/engagement/ai_agents_internal/engagement.json"
printf '{"engagementId":"smoke","exclusiveLocks":{"reset":{"lane":"odysseus","acquiredAt":"2026-01-01T00:00:00.000Z"}}}\n' >"$WORK/state-reset.json"
printf '{"engagementId":"smoke","exclusiveLocks":{"fault":{"lane":"tyche","acquiredAt":"2026-01-01T00:00:00.000Z"}}}\n' >"$WORK/state-fault.json"
printf '{"engagementId":"smoke","exclusiveLocks":{}}\n' >"$WORK/state-none.json"
PATH_WITHOUT_CLI=""
IFS=: read -r -a path_entries <<<"$PATH"
for entry in ${path_entries[@]+"${path_entries[@]}"}; do
  if [ -n "$entry" ] && [ ! -e "$entry/argus-assets" ]; then PATH_WITHOUT_CLI="${PATH_WITHOUT_CLI:+$PATH_WITHOUT_CLI:}$entry"; fi
done
# engagement_env <label> <state>: the stubbed CLI on PATH, an engagement manifest, and the
# exclusive-window state the stub reports, as env arguments in ENGAGEMENT_ENV.
engagement_env() {
  ENGAGEMENT_ENV=("PATH=$FAKE_BIN:$PATH" "ARGUS_ENGAGEMENT_MANIFEST=$MANIFEST"
    "FAKE_ARGUS_LOG=$WORK/$1/argus-assets.log" "FAKE_ARGUS_STATE=$WORK/state-$2.json")
}
cli_log() { cat "$WORK/$1/argus-assets.log" 2>/dev/null || true; }

label=engagement-reset-allowed
prepare "$label" reset-ok
engagement_env "$label" reset
run_case "$label" 0 full-suite "${ENGAGEMENT_ENV[@]}" ARGUS_ENGAGEMENT_LANE=odysseus ARGUS_ENVIRONMENT_RESET=execute \
  ARGUS_AUTHORIZATION_ACCOUNT=synthetic-admin ARGUS_AUTHORIZATION_NAMESPACE=argus-smoke
has_event "$label" environment infrastructure pass false n/a - environment-reset-executed
called "$label" reset
[ "$(cli_log "$label" | sed -n 1p)" = "engagement status --manifest $MANIFEST" ] || fail "$label did not read the exclusive window: $(cli_log "$label")"
[ "$(cli_log "$label" | sed -n 2p)" = "authorization check --manifest $WORK/engagement/ai_agents_internal/authorization.json --lane odysseus --action destructive --target file://$READY --source-trust manifest --resource environment-reset --account synthetic-admin --namespace argus-smoke --mutation environment:reset" ] ||
  fail "$label did not request the destructive authorization decision: $(cli_log "$label")"

label=engagement-reset-no-window
prepare "$label" reset-ok
engagement_env "$label" none
run_case "$label" 13 full-suite "${ENGAGEMENT_ENV[@]}" ARGUS_ENGAGEMENT_LANE=odysseus ARGUS_ENVIRONMENT_RESET=execute
has_event "$label" environment policy denied false n/a - environment-reset-unauthorized
not_called "$label" '^reset$'
if cli_log "$label" | grep -q '^authorization check'; then fail "$label asked for authorization without the exclusive window"; fi

label=engagement-reset-denied
prepare "$label" reset-ok
engagement_env "$label" reset
run_case "$label" 13 full-suite "${ENGAGEMENT_ENV[@]}" ARGUS_ENGAGEMENT_LANE=odysseus ARGUS_ENVIRONMENT_RESET=execute FAKE_ARGUS_DECISION=deny
has_event "$label" environment policy denied false n/a - environment-reset-unauthorized
not_called "$label" '^reset$'

label=engagement-reset-no-lane
prepare "$label" reset-ok
engagement_env "$label" reset
run_case "$label" 13 full-suite "${ENGAGEMENT_ENV[@]}" ARGUS_ENVIRONMENT_RESET=execute
has_event "$label" environment policy denied false n/a - environment-reset-unauthorized
[ -z "$(cli_log "$label")" ] || fail "$label called the CLI without a lane"

label=engagement-reset-no-cli
prepare "$label" reset-ok
run_case "$label" 13 full-suite "PATH=$PATH_WITHOUT_CLI" "ARGUS_ENGAGEMENT_MANIFEST=$MANIFEST" ARGUS_ENGAGEMENT_LANE=odysseus ARGUS_ENVIRONMENT_RESET=execute
has_event "$label" environment policy denied false n/a - environment-reset-unauthorized
not_called "$label" '^reset$'

label=engagement-fault-allowed
prepare "$label" green
engagement_env "$label" fault
run_case "$label" 0 baseline "${ENGAGEMENT_ENV[@]}" ARGUS_ENGAGEMENT_LANE=tyche ARGUS_FAULT_INJECTION=authorized \
  ARGUS_AUTHORIZATION_RATE=5 ARGUS_AUTHORIZATION_CONCURRENCY=1 ARGUS_AUTHORIZATION_TOTAL_REQUESTS=50 ARGUS_AUTHORIZATION_DURATION=30
called "$label" "env mode=baseline pass=live outcome=$WORK/$label/reports/outcomes.raw.tsv fault=authorized"
[ "$(cli_log "$label" | sed -n 2p)" = "authorization check --manifest $WORK/engagement/ai_agents_internal/authorization.json --lane tyche --action chaos --target file://$READY --source-trust manifest --resource fault-injection --rate 5 --concurrency 1 --total-requests 50 --duration 30" ] ||
  fail "$label did not request the chaos authorization decision: $(cli_log "$label")"

label=engagement-fault-no-window
prepare "$label" green
engagement_env "$label" reset
run_case "$label" 13 baseline "${ENGAGEMENT_ENV[@]}" ARGUS_ENGAGEMENT_LANE=tyche ARGUS_FAULT_INJECTION=authorized
has_event "$label" fault-injection policy denied false n/a - fault-injection-unauthorized
not_called "$label" '.'

# Outside an engagement the operator's opt-in stands and the CLI is never consulted.
label=customer-reset
prepare "$label" reset-ok
run_case "$label" 0 full-suite "PATH=$FAKE_BIN:$PATH" "FAKE_ARGUS_LOG=$WORK/$label/argus-assets.log" ARGUS_ENVIRONMENT_RESET=execute
has_event "$label" environment infrastructure pass false n/a - environment-reset-executed
[ -z "$(cli_log "$label")" ] || fail "$label consulted the engagement CLI outside an engagement"

printf 'PASS  Argus runner gates: lane plan, environment baseline, inventory quarantine, adapter status, per-pass evidence, contract smoke, and engagement opt-in authorization\n'
