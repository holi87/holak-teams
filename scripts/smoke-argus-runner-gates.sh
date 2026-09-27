#!/usr/bin/env bash
# Scenario smoke for the portable runner library (scripts/runner-lib.sh) and its gates: lane
# plan, environment baseline, inventory-based quarantine, the inventory gate (provenance,
# lanes, disabled regressions, confirmed-bug coverage, focused tests, unexecuted selection),
# adapter status, the defect-evidence pass loop and evidence gate (live, repeat,
# counterfactual), contract smoke, and engagement authorization of destructive opt-ins. A
# replay runtime stands in for the frameworks, so no target, browser, or build tool is needed.
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

# prepare <label> <scenario>[+<overlay>...]: a fresh runner directory holding the common
# scripts, the replay runtime, the green base scenario, and the named scenarios layered on
# top of it in order. A scenario's tests/ directory becomes the runner's test root.
prepare() {
  local label="$1" scenario dir="$WORK/$1" file
  local layers=()
  IFS=+ read -r -a layers <<<"$2"
  mkdir -p "$dir/scripts" "$dir/solution" "$dir/ai_agents_internal" "$dir/scenario"
  cp "$COMMON/scripts/"* "$dir/scripts/"
  cp "$FIXTURES/fake-runtime/run-tests.sh" "$dir/run-tests.sh"
  cp -R "$SCENARIOS/green/." "$dir/scenario/"
  for scenario in "${layers[@]}"; do
    if [ "$scenario" != green ]; then cp -R "$SCENARIOS/$scenario/." "$dir/scenario/"; fi
  done
  for file in test-lanes.tsv environment.tsv quarantine.tsv; do
    if [ -f "$dir/scenario/$file" ]; then cp "$dir/scenario/$file" "$dir/solution/$file"; fi
  done
  if [ -d "$dir/scenario/scripts" ]; then cp "$dir/scenario/scripts/"* "$dir/scripts/"; fi
  if [ -d "$dir/scenario/tests" ]; then cp -R "$dir/scenario/tests" "$dir/tests"; fi
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
for script in runner-lib.sh lane-plan.sh environment-gate.sh quarantine-contract.sh inventory-gate.sh evidence-gate.sh runner-contract.sh; do
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

# Quarantine evaluator: --inventory is required and needs a real file; --tagged-count is retired.
printf 'case.one\tapi\tfalse\ttrue\t-\t-\t-\t-\n' >"$UNIT/inventory.tsv"
for arguments in "--inventory $UNIT/inventory.tsv --tagged-count 1" "--inventory $UNIT/missing-inventory.tsv" ""; do
  set +e
  # shellcheck disable=SC2086
  "$COMMON/scripts/quarantine-contract.sh" --events "$UNIT/quarantine-usage.tsv" $arguments >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -eq 14 ] || fail "quarantine-contract accepted invalid arguments '$arguments' with exit $code"
done

# Inventory gate, unit level.
GATE="$COMMON/scripts/inventory-gate.sh"
IG="$UNIT/inventory-gate"
mkdir -p "$IG"
row() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@"; }
unit_event() { grep -Fxq "$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "${@:2}")" "$1" || fail "$(basename "$1") lacks event: ${*:2}"; }
# gate_code <command...>: the exit status of one gate call, with its stderr discarded.
gate_code() {
  set +e
  "$@" 2>/dev/null
  code=$?
  set -e
  printf '%s\n' "$code"
}
for arguments in "" "static" "lint --inventory x --lanes api --events y --mode baseline" \
  "static --inventory x --expected-bugs y --lanes api --events z --mode smoke --test-root t" \
  "static --inventory x --expected-bugs y --lanes API --events z --mode baseline --test-root t" \
  "static --inventory x --lanes api --events z --mode baseline --test-root t" \
  "executed --inventory x --lanes api --events z --mode baseline --shard 1"; do
  # shellcheck disable=SC2086
  [ "$(gate_code "$GATE" $arguments)" -eq 14 ] || fail "inventory-gate accepted invalid arguments '$arguments'"
done
printf 'BUG-0001\n' >"$IG/expected.txt"
row api.health api false false - - - tests/api/health.spec.ts:3 >"$IG/good.tsv"
invalid_inventory() {
  local label="$1"
  [ "$(gate_code "$GATE" static --inventory "$IG/$label.tsv" --expected-bugs "$IG/expected.txt" --lanes api,ui \
    --events "$IG/$label.events" --mode baseline --test-root "$IG/absent")" -eq 1 ] || fail "inventory '$label' was accepted"
  [ "$(cat "$IG/$label.events")" = "$(printf 'test-inventory\tautomation\tfail\tfalse\tn/a\t-\ttest-inventory-invalid')" ] ||
    fail "inventory '$label' was not reported as invalid, and only as invalid"
}
: >"$IG/empty.tsv"
{ cat "$IG/good.tsv"; row ui.login ui false false - - - tests/ui/login.spec.ts:5 | tr -d '\n'; printf '\textra\n'; } >"$IG/long-row.tsv"
row api.x api yes false - - - - >"$IG/bad-regression.tsv"
row api.x api true maybe BUG-0001 - - - >"$IG/bad-quarantine.tsv"
row api.x api true false BUG-1 - - - >"$IG/bad-bug.tsv"
row api.x api true false 'BUG-0001, BUG-0002' - - - >"$IG/bad-bug-list.tsv"
row api.x api true false - 'raw token' - - >"$IG/bad-unresolved.tsv"
row api.x api true false BUG-0001 - skipped - >"$IG/bad-disabled.tsv"
row 'api x' api false false - - - - >"$IG/bad-case-id.tsv"
row api.x 'api ui' false false - - - - >"$IG/bad-lane.tsv"
row api.x api false false - - - 'tests/a b.ts:1' >"$IG/bad-source.tsv"
row api.x api false false - - '' - >"$IG/empty-field.tsv"
{ row api.x api false false - - - - | tr -d '\n'; printf '\r\n'; } >"$IG/crlf.tsv"
{ cat "$IG/good.tsv"; printf '\n'; } >"$IG/blank-line.tsv"
{ cat "$IG/good.tsv" "$IG/good.tsv"; } >"$IG/duplicate.tsv"
for label in absent empty long-row bad-regression bad-quarantine bad-bug bad-bug-list bad-unresolved bad-disabled \
  bad-case-id bad-lane bad-source empty-field crlf blank-line duplicate; do
  invalid_inventory "$label"
done
[ "$(gate_code "$GATE" executed --inventory "$IG/duplicate.tsv" --lanes api --events "$IG/executed-invalid.events" --mode baseline)" -eq 1 ] ||
  fail "the executed check accepted an unusable inventory"
printf 'BUG-0001\nbug-2\n' >"$IG/expected-invalid.txt"
"$GATE" static --inventory "$IG/good.tsv" --expected-bugs "$IG/expected-invalid.txt" --lanes api --events "$IG/expected-invalid.events" \
  --mode baseline --test-root "$IG/absent" 2>/dev/null || fail "an invalid confirmed-bug line stopped the static gate"
unit_event "$IG/expected-invalid.events" expected-bugs policy denied false n/a - expected-bugs-invalid
"$GATE" static --inventory "$IG/good.tsv" --expected-bugs "$IG/absent.txt" --lanes api --events "$IG/baseline-no-bugs.events" \
  --mode baseline --test-root "$IG/absent" || fail "a baseline without a confirmed-bug list stopped the static gate"
[ ! -e "$IG/baseline-no-bugs.events" ] || fail "a baseline without a confirmed-bug list emitted events"

# Focus scan: every positive is found on its own; decoys, other languages, and node_modules
# are not scanned or not matched. A missing test root has nothing to scan.
focus_root() {
  local label="$1" file="$2" content="$3"
  mkdir -p "$IG/focus-$label/$(dirname "$file")"
  printf '%s\n' "$content" >"$IG/focus-$label/$file"
}
focus_scan() {
  "$GATE" static --inventory "$IG/good.tsv" --expected-bugs "$IG/expected.txt" --lanes api --events "$IG/focus-$1.events" \
    --mode baseline --test-root "$IG/focus-$1" 2>/dev/null || fail "the focus scan of '$1' stopped the static gate"
}
index=0
for positive in "test.only('a', () => {});" "describe.only ('suite', () => {});" "  it.only('b', () => {});" \
  "(test.only('c', () => {}));" "test.only	('d', () => {});"; do
  for extension in ts tsx js jsx mjs cjs; do
    index=$((index + 1))
    focus_root "positive-$index" "api/case.spec.$extension" "$positive"
    focus_scan "positive-$index"
    unit_event "$IG/focus-positive-$index.events" focus-scan policy denied false n/a - focused-test-forbidden
  done
done
focus_root decoys api/decoys.spec.ts "contest.only('a');
suite.test.only('b');
\$test.only('c');
_it.only('d');
const focus = test.only;
test.skip('e', () => {});
// it.onlyOnce('f');"
focus_root decoys api/python_test.py "test.only('g')"
focus_root decoys api/node_modules/vendor.spec.ts "test.only('h');"
focus_scan decoys
[ ! -e "$IG/focus-decoys.events" ] || fail "the focus scan matched a decoy: $(cat "$IG/focus-decoys.events")"

# Executed check: an event counts for the longest inventory id it equals or extends, and the
# selection honours lanes, quarantine, the mode's regression filter, and the contract smoke.
{
  row api.widget api true false BUG-0001 - - -
  row api.widget.2 api true false BUG-0001 - - -
  row api.health api false false - - - -
  row api.flaky api false true - - - -
  row perf.budget perf false false - - - -
  row contract.template contract-smoke false false - - - -
  row setup.login setup false false - - - -
} >"$IG/selection.tsv"
printf 'api.widget.2.repeat\tproduct\tfail\ttrue\treproduced\tBUG-0001\texpected-red-repeat\n' >"$IG/selection-events.tsv"
# executed_check <label> <options...>: sets UNEXECUTED to the case ids the check reported.
executed_check() {
  local label="$1"
  shift
  cp "$IG/selection-events.tsv" "$IG/executed-$label.events"
  "$GATE" executed --inventory "$IG/selection.tsv" --events "$IG/executed-$label.events" "$@" 2>/dev/null ||
    fail "the executed check '$label' failed"
  UNEXECUTED="$(cut -f1 "$IG/executed-$label.events" | sed 1d | tr '\n' ' ')"
}
executed_check regression --lanes api,ui --mode candidate-regression
[ "$UNEXECUTED" = "api.widget " ] || fail "a collision id stood in for its base test, or the regression selection is wrong: $UNEXECUTED"
unit_event "$IG/executed-regression.events" api.widget skip skipped false n/a BUG-0001 selected-test-not-executed
executed_check baseline --lanes api,perf --mode baseline
[ "$UNEXECUTED" = "api.health perf.budget " ] || fail "the baseline selection is wrong: $UNEXECUTED"
executed_check full --lanes api --mode full-suite
[ "$UNEXECUTED" = "api.widget api.health " ] || fail "the full-suite selection is wrong: $UNEXECUTED"
executed_check smoke --lanes contract-smoke --mode full-suite --contract-smoke
[ "$UNEXECUTED" = "contract.template " ] || fail "the contract-smoke selection is wrong: $UNEXECUTED"

# Evidence gate, unit level.
EVIDENCE="$COMMON/scripts/evidence-gate.sh"
EG="$UNIT/evidence-gate"
mkdir -p "$EG"
for arguments in "" "--plan x" "--plan x --events y" "--expected-bugs x --events y --list-passes" "--plan x --list-passes --lanes api"; do
  # shellcheck disable=SC2086
  [ "$(gate_code "$EVIDENCE" $arguments)" -eq 14 ] || fail "evidence-gate accepted invalid arguments '$arguments'"
done
# passes_expect <plan> <passes>: the counterfactual passes the plan asks for, space-separated.
passes_expect() {
  local plan="$1" wanted="$2" got
  "$EVIDENCE" --plan "$EG/$plan" --list-passes >"$EG/passes.out" 2>/dev/null || fail "the pass list for plan $plan failed"
  got="$(tr '\n' ' ' <"$EG/passes.out")"
  got="${got% }"
  [ "$got" = "$wanted" ] || fail "plan $plan asked for passes '$got' instead of '$wanted'"
}
printf 'BUG-0001\tfixture\tobserved-defect\t-\nBUG-0002\texempt\t-\tdata-layer\nBUG-0003\tfixture\tobserved-defect,wrong-type,stale-cache\t-\nBUG-0004\tinvalid\t-\tschema-invalid\n' >"$EG/mixed.tsv"
passes_expect mixed.tsv "cf-correct cf-tamper-1 cf-tamper-2 cf-tamper-3"
printf 'BUG-0002\texempt\t-\tdata-layer\n' >"$EG/exempt-only.tsv"
passes_expect exempt-only.tsv cf-correct
printf 'BUG-0001\tmissing\t-\t-\nBUG-0004\tinvalid\t-\tcorrect-violates-contract\n' >"$EG/no-proof.tsv"
printf 'BUG-0001\tfixture\tobserved-defect\t-\nBUG-0002\tfixture\tobserved-defect,observed-defect\t-\n' >"$EG/duplicate-tamper.tsv"
printf 'BUG-0001\tfixture\tobserved-defect\t-\nBUG-0001\texempt\t-\tdata-layer\n' >"$EG/duplicate-bug.tsv"
printf 'BUG-0001\tfixture\tobserved-defect\t-\nBUG-0002\tstubbed\t-\t-\n' >"$EG/bad-status.tsv"
printf 'BUG-0001\texempt\t-\tflaky\n' >"$EG/bad-exemption.tsv"
printf 'BUG-0001\tfixture\tObserved\t-\n' >"$EG/bad-tamper.tsv"
printf 'BUG-0001\tfixture\t-\t-\n' >"$EG/fixture-without-tampers.tsv"
printf 'BUG-0001\tfixture\tobserved-defect\n' >"$EG/short-row.tsv"
for plan in absent.tsv no-proof.tsv duplicate-tamper.tsv duplicate-bug.tsv bad-status.tsv bad-exemption.tsv bad-tamper.tsv \
  fixture-without-tampers.tsv short-row.tsv; do
  passes_expect "$plan" ""
done

# evidence_expect <label> <plan> <reasons> [events...]: runs the gate for BUG-0001 over the
# given event lines and requires exactly the listed reasons, in order, among the events it
# appended.
evidence_expect() {
  local label="$1" plan="$2" wanted="$3" got lines
  shift 3
  printf 'BUG-0001\n' >"$EG/$label.expected"
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" >"$EG/$label.events"; else : >"$EG/$label.events"; fi
  lines="$(wc -l <"$EG/$label.events")"
  "$EVIDENCE" --expected-bugs "$EG/$label.expected" --plan "$EG/$plan" --events "$EG/$label.events" 2>/dev/null ||
    fail "the evidence gate '$label' failed"
  got="$(tail -n "+$((lines + 1))" "$EG/$label.events" | cut -f7 | tr '\n' ' ')"
  got="${got% }"
  [ "$got" = "$wanted" ] || fail "evidence gate '$label' emitted '$got' instead of '$wanted'"
}
LIVE="api.w${T}product${T}fail${T}true${T}reproduced${T}BUG-0001${T}expected-red"
REPEAT="api.w.repeat${T}product${T}fail${T}true${T}reproduced${T}BUG-0001${T}expected-red-repeat"
CORRECT="api.w.cf-correct${T}product${T}pass${T}false${T}reproduced${T}BUG-0001${T}counterfactual-correct-pass"
TAMPER="api.w.cf-observed-defect${T}product${T}fail${T}true${T}reproduced${T}BUG-0001${T}counterfactual-tamper-red"
UNREPRODUCED="${T}product${T}pass${T}false${T}n/a${T}BUG-0001${T}intermittent-unreproduced"
TIMEOUT="${T}automation${T}fail${T}false${T}n/a${T}BUG-0001${T}test-timeout"
EXEMPT="api.w.cf${T}policy${T}pass${T}false${T}n/a${T}BUG-0001${T}counterfactual-exempt"
printf 'BUG-0001\tfixture\tobserved-defect\t-\n' >"$EG/fixture.tsv"
printf 'BUG-0001\texempt\t-\tdata-layer\n' >"$EG/exempt.tsv"
printf 'BUG-0001\tinvalid\t-\tcorrect-violates-contract\n' >"$EG/invalid.tsv"
printf 'BUG-0002\tfixture\tobserved-defect\t-\n' >"$EG/other-bug.tsv"
evidence_expect complete fixture.tsv "" "$LIVE" "$REPEAT" "$CORRECT" "$TAMPER"
evidence_expect nothing fixture.tsv "evidence-live-red-missing evidence-repeat-red-missing counterfactual-incomplete"
unit_event "$EG/nothing.events" evidence.BUG-0001 policy denied false n/a BUG-0001 evidence-live-red-missing
unit_event "$EG/nothing.events" counterfactual.BUG-0001 policy denied false n/a BUG-0001 counterfactual-incomplete
for plan in absent.tsv duplicate-bug.tsv bad-status.tsv short-row.tsv other-bug.tsv; do
  evidence_expect "plan-$plan" "$plan" counterfactual-plan-missing "$LIVE" "$REPEAT" "$CORRECT" "$TAMPER"
done
unit_event "$EG/plan-absent.tsv.events" counterfactual.BUG-0001 policy denied false n/a BUG-0001 counterfactual-plan-missing
evidence_expect invalid invalid.tsv counterfactual-fixture-invalid.correct-violates-contract "$LIVE" "$REPEAT"
unit_event "$EG/invalid.events" counterfactual.BUG-0001 automation fail false n/a BUG-0001 counterfactual-fixture-invalid.correct-violates-contract
# SD-6 intermittent defects: one RED across live and repeat suffices; none at all is missing.
evidence_expect intermittent-repeat fixture.tsv "" "api.w$UNREPRODUCED" "$REPEAT" "$CORRECT" "$TAMPER"
evidence_expect intermittent-live fixture.tsv "" "$LIVE" "api.w.repeat$UNREPRODUCED" "$CORRECT" "$TAMPER"
evidence_expect intermittent-none fixture.tsv evidence-live-red-missing "api.w$UNREPRODUCED" "api.w.repeat$UNREPRODUCED" "$CORRECT" "$TAMPER"
# A failing verdict of a pass answers that pass's check (its own category already fails the
# run); a verdict of another pass, or a passing outcome, does not.
evidence_expect answered fixture.tsv "" "api.w$TIMEOUT" "api.w.repeat$TIMEOUT" "api.w.cf-correct$TIMEOUT" "api.w.cf-observed-defect$TIMEOUT"
evidence_expect wrong-pass fixture.tsv evidence-repeat-red-missing "$LIVE" "api.w.cf-correct$TIMEOUT" "$CORRECT" "$TAMPER"
evidence_expect cleanup-answers fixture.tsv "" "$LIVE" "$REPEAT" "$CORRECT" "api.w.cf-observed-defect.cleanup$TIMEOUT"
evidence_expect passing-tamper fixture.tsv counterfactual-incomplete "$LIVE" "$REPEAT" "$CORRECT" \
  "api.w.cf-observed-defect${T}product${T}pass${T}false${T}n/a${T}BUG-0001${T}passed"
evidence_expect expected-red-passed fixture.tsv evidence-repeat-red-missing "api.w${T}product${T}pass${T}true${T}automated${T}BUG-0001${T}expected-red-passed" \
  "$CORRECT" "$TAMPER"
evidence_expect two-correct fixture.tsv counterfactual-incomplete "$LIVE" "$REPEAT" "$CORRECT" "$CORRECT" "$TAMPER"
evidence_expect wrong-tamper fixture.tsv counterfactual-incomplete "$LIVE" "$REPEAT" "$CORRECT" "${TAMPER/cf-observed-defect/cf-stale-cache}"
evidence_expect other-bug-proof fixture.tsv "evidence-live-red-missing evidence-repeat-red-missing counterfactual-incomplete" \
  "${LIVE/BUG-0001/BUG-0002}" "${REPEAT/BUG-0001/BUG-0002}" "${CORRECT/BUG-0001/BUG-0002}" "${TAMPER/BUG-0001/BUG-0002}"
evidence_expect exempt exempt.tsv "" "$LIVE" "$REPEAT" "$EXEMPT.data-layer"
evidence_expect exempt-mismatch exempt.tsv counterfactual-incomplete "$LIVE" "$REPEAT" "$EXEMPT.timing-or-load"
"$EVIDENCE" --expected-bugs "$EG/absent.txt" --plan "$EG/fixture.tsv" --events "$EG/no-bugs.events" || fail "a missing confirmed-bug list stopped the evidence gate"
[ ! -e "$EG/no-bugs.events" ] || fail "the evidence gate emitted events without confirmed bugs"

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
printf 'BUG-0009\tmissing\t-\t-\n' >"$WORK/green-baseline/reports/counterfactual-plan.tsv"
printf 'stale\tproduct\tfail\tfalse\tn/a\t-\tassertion-failed\n' >"$WORK/green-baseline/reports/outcomes.raw.tsv"
run_case green-baseline 0 baseline
[ "$(cat "$WORK/green-baseline/reports/expected-bugs.txt")" = BUG-0001 ] || fail "a stale expected-bugs file survived the next run"
[ ! -e "$WORK/green-baseline/reports/counterfactual-plan.tsv" ] || fail "a stale counterfactual plan survived the next run"

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
has_event lane-not-executed ui.login skip skipped false n/a - selected-test-not-executed

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

# Inventory gate (static): provenance, lanes, disabled regressions, and confirmed bugs. The
# 11 cases run in baseline, where no coverage denial can outrank their automation failure.
case_run provenance-unresolved provenance-unresolved 13 baseline
has_event provenance-unresolved api.widget-regression policy denied false n/a - bug-provenance-unresolved
lacks_reason provenance-unresolved '^regression-without-provenance$'
case_run provenance-without-regression provenance-without-regression 11 baseline
has_event provenance-without-regression api.health automation fail false n/a BUG-0001 bug-provenance-without-regression
case_run regression-without-provenance regression-without-provenance 11 baseline
has_event regression-without-provenance api.widget-regression automation fail false n/a - regression-without-provenance
case_run provenance-multiple provenance-multiple 11 baseline
has_event provenance-multiple api.widget-regression automation fail false n/a - multiple-bug-provenance
lacks_reason provenance-multiple '^regression-for-unconfirmed-bug$'
case_run regression-disabled regression-disabled 13 baseline
has_event regression-disabled api.widget-regression policy denied false n/a BUG-0001 regression-disabled.fixme
case_run regression-disabled-lane regression-disabled-lane 13 baseline
has_event regression-disabled-lane perf.budget-regression policy denied false n/a BUG-0001 regression-in-disabled-lane
# A contract smoke selects only its own lane, so product-lane state is not checked there.
case_run contract-smoke-regression contract-smoke-regression 0 baseline ARGUS_CONTRACT_SMOKE=1
called contract-smoke-regression "run baseline live contract-smoke"
lacks_reason contract-smoke-regression '^regression-in-disabled-lane$'
case_run regression-unconfirmed regression-unconfirmed 13 baseline
has_event regression-unconfirmed api.widget-regression policy denied false n/a BUG-0001 regression-for-unconfirmed-bug
case_run lane-undeclared lane-undeclared 11 baseline
has_event lane-undeclared misc.orphan automation fail false n/a - lane-undeclared
has_event lane-undeclared misc.shared automation fail false n/a - lane-ambiguous
has_event lane-undeclared mobile.swipe automation fail false n/a - lane-undeclared
case_run focused-test focused-test 13 baseline
has_event focused-test focus-scan policy denied false n/a - focused-test-forbidden
grep -Fq 'inventory-gate: focused test in tests/api/focused.spec.ts' "$WORK/focused-test/run.log" || fail "focused-test did not name the focused file"
called focused-test "run baseline live api,ui"
case_run inventory-invalid inventory-invalid 11 baseline
has_event inventory-invalid test-inventory automation fail false n/a - test-inventory-invalid
not_called inventory-invalid '^run '

# Confirmed-bug coverage outside baseline. Every confirmed defect needs a runnable regression
# bound to it alone, and the confirmed-defect list itself must exist.
case_run expected-bugs expected-bugs 0 candidate-regression
result_is expected-bugs '.missingExpectedBugs == 0'
case_run expected-bugs-missing expected-bugs-missing 13 candidate-regression
has_event expected-bugs-missing bug-coverage.BUG-0002 policy denied false n/a BUG-0002 bug-uncovered
lacks_reason expected-bugs-missing '^selected-test-not-executed$'
prepare expected-bugs-absent green
rm "$WORK/expected-bugs-absent/scenario/expected-bugs.txt"
run_case expected-bugs-absent 13 candidate-regression
has_event expected-bugs-absent expected-bugs policy denied false n/a - expected-bugs-missing
has_event expected-bugs-absent api.widget-regression policy denied false n/a BUG-0001 regression-for-unconfirmed-bug
# runner-contract.sh requires the list outside baseline. The library substitutes an empty one
# only for a run that stopped before the inventory pass (narrowing, reset-fails above) or whose
# absence the inventory gate denied; an absence nothing recorded stays a contract error.
prepare expected-bugs-unexplained quarantine-orphaned
rm "$WORK/expected-bugs-unexplained/scenario/expected-bugs.txt"
run_case expected-bugs-unexplained 14 candidate-regression
has_event expected-bugs-unexplained api.retired policy denied false n/a - quarantine-entry-orphaned
lacks_reason expected-bugs-unexplained '^expected-bugs-missing$'
case_run coverage-baseline expected-bugs-missing 0 baseline
lacks_reason coverage-baseline '^bug-uncovered$'
# Inventory gate (executed): a selected test without any outcome, including a collision id
# that must not stand in for its base test.
case_run selected-not-executed selected-not-executed 15 candidate-regression
has_event selected-not-executed api.widget-regression skip skipped false n/a BUG-0001 selected-test-not-executed
lacks_reason selected-not-executed '^bug-uncovered$'
[ "$(grep -c 'selected-test-not-executed' "$WORK/selected-not-executed/reports/outcomes.raw.tsv")" -eq 1 ] ||
  fail "selected-not-executed reported an executed test"

# defect-evidence: live, repeat, cf-correct, and one cf-tamper pass per tamper of the widest
# fixture, each with its own artifacts, then the evidence gate.
case_run defect-evidence defect-evidence 0 defect-evidence
called defect-evidence "run regression live api,ui"
called defect-evidence "env mode=defect-evidence pass=live outcome=$WORK/defect-evidence/reports/outcomes.raw.tsv fault="
called defect-evidence "env mode=defect-evidence pass=cf-tamper-2 outcome=$WORK/defect-evidence/reports/outcomes.raw.tsv fault="
[ "$(call_order defect-evidence)" = "prepare|verify|inventory only=1|run regression live api,ui|collect live|run regression repeat api,ui|collect repeat|run regression cf-correct api,ui|collect cf-correct|run regression cf-tamper-1 api,ui|collect cf-tamper-1|run regression cf-tamper-2 api,ui|collect cf-tamper-2|post defect-evidence|" ] ||
  fail "defect-evidence ran its passes out of order: $(call_order defect-evidence)"
for pass in live repeat cf-correct cf-tamper-1 cf-tamper-2; do
  grep -Fxq "native report for pass $pass" "$WORK/defect-evidence/reports/evidence/passes/$pass/native-report.txt" ||
    fail "defect-evidence did not store the $pass pass evidence"
done
lacks_reason defect-evidence '^evidence-|^counterfactual-plan|^counterfactual-missing|^counterfactual-incomplete|^selected-test'
case_run evidence-missing-repeat defect-evidence+evidence-missing-repeat 13 defect-evidence
has_event evidence-missing-repeat evidence.BUG-0001 policy denied false n/a BUG-0001 evidence-repeat-red-missing
lacks_reason evidence-missing-repeat '^evidence-live-red-missing$'
case_run evidence-flaky-red defect-evidence+evidence-flaky-red 11 defect-evidence
has_event evidence-flaky-red api.widget-regression.repeat automation fail false n/a BUG-0001 flaky-red
lacks_reason evidence-flaky-red '^evidence-repeat-red-missing$'
case_run counterfactual-missing defect-evidence+counterfactual-missing 13 defect-evidence
has_event counterfactual-missing counterfactual.BUG-0001 policy denied false n/a BUG-0001 counterfactual-missing
not_called counterfactual-missing '^run regression cf-'
case_run counterfactual-incomplete defect-evidence+counterfactual-incomplete 13 defect-evidence
has_event counterfactual-incomplete counterfactual.BUG-0001 policy denied false n/a BUG-0001 counterfactual-incomplete
called counterfactual-incomplete "run regression cf-tamper-2 api,ui"
case_run counterfactual-invalid defect-evidence+counterfactual-invalid 11 defect-evidence
has_event counterfactual-invalid counterfactual.BUG-0001 automation fail false n/a BUG-0001 counterfactual-fixture-invalid.missing-observed-defect
not_called counterfactual-invalid '^run regression cf-'
case_run counterfactual-exempt defect-evidence+counterfactual-exempt 0 defect-evidence
[ "$(call_order counterfactual-exempt)" = "prepare|verify|inventory only=1|run regression live api,ui|collect live|run regression repeat api,ui|collect repeat|run regression cf-correct api,ui|collect cf-correct|post defect-evidence|" ] ||
  fail "counterfactual-exempt ran the wrong passes: $(call_order counterfactual-exempt)"
has_event counterfactual-exempt api.widget-regression.cf policy pass false n/a BUG-0001 counterfactual-exempt.timing-or-load
# A tamper that survives is the adapter's automation verdict; the gate does not hide it.
case_run counterfactual-tamper-survived defect-evidence+counterfactual-tamper-survived 11 defect-evidence
has_event counterfactual-tamper-survived api.widget-regression.cf-stale-cache automation fail false n/a BUG-0001 counterfactual-tamper-survived
lacks_reason counterfactual-tamper-survived '^counterfactual-incomplete$'
prepare counterfactual-plan-absent defect-evidence
rm "$WORK/counterfactual-plan-absent/scenario/counterfactual-plan.tsv"
run_case counterfactual-plan-absent 13 defect-evidence
has_event counterfactual-plan-absent counterfactual.BUG-0001 policy denied false n/a BUG-0001 counterfactual-plan-missing
not_called counterfactual-plan-absent '^run regression cf-'

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

printf 'PASS  Argus runner gates: lane plan, environment baseline, inventory quarantine, inventory gate, adapter status, defect-evidence passes and evidence gate, contract smoke, and engagement opt-in authorization\n'
