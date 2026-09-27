#!/usr/bin/env bash
# Python runtime adapter smoke (template contract v2, RUNNER-CONTRACT.md SD-1 to SD-7).
# In a clean-room copy of the Python template, the qa.argus_plugin pytest plugin must write
# the SD-3 inventory, SD-4 expected bugs and SD-10 counterfactual plan from a collect-only
# pass, turn every SD-5/SD-6 outcome into exactly the expected events (identically under
# pytest-xdist), fail closed on emission problems, and stay inert without ARGUS_RUNNER_MODE.
# The qa.oracles contract, data, and behaviour oracle self-tests must report a product pass for
# every case against loopback stubs, and the cf-correct/cf-tamper passes must judge a regression
# against the in-process counterfactual stub. The created_resources and fault_injector fixtures must report their
# failures through the adapter. Finally ./run-tests.sh runs end to end (runner-lib.sh, lane
# plan, environment baseline, evidence passes) in a scaffold against
# scripts/fixtures/argus-runtime/faulty-target.mjs. Only loopback stubs and that local
# 127.0.0.1 target are ever contacted; no browser is needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-runtime/python"
PYTHON_BIN="${PYTHON:-python3}"
WORK="$(mktemp -d)"
TARGET_PID="" TARGET_PORT="" TARGET_URL="" NODE_BIN=""
# Exits 0 when 127.0.0.1:<argv[1]> accepts a connection.
PORT_OPEN='const s = require("net").connect(Number(process.argv[1]), "127.0.0.1"); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1));'

# stop_target: stops the end-to-end target started by start_target, if any, and returns
# non-zero unless its port is closed afterwards. The target runs as the resolved node binary
# (NODE_BIN): under a version-manager shim $! is the shim, and killing it would orphan the
# listening server.
stop_target() {
  local port="$TARGET_PORT"
  if [ -n "$TARGET_PID" ]; then
    kill "$TARGET_PID" 2>/dev/null || true
    wait "$TARGET_PID" 2>/dev/null || true
  fi
  TARGET_PID="" TARGET_PORT=""
  [ -z "$port" ] || ! "$NODE_BIN" -e "$PORT_OPEN" "$port"
}
trap 'stop_target || printf "FAIL  the faulty target outlived the smoke\n" >&2; rm -rf "$WORK"' EXIT
# The host environment must not activate or redirect the adapter behind the smoke's back. The
# same holds for the runner library's inputs in the end-to-end section.
unset ARGUS_RUNNER_MODE ARGUS_INVENTORY_ONLY ARGUS_EVIDENCE_PASS ARGUS_OUTCOME_FILE ARGUS_CONTRACT_SMOKE \
  ARGUS_COUNTERFACTUAL_API_URL ARGUS_API_ROUTE_PATTERN ARGUS_SMOKE_EXTRA_REQUEST OPENAPI_PATH \
  ARGUS_ENGAGEMENT_MANIFEST ARGUS_ENGAGEMENT_LANE ARGUS_ENVIRONMENT_RESET ARGUS_FAULT_INJECTION ARGUS_READINESS_URLS \
  ARGUS_TEST_ROOT ARGUS_AUTH_DIRECTORY ARGUS_BROWSER_ARTIFACTS ARGUS_RESET_TIMEOUT_SECONDS ARGUS_VERIFY_TIMEOUT_SECONDS \
  UI_URL PERF_BUDGET_MS SECURITY_ENABLED DB_URL WORKERS

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
tab() { local IFS=$'\t'; printf '%s\n' "$*"; }
for tool in jq node; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done
NODE_BIN="$(node -p process.execPath)"

APP="$WORK/python"
"$CLI" copy-template python "$APP" >/dev/null
cd "$APP"
if ! { "$PYTHON_BIN" -m venv .venv && .venv/bin/python -m pip install -q -r requirements.txt; } >"$WORK/install.log" 2>&1; then
  tail -40 "$WORK/install.log" >&2
  fail "Python template dependencies could not be installed"
fi
cp "$FIXTURES/test_classification_fixture.py" tests/contract/test_classification_fixture.py
cp "$FIXTURES/bug-ledger.json" solution/bug-ledger.json

FIXTURE=tests/contract/test_classification_fixture.py
CASE='tests.contract.test_classification_fixture.py::'
INVENTORY=reports/test-inventory.tsv
EXPECTED_BUGS=reports/expected-bugs.txt
PLAN=reports/counterfactual-plan.tsv
STATUS=reports/argus-adapter-status.txt
PYTEST=(.venv/bin/python -m pytest -q -o addopts= --strict-markers -p no:cacheprovider)
PYTEST_EXIT=0

# pytest_run <label> [VAR=value ...] -- <pytest args...>: records the exit code, never aborts.
pytest_run() {
  local label="$1" vars=()
  shift
  while [ "$1" != -- ]; do vars+=("$1"); shift; done
  shift
  set +e
  env ${vars[@]+"${vars[@]}"} "${PYTEST[@]}" "$@" >"$WORK/$label.log" 2>&1
  PYTEST_EXIT=$?
  set -e
}
expect_exit() {
  [ "$PYTEST_EXIT" -eq "$2" ] || { tail -40 "$WORK/$1.log" >&2; fail "$1 exited $PYTEST_EXIT, expected $2"; }
}
inventory_fields() { awk -F'\t' -v id="$1" '$1 == id { print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7 }' "$INVENTORY"; }
expect_row() {
  local got
  got="$(inventory_fields "$1")"
  [ "$got" = "$2" ] || fail "inventory row $1: got '$got', expected '$2'"
}
expect_events() {
  local file="$1" label="$2"
  shift 2
  [ -f "$file" ] || fail "$label emitted no events"
  printf '%s\n' "$@" | sort >"$WORK/$label.expected"
  sort "$file" >"$WORK/$label.actual"
  diff -u "$WORK/$label.expected" "$WORK/$label.actual" >&2 || fail "$label events differ from the SD-5/SD-6 expectation"
}
expect_status() {
  local got
  got="$(cat "$STATUS" 2>/dev/null || true)"
  [ "$got" = "$1" ] || fail "$2: adapter status '$got', expected '$1'"
}

# SD-2: above 200 characters the id keeps 187 characters, '.', and 12 digits of sha256(x).
LONG_ID="$(.venv/bin/python - <<'PY'
import hashlib
x = "tests/contract/test_classification_fixture.py::test_parametrized_ids[" + "x" * 240 + "]"
raw = x.replace("/", ".")
safe = raw.replace("[", "-").rstrip("]")
print(safe[:187] + "." + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12])
PY
)"

# (1) Collect-only inventory over the full collection: SD-2 ids, SD-3 rows, SD-4 join.
pytest_run inventory ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/inventory-events.tsv" -- --collect-only
expect_exit inventory 0
collected="$(grep -c '::' "$WORK/inventory.log")"
[ "$(wc -l <"$INVENTORY" | tr -d ' ')" = "$collected" ] || fail "inventory does not cover all $collected collected tests"
[ -z "$(awk -F'\t' 'NF != 8' "$INVENTORY")" ] || fail "inventory rows must have exactly 8 fields"
[ -z "$(cut -f1 "$INVENTORY" | sort | uniq -d)" ] || fail "inventory case ids are not unique"
[ -z "$(cut -f1 "$INVENTORY" | grep -Ev '^[A-Za-z0-9_.:-]+$' || true)" ] || fail "inventory case ids contain unsafe characters"
expect_row "${CASE}test_regression_assertion_reproduces" "$(tab contract-smoke true false BUG-0001 - -)"
expect_row "${CASE}test_intermittent_reproduces" "$(tab contract-smoke true false BUG-0003 - -)"
expect_row "${CASE}test_regression_unknown_provenance" "$(tab contract-smoke true false - XYZ-999 -)"
expect_row "${CASE}test_plain_pass" "$(tab contract-smoke false false - - -)"
expect_row "${CASE}test_declared_skip" "$(tab contract-smoke false false - - skip)"
expect_row "${CASE}test_declared_conditional" "$(tab contract-smoke false false - - conditional)"
expect_row "${CASE}test_declared_expected_failure" "$(tab contract-smoke false false - - expected-failure)"
expect_row "${CASE}test_parametrized_ids-alpha-beta" "$(tab contract-smoke false false - - -)"
expect_row "${CASE}test_parametrized_ids-alpha-beta.2" "$(tab contract-smoke false false - - -)"
expect_row "${CASE}test_parametrized_ids-za-u017c-xf3-u0142-u0107" "$(tab contract-smoke false false - - -)"
expect_row "${CASE}test_za-_title" "$(tab contract-smoke false false - - -)"
expect_row "$LONG_ID" "$(tab contract-smoke false false - - -)"
[ "${#LONG_ID}" -eq 200 ] || fail "long case id is not 200 characters"
expect_row 'tests.api.test_example_api.py::test_health_endpoint_responds' "$(tab api false false - - -)"
expect_row 'tests.ui.test_example_ui.py::test_login_rejects_bad_credentials-chromium' "$(tab ui false false - - -)"
expect_row 'tests.ui.test_example_ui.py::test_primary_action_fits_a_375px_phone_viewport-chromium' "$(tab ui false false - - -)"
expect_row 'tests.api.test_example_api.py::test_every_invalid_order_partition_is_rejected_with_the_documented_status' "$(tab api false false - - -)"
expect_row 'tests.perf.test_budget_smoke.py::test_collection_read_grows_sub_linearly_with_the_collection_size' "$(tab perf false false - - -)"
awk -F'\t' -v id="${CASE}test_plain_pass" '$1 == id { exit !($8 ~ /^tests\/contract\/test_classification_fixture\.py:[0-9]+$/) }' "$INVENTORY" || fail "inventory source is not posix-path:line"
[ "$(cat "$EXPECTED_BUGS")" = "$(printf 'BUG-0001\nBUG-0003')" ] || fail "expected-bugs must list exactly the confirmed ids (needs-oracle and suspected excluded)"
[ "$(cat "$PLAN")" = "$(printf 'BUG-0001\tmissing\t-\t-\nBUG-0003\tmissing\t-\t-')" ] || fail "the counterfactual plan must list every confirmed bug as missing"
[ ! -s "$WORK/inventory-events.tsv" ] || fail "the inventory pass emitted events for a valid ledger"
expect_status "ok 0" inventory
cp "$INVENTORY" "$WORK/inventory.reference.tsv"
cp "$PLAN" "$WORK/plan.reference.tsv"

# ARGUS_INVENTORY_ONLY=1 alone is still collect-only: no test body runs, xdist stays off.
pytest_run inventory-forced ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/forced-events.tsv" -- -n 2 "$FIXTURE"
expect_exit inventory-forced 0
[ ! -s "$WORK/forced-events.tsv" ] || fail "an inventory pass without --collect-only ran test bodies"
if grep -Fq 'bringing up nodes' "$WORK/inventory-forced.log"; then fail "the inventory pass started xdist workers"; fi
expect_status "ok 0" inventory-forced

# (2) SD-4 ledger handling: missing, invalid, and the @1/@2 compatibility window.
ledger_inventory() {  # ledger_inventory <label> <mode> [ledger-file|-]
  rm -f solution/bug-ledger.json "$WORK/$1-events.tsv"
  [ "$3" = - ] || cp "$3" solution/bug-ledger.json
  pytest_run "$1" ARGUS_RUNNER_MODE="$2" ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/$1-events.tsv" -- --collect-only
  expect_exit "$1" 0
  touch "$WORK/$1-events.tsv"
}
ledger_inventory missing-baseline baseline -
[ -f "$EXPECTED_BUGS" ] && [ ! -s "$EXPECTED_BUGS" ] || fail "a missing ledger must leave an empty expected-bugs file"
[ -f "$PLAN" ] && [ ! -s "$PLAN" ] || fail "a missing ledger must leave an empty counterfactual plan"
[ ! -s "$WORK/missing-baseline-events.tsv" ] || fail "a missing ledger in baseline must emit no event"
ledger_inventory missing-evidence defect-evidence -
expect_events "$WORK/missing-evidence-events.tsv" missing-evidence "$(tab bug-ledger policy denied false n/a - bug-ledger-missing)"
expect_row "${CASE}test_regression_assertion_reproduces" "$(tab contract-smoke true false - ATA-001 -)"
jq '.bugs[1].origin += ["ATA-001"]' "$FIXTURES/bug-ledger.json" >"$WORK/alias-ledger.json"
jq '.bugs[1].id = "BUG-0001"' "$FIXTURES/bug-ledger.json" >"$WORK/duplicate-ledger.json"
jq '.schemaVersion = 1' "$FIXTURES/bug-ledger.json" >"$WORK/version-ledger.json"
printf '{"$schema": "argus/bug-ledger@2",' >"$WORK/broken-ledger.json"
for variant in alias duplicate version broken; do
  ledger_inventory "invalid-$variant" baseline "$WORK/$variant-ledger.json"
  expect_events "$WORK/invalid-$variant-events.tsv" "invalid-$variant" "$(tab bug-ledger policy denied false n/a - bug-ledger-invalid)"
  [ ! -s "$EXPECTED_BUGS" ] || fail "an invalid ($variant) ledger must leave expected-bugs empty"
  [ -f "$PLAN" ] && [ ! -s "$PLAN" ] || fail "an invalid ($variant) ledger must leave the counterfactual plan empty"
done
jq '."$schema" = "argus/bug-ledger@1" | .schemaVersion = 1' "$FIXTURES/bug-ledger.json" >"$WORK/v1-ledger.json"
ledger_inventory ledger-v1 defect-evidence "$WORK/v1-ledger.json"
[ ! -s "$WORK/ledger-v1-events.tsv" ] || fail "a valid bug-ledger@1 was rejected"
[ "$(cat "$EXPECTED_BUGS")" = "$(printf 'BUG-0001\nBUG-0003')" ] || fail "bug-ledger@1 expected-bugs differ"
cmp -s "$INVENTORY" "$WORK/inventory.reference.tsv" || fail "bug-ledger@1 and @2 produced different inventories"
cmp -s "$PLAN" "$WORK/plan.reference.tsv" || fail "bug-ledger@1 and @2 produced different counterfactual plans"
cp "$FIXTURES/bug-ledger.json" solution/bug-ledger.json

# A partial or failed collection never leaves an inventory that passes for the full one.
printf 'import not_a_module_argus_smoke\n' >tests/contract/test_broken_collection.py
pytest_run inventory-collection-error ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/collection-error-events.tsv" -- --collect-only
rm -f tests/contract/test_broken_collection.py
[ "$PYTEST_EXIT" -ne 0 ] || fail "an inventory pass with a collection error succeeded"
[ ! -e "$INVENTORY" ] || fail "a collection error left a partial inventory"
[ ! -e "$PLAN" ] || fail "a collection error published a counterfactual plan"
expect_status "error 1" inventory-collection-error
[ "$(cat reports/argus-adapter-errors/*.txt | cut -f2)" = collection-error ] || fail "the collection error was not listed"
cp "$WORK/inventory.reference.tsv" "$INVENTORY"
cp "$WORK/plan.reference.tsv" "$PLAN"
pytest_run inventory-usage-error ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/usage-error-events.tsv" -- --collect-only tests/contract/test_missing_argus_smoke.py
[ "$PYTEST_EXIT" -ne 0 ] || fail "an inventory pass over a missing path succeeded"
[ ! -e "$INVENTORY" ] && [ ! -e "$EXPECTED_BUGS" ] && [ ! -e "$PLAN" ] || fail "a failed inventory pass left the previous inventory behind"

# (3) defect-evidence live pass: every SD-5 primary outcome and SD-6 lifecycle event.
pytest_run serial ARGUS_RUNNER_MODE=defect-evidence ARGUS_OUTCOME_FILE="$WORK/serial.tsv" -- -m contract_smoke "$FIXTURE"
expect_exit serial 1
LIVE_EVENTS=(
  "$(tab "${CASE}test_regression_assertion_reproduces" product fail true reproduced BUG-0001 expected-red)"
  "$(tab "${CASE}test_regression_passing_body" product pass true automated BUG-0001 expected-red-passed)"
  "$(tab "${CASE}test_regression_runtime_skip" policy denied false n/a BUG-0001 regression-skipped)"
  "$(tab "${CASE}test_regression_unknown_provenance" product fail false n/a - assertion-failed)"
  "$(tab "${CASE}test_intermittent_unreproduced" product pass false n/a BUG-0003 intermittent-unreproduced)"
  "$(tab "${CASE}test_intermittent_reproduces" product fail true reproduced BUG-0003 expected-red)"
  "$(tab "${CASE}test_intermittent_below_bound" policy denied false n/a BUG-0003 repetition-invalid)"
  "$(tab "${CASE}test_plain_pass" product pass false n/a - passed)"
  "$(tab "${CASE}test_pytest_raises_not_raised" product fail false n/a - assertion-failed)"
  "$(tab "${CASE}test_uncaught_type_error" automation fail false n/a - uncaught-error)"
  "$(tab "${CASE}test_fixture_setup_failure" automation fail false n/a - fixture-failed)"
  "$(tab "${CASE}test_unreachable_in_setup" infrastructure fail false n/a - target-unreachable)"
  "$(tab "${CASE}test_cleanup_failure_after_passing_body" automation fail false n/a - cleanup-failed)"
  "$(tab "${CASE}test_cleanup_failure_after_assertion" product fail false n/a - assertion-failed)"
  "$(tab "${CASE}test_cleanup_failure_after_assertion.cleanup" automation fail false n/a - cleanup-failed)"
  "$(tab "${CASE}test_runtime_skip" skip skipped false n/a - test-skipped)"
  "$(tab "${CASE}test_declared_skip" skip skipped false n/a - test-skipped)"
  "$(tab "${CASE}test_declared_conditional" skip skipped false n/a - test-skipped)"
  "$(tab "${CASE}test_declared_expected_failure" policy denied false n/a - expected-failure-forbidden)"
  "$(tab "${CASE}test_unexpected_pass" policy denied false n/a - expected-failure-forbidden)"
  "$(tab "${CASE}test_strict_unexpected_pass" policy denied false n/a - expected-failure-forbidden)"
  "$(tab "${CASE}test_connection_refused" infrastructure fail false n/a - target-unreachable)"
  "$(tab "${CASE}test_read_timeout" automation fail false n/a - test-timeout)"
  "$(tab "${CASE}test_missing_prerequisite" infrastructure fail false n/a - prerequisite-missing)"
  "$(tab "${CASE}test_fault_restore_failure" infrastructure fail false n/a - fault-restore-failed)"
  "$(tab "${CASE}test_counterfactual_unmatched_request" automation fail false n/a - counterfactual-unmatched-request)"
  "$(tab "${CASE}test_playwright_api_failure" automation fail false n/a - playwright-api-failed)"
  "$(tab "${CASE}test_parametrized_ids-alpha-beta" product pass false n/a - passed)"
  "$(tab "${CASE}test_parametrized_ids-alpha-beta.2" product pass false n/a - passed)"
  "$(tab "${CASE}test_parametrized_ids-za-u017c-xf3-u0142-u0107" product pass false n/a - passed)"
  "$(tab "$LONG_ID" product pass false n/a - passed)"
  "$(tab "${CASE}test_za-_title" product pass false n/a - passed)"
)
expect_events "$WORK/serial.tsv" serial "${LIVE_EVENTS[@]}"
expect_status "ok ${#LIVE_EVENTS[@]}" serial
[ ! -e reports/argus-adapter-errors ] || [ -z "$(cat reports/argus-adapter-errors/*.txt 2>/dev/null)" ] || fail "a clean run listed adapter errors"

# The same events from two xdist workers; the controller aggregates the worker counters.
pytest_run xdist ARGUS_RUNNER_MODE=defect-evidence ARGUS_OUTCOME_FILE="$WORK/xdist.tsv" -- -n 2 -m contract_smoke "$FIXTURE"
expect_exit xdist 1
grep -Fq 'bringing up nodes' "$WORK/xdist.log" || fail "the xdist run did not distribute"
expect_events "$WORK/xdist.tsv" xdist "${LIVE_EVENTS[@]}"
expect_status "ok ${#LIVE_EVENTS[@]}" xdist

# (4) repeat pass and the strict candidate-regression mapping.
pytest_run repeat ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=repeat ARGUS_OUTCOME_FILE="$WORK/repeat.tsv" -- -m contract_smoke "$FIXTURE"
expect_exit repeat 1
[ "$(wc -l <"$WORK/repeat.tsv" | tr -d ' ')" = "${#LIVE_EVENTS[@]}" ] || fail "the repeat pass changed the event count"
[ -z "$(cut -f1 "$WORK/repeat.tsv" | grep -Ev '\.repeat(\.cleanup)?$' || true)" ] || fail "repeat-pass case ids lack the .repeat suffix"
for line in \
  "$(tab "${CASE}test_regression_assertion_reproduces.repeat" product fail true reproduced BUG-0001 expected-red-repeat)" \
  "$(tab "${CASE}test_regression_passing_body.repeat" automation fail false n/a BUG-0001 flaky-red)" \
  "$(tab "${CASE}test_intermittent_unreproduced.repeat" product pass false n/a BUG-0003 intermittent-unreproduced)" \
  "$(tab "${CASE}test_intermittent_reproduces.repeat" product fail true reproduced BUG-0003 expected-red-repeat)" \
  "$(tab "${CASE}test_cleanup_failure_after_assertion.repeat.cleanup" automation fail false n/a - cleanup-failed)" \
  "$(tab "${CASE}test_plain_pass.repeat" product pass false n/a - passed)"; do
  grep -Fxq "$line" "$WORK/repeat.tsv" || fail "repeat pass is missing: $line"
done
pytest_run candidate ARGUS_RUNNER_MODE=candidate-regression ARGUS_OUTCOME_FILE="$WORK/candidate.tsv" -- -m contract_smoke "$FIXTURE"
expect_exit candidate 1
for line in \
  "$(tab "${CASE}test_regression_assertion_reproduces" product fail false automated BUG-0001 regression-red)" \
  "$(tab "${CASE}test_regression_passing_body" product pass false fixed BUG-0001 regression-green)" \
  "$(tab "${CASE}test_regression_runtime_skip" policy denied false n/a BUG-0001 regression-skipped)" \
  "$(tab "${CASE}test_intermittent_unreproduced" product pass false fixed BUG-0003 regression-green)" \
  "$(tab "${CASE}test_intermittent_below_bound" policy denied false n/a BUG-0003 repetition-invalid)" \
  "$(tab "${CASE}test_regression_unknown_provenance" product fail false n/a - assertion-failed)"; do
  grep -Fxq "$line" "$WORK/candidate.tsv" || fail "candidate-regression is missing: $line"
done
if cut -f4 "$WORK/candidate.tsv" | grep -Fxq true; then fail "candidate-regression claimed an expected outcome"; fi

# (5) Fail closed: an emission failure or an unsupported pass turns a green run red.
: >"$WORK/not-a-directory"
pytest_run emission ARGUS_RUNNER_MODE=defect-evidence ARGUS_OUTCOME_FILE="$WORK/not-a-directory/events.tsv" -- -m contract_smoke "$FIXTURE" -k test_plain_pass
expect_exit emission 1
expect_status "error 1" emission
[ "$(cat reports/argus-adapter-errors/*.txt | cut -f1-2)" = "$(tab "${CASE}test_plain_pass" passed)" ] || fail "the emission failure was not listed"
pytest_run unsupported-pass ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=not-a-pass ARGUS_OUTCOME_FILE="$WORK/unsupported.tsv" -- -m contract_smoke "$FIXTURE" -k test_plain_pass
expect_exit unsupported-pass 1
expect_status "error 1" unsupported-pass
[ ! -e "$WORK/unsupported.tsv" ] || fail "an unsupported evidence pass still emitted events"
[ "$(cat reports/argus-adapter-errors/*.txt | cut -f2)" = unsupported-evidence-pass ] || fail "the controller did not reset the previous run's error list"

# (6) An interrupted test (pytest.exit mid-test) is infrastructure test-interrupted.
cat >tests/contract/test_interrupt_fixture.py <<'PY'
import pytest

pytestmark = pytest.mark.contract_smoke


@pytest.mark.regression
@pytest.mark.bug("ATA-001")
def test_operator_stop():
    pytest.exit("operator stop", returncode=3)
PY
pytest_run interrupted ARGUS_RUNNER_MODE=defect-evidence ARGUS_OUTCOME_FILE="$WORK/interrupted.tsv" -- tests/contract/test_interrupt_fixture.py
expect_exit interrupted 3
expect_events "$WORK/interrupted.tsv" interrupted "$(tab tests.contract.test_interrupt_fixture.py::test_operator_stop infrastructure fail false n/a BUG-0001 test-interrupted)"
expect_status "ok 1" interrupted
rm -f tests/contract/test_interrupt_fixture.py

# (7) Inert without a valid ARGUS_RUNNER_MODE: no events, no status, no inventory.
rm -rf reports/argus-adapter-status.txt reports/argus-adapter-errors "$INVENTORY" "$EXPECTED_BUGS" "$PLAN"
pytest_run inert ARGUS_OUTCOME_FILE="$WORK/inert.tsv" -- -m contract_smoke "$FIXTURE"
expect_exit inert 1
pytest_run inert-invalid-mode ARGUS_RUNNER_MODE=not-a-mode ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/inert.tsv" -- --collect-only
expect_exit inert-invalid-mode 0
for artifact in "$WORK/inert.tsv" "$STATUS" reports/argus-adapter-errors "$INVENTORY" "$EXPECTED_BUGS" "$PLAN"; do
  [ ! -e "$artifact" ] || fail "the inert adapter wrote $artifact"
done

# (8) Contract oracle self-tests: a baseline run with the plugin active where every case is a product pass.
ORACLE_TEST=tests/contract/test_oracles_contract_selftest.py
ORACLE_CASE='tests.contract.test_oracles_contract_selftest.py::'
cmp -s "$ROOT/argus/framework-template/tests/contract/fixtures/openapi.selftest.json" tests/contract/fixtures/openapi.selftest.json \
  || fail "the Python oracle self-test OpenAPI fixture drifted from the TypeScript fixture"
pytest_run oracles-list -- --collect-only -m contract_smoke "$ORACLE_TEST"
expect_exit oracles-list 0
oracle_cases="$(grep -c '::' "$WORK/oracles-list.log" || true)"
[ "$oracle_cases" -gt 0 ] || fail "the oracle self-tests were not collected"
pytest_run oracles ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$WORK/oracles.tsv" -- -m contract_smoke "$ORACLE_TEST"
expect_exit oracles 0
[ -f "$WORK/oracles.tsv" ] || fail "the oracle self-tests emitted no events"
[ "$(wc -l <"$WORK/oracles.tsv" | tr -d ' ')" = "$oracle_cases" ] || fail "expected one event per oracle self-test ($oracle_cases)"
awk -F'\t' -v prefix="$ORACLE_CASE" \
  'NF != 7 || index($1, prefix) != 1 || $2 != "product" || $3 != "pass" || $4 != "false" || $5 != "n/a" || $6 != "-" || $7 != "passed" { print "not an oracle product pass: " $0; bad = 1 } END { exit bad }' \
  "$WORK/oracles.tsv" >&2 || fail "an oracle self-test event is not a product pass"
[ -z "$(cut -f1 "$WORK/oracles.tsv" | sort | uniq -d)" ] || fail "oracle self-test case ids are not unique"
if grep -Eq '127[.]0[.]0[.]1|argus-never-print-me|hunter2' "$WORK/oracles.tsv"; then fail "an oracle self-test event carried test details"; fi
expect_status "ok $oracle_cases" oracles

# (8b) Data oracle self-tests: invalid partitions, pagination conservation, boundary and exact
# sums, identity vectors with credential consistency, and the i18n round trip. Each passes on
# a correct in-memory or 127.0.0.1 stub implementation and fails on a faulty one (a duplicate
# page, total drift, penny drift, byte truncation, one-sided trimming), so a healthy run is
# `product pass` for every case.
DATA_ORACLE_TEST=tests/contract/test_oracles_data_selftest.py
DATA_ORACLE_CASE='tests.contract.test_oracles_data_selftest.py::'
pytest_run oracles-data-list -- --collect-only -m contract_smoke "$DATA_ORACLE_TEST"
expect_exit oracles-data-list 0
data_oracle_cases="$(grep -c '::' "$WORK/oracles-data-list.log" || true)"
[ "$data_oracle_cases" -gt 0 ] || fail "the data oracle self-tests were not collected"
pytest_run oracles-data ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$WORK/oracles-data.tsv" -- -m contract_smoke "$DATA_ORACLE_TEST"
expect_exit oracles-data 0
[ -f "$WORK/oracles-data.tsv" ] || fail "the data oracle self-tests emitted no events"
[ "$(wc -l <"$WORK/oracles-data.tsv" | tr -d ' ')" = "$data_oracle_cases" ] || fail "expected one event per data oracle self-test ($data_oracle_cases)"
awk -F'\t' -v prefix="$DATA_ORACLE_CASE" \
  'NF != 7 || index($1, prefix) != 1 || $2 != "product" || $3 != "pass" || $4 != "false" || $5 != "n/a" || $6 != "-" || $7 != "passed" { print "not a data oracle product pass: " $0; bad = 1 } END { exit bad }' \
  "$WORK/oracles-data.tsv" >&2 || fail "a data oracle self-test event is not a product pass"
[ -z "$(cut -f1 "$WORK/oracles-data.tsv" | sort | uniq -d)" ] || fail "data oracle self-test case ids are not unique"
if grep -Eq '127[.]0[.]0[.]1|Qa7' "$WORK/oracles-data.tsv"; then fail "a data oracle self-test event carried test details"; fi
expect_status "ok $data_oracle_cases" oracles-data

# (8c) Behaviour oracle self-tests: soft-delete sweep, double submit, concurrent race, layout
# bounds, and growth scaling. Each passes on a correct 127.0.0.1 stub or pure input and fails on
# a faulty one (a list that still serves a deleted id, two orders from one double submit, an
# overbooked last seat, an occluded element, an N+1 fan-out, an over-fetching read). No browser
# starts: visual_bounds runs against a recording stand-in for a Locator. A healthy run is
# `product pass` for every case.
BEHAVIOR_ORACLE_TEST=tests/contract/test_oracles_behavior_selftest.py
BEHAVIOR_ORACLE_CASE='tests.contract.test_oracles_behavior_selftest.py::'
pytest_run oracles-behavior-list -- --collect-only -m contract_smoke "$BEHAVIOR_ORACLE_TEST"
expect_exit oracles-behavior-list 0
behavior_oracle_cases="$(grep -c '::' "$WORK/oracles-behavior-list.log" || true)"
[ "$behavior_oracle_cases" -gt 0 ] || fail "the behaviour oracle self-tests were not collected"
pytest_run oracles-behavior ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$WORK/oracles-behavior.tsv" -- -m contract_smoke "$BEHAVIOR_ORACLE_TEST"
expect_exit oracles-behavior 0
[ -f "$WORK/oracles-behavior.tsv" ] || fail "the behaviour oracle self-tests emitted no events"
[ "$(wc -l <"$WORK/oracles-behavior.tsv" | tr -d ' ')" = "$behavior_oracle_cases" ] || fail "expected one event per behaviour oracle self-test ($behavior_oracle_cases)"
awk -F'\t' -v prefix="$BEHAVIOR_ORACLE_CASE" \
  'NF != 7 || index($1, prefix) != 1 || $2 != "product" || $3 != "pass" || $4 != "false" || $5 != "n/a" || $6 != "-" || $7 != "passed" { print "not a behaviour oracle product pass: " $0; bad = 1 } END { exit bad }' \
  "$WORK/oracles-behavior.tsv" >&2 || fail "a behaviour oracle self-test event is not a product pass"
[ -z "$(cut -f1 "$WORK/oracles-behavior.tsv" | sort | uniq -d)" ] || fail "behaviour oracle self-test case ids are not unique"
if grep -Eq '127[.]0[.]0[.]1|argus-correct-password|ECONNREFUSED' "$WORK/oracles-behavior.tsv"; then fail "a behaviour oracle self-test event carried test details"; fi
expect_status "ok $behavior_oracle_cases" oracles-behavior

# (9) Counterfactual evidence (SD-6, SD-10). Each cf pass serves solution/counterfactual/BUG-0001.json
# from the session's 127.0.0.1 stub. API_URL names a closed port, so a request that escaped
# the stub would surface as target-unreachable instead of reaching anything.
CF_TEST=tests/contract/test_counterfactual_fixture.py
CF_ID='tests.contract.test_counterfactual_fixture.py::test_widget_read_returns_the_specified_widget'
CF_FIXTURE=solution/counterfactual/BUG-0001.json
CF_ENV=(ARGUS_RUNNER_MODE=defect-evidence "OPENAPI_PATH=$APP/tests/contract/fixtures/counterfactual-openapi.json" API_URL=http://127.0.0.1:9)
cmp -s "$ROOT/scripts/fixtures/argus-runtime/typescript/counterfactual/BUG-0001.json" "$FIXTURES/counterfactual/BUG-0001.json" \
  || fail "the Python counterfactual fixture drifted from the TypeScript fixture"
cp "$FIXTURES/test_counterfactual_fixture.py" "$CF_TEST"
cp "$FIXTURES/counterfactual-openapi.json" tests/contract/fixtures/counterfactual-openapi.json
mkdir -p solution/counterfactual
cp "$FIXTURES/counterfactual/BUG-0001.json" "$WORK/cf-fixture.json"
cp "$WORK/cf-fixture.json" "$CF_FIXTURE"

# cf_inventory <label> [VAR=value ...] / cf_pass <label> <pass> [VAR=value ...] [-- <pytest args...>]
cf_inventory() {
  local label="$1"
  shift
  rm -f "$WORK/$label.tsv"
  pytest_run "$label" "${CF_ENV[@]}" ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/$label.tsv" "$@" -- --collect-only
}
cf_pass() {
  local label="$1" pass="$2" vars=()
  shift 2
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ "$#" -eq 0 ] || shift
  rm -f "$WORK/$label.tsv"
  pytest_run "$label" "${CF_ENV[@]}" "ARGUS_EVIDENCE_PASS=$pass" ARGUS_OUTCOME_FILE="$WORK/$label.tsv" ${vars[@]+"${vars[@]}"} -- "${@:-$CF_TEST}"
}
# expect_plan <label> <status> <tamper-ids> <reason>: BUG-0001's row, and BUG-0003 without a fixture.
expect_plan() {
  local want
  want="$(printf 'BUG-0001\t%s\t%s\t%s\nBUG-0003\tmissing\t-\t-' "$2" "$3" "$4")"
  [ "$(cat "$PLAN" 2>/dev/null)" = "$want" ] || { cat "$PLAN" >&2 2>/dev/null; tail -20 "$WORK/$1.log" >&2; fail "$1: counterfactual plan row is not 'BUG-0001 $2 $3 $4'"; }
}
# expect_only_event <label> <field...>: the pass emitted exactly this one event.
expect_only_event() {
  local label="$1"
  shift
  expect_events "$WORK/$label.tsv" "$label" "$(tab "$@")"
  expect_status "ok 1" "$label"
}
expect_no_events() {
  expect_exit "$1" 0
  [ ! -s "$WORK/$1.tsv" ] || { cat "$WORK/$1.tsv" >&2; fail "$1: a test without a counterfactual variant emitted an event"; }
  expect_status "ok 0" "$1"
}

cf_inventory cf-inventory
expect_exit cf-inventory 0
expect_plan cf-inventory fixture observed-defect,missing-field -
expect_row "$CF_ID" "$(tab contract-smoke true false BUG-0001 - -)"
[ ! -s "$WORK/cf-inventory.tsv" ] || fail "the counterfactual inventory pass emitted events"
expect_status "ok 0" cf-inventory

# Outside a counterfactual pass the fixtures are inert: the regression reaches API_URL.
rm -f "$WORK/cf-live.tsv"
pytest_run cf-live "${CF_ENV[@]}" ARGUS_OUTCOME_FILE="$WORK/cf-live.tsv" -- "$CF_TEST"
expect_exit cf-live 1
expect_events "$WORK/cf-live.tsv" cf-live \
  "$(tab "$CF_ID" infrastructure fail false n/a BUG-0001 target-unreachable)" \
  "$(tab tests.contract.test_counterfactual_fixture.py::test_a_test_without_a_bound_bug_has_no_counterfactual_variant product pass false n/a - passed)"

cf_pass cf-correct cf-correct
expect_exit cf-correct 0
expect_only_event cf-correct "$CF_ID.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
cf_pass cf-tamper-1 cf-tamper-1
expect_exit cf-tamper-1 1
expect_only_event cf-tamper-1 "$CF_ID.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
cf_pass cf-tamper-2 cf-tamper-2
expect_only_event cf-tamper-2 "$CF_ID.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red
cf_pass cf-tamper-3 cf-tamper-3
expect_no_events cf-tamper-3

# Each xdist worker runs its own stub; the events are the same.
cf_pass cf-xdist cf-tamper-2 -- -n 2 "$CF_TEST"
grep -Fq 'bringing up nodes' "$WORK/cf-xdist.log" || fail "the counterfactual xdist run did not distribute"
expect_only_event cf-xdist "$CF_ID.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red

# A weakened copy that asserts only the status lets the missing-field tamper survive.
cp "$CF_TEST" "$WORK/test_counterfactual_fixture.py"
grep -v 'argus-smoke: strict body' "$WORK/test_counterfactual_fixture.py" >"$CF_TEST"
cf_pass cf-weakened cf-tamper-2
cp "$WORK/test_counterfactual_fixture.py" "$CF_TEST"
expect_only_event cf-weakened "$CF_ID.cf-missing-field" automation fail false n/a BUG-0001 counterfactual-tamper-survived

# An undeclared request fails the pass, and outranks the tamper RED it may have caused.
cf_pass cf-unmatched cf-correct ARGUS_SMOKE_EXTRA_REQUEST=1
expect_only_event cf-unmatched "$CF_ID.cf-correct" automation fail false n/a BUG-0001 counterfactual-unmatched-request
cf_pass cf-unmatched-tamper cf-tamper-1 ARGUS_SMOKE_EXTRA_REQUEST=1
expect_only_event cf-unmatched-tamper "$CF_ID.cf-observed-defect" automation fail false n/a BUG-0001 counterfactual-unmatched-request

# A correct response the regression rejects is counterfactual-correct-red.
jq 'del(.contract) | .exchanges[0].response.status = 404' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_pass cf-correct-red cf-correct
expect_only_event cf-correct-red "$CF_ID.cf-correct" automation fail false n/a BUG-0001 counterfactual-correct-red
cp "$WORK/cf-fixture.json" "$CF_FIXTURE"

# A test cannot claim an exemption its bug's fixture does not declare: that is an ordinary skip.
cat >tests/contract/test_claimed_exemption_fixture.py <<'PY'
import pytest

pytestmark = pytest.mark.contract_smoke


@pytest.mark.regression
@pytest.mark.bug("ATA-001")
def test_claims_an_exemption():
    pytest.skip("argus-counterfactual-exempt:front-end-logic")
PY
cf_pass cf-claimed-exemption cf-correct -- tests/contract/test_claimed_exemption_fixture.py
rm -f tests/contract/test_claimed_exemption_fixture.py
expect_only_event cf-claimed-exemption tests.contract.test_claimed_exemption_fixture.py::test_claims_an_exemption.cf-correct policy denied false n/a BUG-0001 regression-skipped

# An exemption records one event in cf-correct and nothing in a tamper pass.
jq '{"$schema": ."$schema", schemaVersion, bugId, exemption: {reason: "front-end-logic", justification: "The defect lives in client-side rendering."}}' \
  "$WORK/cf-fixture.json" >"$WORK/cf-exempt.json"
cp "$WORK/cf-exempt.json" "$CF_FIXTURE"
cf_inventory cf-exempt-inventory
expect_plan cf-exempt-inventory exempt - front-end-logic
cf_pass cf-exempt cf-correct
expect_only_event cf-exempt "$CF_ID.cf" policy pass false n/a BUG-0001 counterfactual-exempt.front-end-logic
cf_pass cf-exempt-tamper cf-tamper-1
expect_no_events cf-exempt-tamper

# Invalid fixtures: the plan names the reason, and the regression has no variant to run.
jq '.tampers |= map(select(.id != "observed-defect"))' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-no-observed-defect
expect_plan cf-no-observed-defect invalid - missing-observed-defect
cf_pass cf-invalid-correct cf-correct
expect_no_events cf-invalid-correct
jq '.exchanges[0].response.body.color = "red"' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-contract-violation
expect_plan cf-contract-violation invalid - correct-violates-contract
cf_pass cf-contract-violation-correct cf-correct
expect_no_events cf-contract-violation-correct
rm -f "$CF_FIXTURE"
cf_inventory cf-missing-inventory
expect_plan cf-missing-inventory missing - -
cf_pass cf-missing-correct cf-correct
expect_no_events cf-missing-correct
jq '.tampers[1].id = "correct"' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-reserved-tamper
expect_plan cf-reserved-tamper invalid - schema-invalid
jq '.bugId = "BUG-0002"' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-foreign-bug
expect_plan cf-foreign-bug invalid - schema-invalid
jq '.schemaVersion = true' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-boolean-version
expect_plan cf-boolean-version invalid - schema-invalid

# The example every scaffold ships is never read as a fixture (the first inventory above
# listed BUG-0001 as missing beside it), but it must stay a valid one. Its contract names an
# operation this smoke's OpenAPI document does not define, so only the shape is checked.
CF_EXAMPLE=solution/counterfactual/BUG-0000.example.json
[ -f "$CF_EXAMPLE" ] || fail "the scaffold omitted solution/counterfactual/BUG-0000.example.json"
jq '.bugId = "BUG-0001" | del(.contract)' "$CF_EXAMPLE" >"$CF_FIXTURE"
cf_inventory cf-shipped-example
expect_plan cf-shipped-example fixture observed-defect,wrong-rejection-status -

# A declared contract without an OpenAPI document is a missing prerequisite: the plan is
# never published with a guessed status, and neither is the rest of the inventory.
cp "$WORK/cf-fixture.json" "$CF_FIXTURE"
cf_inventory cf-no-openapi "OPENAPI_PATH=$WORK/absent-openapi.json"
expect_exit cf-no-openapi 1
[ ! -e "$PLAN" ] && [ ! -e "$INVENTORY" ] && [ ! -e "$EXPECTED_BUGS" ] || fail "an unverifiable contract published inventory artifacts"
expect_status "error 1" cf-no-openapi
[ "$(cat reports/argus-adapter-errors/*.txt | cut -f2)" = counterfactual-plan-failed ] || fail "the unverifiable contract was not listed"

# Counterfactual passes belong to defect-evidence, and only with a well-formed pass name; an
# unsupported pass emits nothing, not even an exemption.
for activation in "candidate-regression cf-correct cf-fixture" "defect-evidence cf-tamper-0 cf-fixture" "candidate-regression cf-correct cf-exempt"; do
  read -r cf_mode cf_pass_name cf_source <<<"$activation"
  cp "$WORK/$cf_source.json" "$CF_FIXTURE"
  rm -f "$WORK/cf-unsupported.tsv"
  pytest_run cf-unsupported ARGUS_RUNNER_MODE="$cf_mode" ARGUS_EVIDENCE_PASS="$cf_pass_name" "OPENAPI_PATH=$APP/tests/contract/fixtures/counterfactual-openapi.json" \
    API_URL=http://127.0.0.1:9 ARGUS_OUTCOME_FILE="$WORK/cf-unsupported.tsv" -- "$CF_TEST"
  expect_exit cf-unsupported 1
  [ ! -e "$WORK/cf-unsupported.tsv" ] || fail "an unsupported counterfactual pass ($activation) emitted events"
  expect_status "error 1" "unsupported counterfactual pass ($activation)"
done

# ui lane: the route handler answers browser requests from the stub, and 501 when unmatched.
PYTHONPATH=src .venv/bin/python - <<'PY' || fail "the ui-lane counterfactual route handler misbehaved"
import json
from types import SimpleNamespace

from qa.argus.counterfactual import fulfill_from_stub
from qa.argus.stub_server import StubServer


class Route:
    def __init__(self, method, url):
        self.request = SimpleNamespace(method=method, url=url)
        self.fulfilled = None

    def fulfill(self, **kwargs):
        self.fulfilled = kwargs


with StubServer.start() as stub:
    stub.load([{"id": "get-widget", "request": {"method": "GET", "path": "/widgets/1", "query": {"view": "full"}},
                "response": {"status": 200, "body": {"id": 1, "name": "widget"}}}])
    served = Route("GET", "http://localhost:3001/widgets/1?view=full")
    fulfill_from_stub(served, stub)
    assert served.fulfilled["status"] == 200, served.fulfilled
    assert served.fulfilled["headers"]["content-type"] == "application/json", served.fulfilled
    assert json.loads(served.fulfilled["body"]) == {"id": 1, "name": "widget"}, served.fulfilled
    unmatched = Route("POST", "http://localhost:3001/widgets")
    fulfill_from_stub(unmatched, stub)
    assert unmatched.fulfilled["status"] == 501, unmatched.fulfilled
    assert json.loads(unmatched.fulfilled["body"]) == {"argusStub": "unmatched"}, unmatched.fulfilled
    assert [(r["method"], r["path"]) for r in stub.unmatched()] == [("POST", "/widgets")], stub.unmatched()
PY

# (10) Runner-kit fixtures through the adapter. created_resources attempts every DELETE and turns
# a refused one into cleanup-failed; the clients api_as and anon_client hand out outlive its
# teardown whatever the parameter order; fault_injector reports an unverifiable restore as
# fault-restore-failed. Only a loopback stub is contacted.
cat >tests/contract/test_runner_kit_fixture.py <<'PY'
import httpx
import pytest

from qa.argus.fault_injector import Fault
from qa.argus.stub_server import StubServer

pytestmark = pytest.mark.contract_smoke


@pytest.fixture
def stub():
    with StubServer.start() as server:
        server.load([
            {"id": "deleted", "request": {"method": "DELETE", "path": "/items/1"}, "response": {"status": 204}},
            {"id": "already-gone", "request": {"method": "DELETE", "path": "/items/2"}, "response": {"status": 404}},
            {"id": "refused", "request": {"method": "DELETE", "path": "/items/3"}, "response": {"status": 409, "body": {"detail": "argus-never-print-me"}}},
        ])
        yield server


@pytest.fixture
def items(stub):
    with httpx.Client(base_url=stub.url, timeout=10.0, trust_env=False) as client:
        yield client


def test_deleted_and_already_gone_resources_pass(items, created_resources):
    created_resources.extend([(items, "/items/1"), (items, "/items/2")])


def test_a_refused_delete_fails_a_passing_test_as_cleanup(items, created_resources):
    created_resources.extend([(items, "/items/1"), (items, "/items/3"), (items, "/items/2")])


def test_the_harness_clients_outlive_the_cleanup(stub, created_resources, anon_client):
    created_resources.append((anon_client, f"{stub.url}/items/1"))


def test_an_unverifiable_restore_is_fault_restore_failed(fault_injector):
    def unverifiable():
        raise AssertionError("the fault is still visible")

    fault = Fault(name="api-unavailable", scope="client", inject=lambda: None, restore=lambda: None, verify_restored=unverifiable)
    fault_injector.run(fault, lambda: None)
PY
RK_CASE='tests.contract.test_runner_kit_fixture.py::'
pytest_run runner-kit ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$WORK/runner-kit.tsv" -- tests/contract/test_runner_kit_fixture.py
rm -f tests/contract/test_runner_kit_fixture.py
expect_exit runner-kit 1
expect_events "$WORK/runner-kit.tsv" runner-kit \
  "$(tab "${RK_CASE}test_deleted_and_already_gone_resources_pass" product pass false n/a - passed)" \
  "$(tab "${RK_CASE}test_a_refused_delete_fails_a_passing_test_as_cleanup" automation fail false n/a - cleanup-failed)" \
  "$(tab "${RK_CASE}test_the_harness_clients_outlive_the_cleanup" product pass false n/a - passed)" \
  "$(tab "${RK_CASE}test_an_unverifiable_restore_is_fault_restore_failed" infrastructure fail false n/a - fault-restore-failed)"
expect_status "ok 4" runner-kit
grep -Fq 'ArgusCleanupError: cleanup failed for 1 resource(s)' "$WORK/runner-kit.log" || fail "the cleanup failure does not report its count"
if grep -Fq 'argus-never-print-me' "$WORK/runner-kit.log"; then fail "the cleanup failure printed a response body"; fi

# (11) End-to-end runner against a local faulty target. A scaffold from `template select` +
# `template scaffold` (non-default layout) runs ./run-tests.sh end to end: runner-lib.sh, the
# lane plan, readiness, the environment baseline, the compile gate, the inventory, the
# quarantine, inventory, and evidence gates, and every evidence pass.
# scripts/fixtures/argus-runtime/faulty-target.mjs answers GET /widgets/1 with 500 (buggy) or
# the specified widget (fixed).
E="$WORK/e2e"
E2E="$FIXTURES/e2e"
E2E_TESTS="$E/quality/python-tests"
E2E_ID='quality.python-tests.api.test_widget_regression.py::test_widget_read_returns_the_specified_widget'
E2E_HEALTH_ID='quality.python-tests.api.test_widget_regression.py::test_health_endpoint_reports_ok'
E2E_EV="$E/reports/outcomes.raw.tsv"
for fixture in BUG-0001.json test-lanes.tsv environment.tsv; do
  cmp -s "$ROOT/scripts/fixtures/argus-runtime/java/e2e/$fixture" "$E2E/$fixture" || fail "the Python e2e $fixture drifted from the Java fixture"
done
mkdir -p "$WORK/e2e-target"
"$CLI" template select --target "$WORK/e2e-target" --runtime python --package-manager pip \
  --test-root quality/python-tests --harness-root quality/python-support --output "$WORK/e2e-selection.json" >/dev/null
"$CLI" template scaffold --selection "$WORK/e2e-selection.json" --destination "$E" >/dev/null
# The same requirements.txt: the scaffold reuses the installed venv instead of a second install.
mv "$APP/.venv" "$E/.venv"
for lane in api ui perf security db resilience; do rm -f "$E2E_TESTS/$lane/"test_*.py; done
[ -z "$(find "$E2E_TESTS" -name 'test_*.py' ! -path '*/contract/*' -print -quit)" ] || fail "e2e: an ADAPT-ME example test survived"
cp "$E2E/test_widget_regression.py" "$E2E_TESTS/api/test_widget_regression.py"
cp "$E2E/bug-ledger.json" "$E/solution/bug-ledger.json"
cp "$E2E/BUG-0001.json" "$E/solution/counterfactual/BUG-0001.json"
cp "$E2E/test-lanes.tsv" "$E2E/environment.tsv" "$E/solution/"
# The same read-only verify as the TypeScript end-to-end fixture: the target holds no state.
cp "$ROOT/scripts/fixtures/argus-runtime/typescript/e2e/verify-baseline.sh" "$E/scripts/verify-baseline.sh"

# expect_event <file> <field...>: the file holds exactly this event line.
expect_event() {
  local file="$1" line
  shift
  line="$(tab "$@")"
  grep -Fxq -- "$line" "$file" 2>/dev/null || { cat "$file" >&2 2>/dev/null; fail "missing event: $line"; }
}

# start_target <buggy|fixed>: (re)starts the faulty target on an ephemeral 127.0.0.1 port.
start_target() {
  local port="" attempt
  stop_target || fail "the previous faulty target still listens after stop_target"
  : >"$WORK/target.log"
  FAULTY_MODE="$1" PORT=0 "$NODE_BIN" "$ROOT/scripts/fixtures/argus-runtime/faulty-target.mjs" >"$WORK/target.log" 2>&1 &
  TARGET_PID=$!
  for attempt in $(seq 1 100); do
    port="$(sed -n 's/^listening \([0-9][0-9]*\)$/\1/p' "$WORK/target.log")"
    [ -z "$port" ] || break
    sleep 0.1
  done
  [ -n "$port" ] || { cat "$WORK/target.log" >&2; fail "the faulty target did not start after $attempt checks"; }
  TARGET_PORT="$port" TARGET_URL="http://127.0.0.1:$port"
}

# e2e <log> <expected-exit> <mode> [VAR=value ...] [-- passthrough...]
e2e() {
  local log="$1" expected="$2" mode="$3" code
  local environment=() passthrough=()
  shift 3
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do environment+=("$1"); shift; done
  if [ "$#" -gt 0 ]; then shift; passthrough=(-- "$@"); fi
  set +e
  (cd "$E" && env "API_URL=$TARGET_URL" "ARGUS_READINESS_URLS=$TARGET_URL/health" PLAYWRIGHT_INSTALL=0 \
    ${environment[@]+"${environment[@]}"} ./run-tests.sh --mode "$mode" ${passthrough[@]+"${passthrough[@]}"}) >"$WORK/e2e-$log.log" 2>&1
  code=$?
  set -e
  if [ "$code" -ne "$expected" ]; then
    tail -60 "$WORK/e2e-$log.log" >&2
    cat "$E2E_EV" >&2 2>/dev/null || true
    fail "e2e $log exited $code instead of $expected"
  fi
  jq -e --arg mode "$mode" --argjson code "$expected" '.mode == $mode and .exitCode == $code' "$E/reports/argus-runner-result.json" >/dev/null ||
    fail "e2e $log: the result does not record mode $mode and exit $expected"
}
# pass_report <pass> <jq filter>: the pytest-json-report summary of one evidence pass.
pass_report() {
  jq -e ".summary | $2" "$E/reports/evidence/passes/$1/report.json" >/dev/null
}

start_target buggy
e2e defect-evidence 0 defect-evidence
expect_event "$E2E_EV" "$E2E_ID" product fail true reproduced BUG-0001 expected-red
expect_event "$E2E_EV" "$E2E_ID.repeat" product fail true reproduced BUG-0001 expected-red-repeat
expect_event "$E2E_EV" "$E2E_ID.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
expect_event "$E2E_EV" "$E2E_ID.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_event "$E2E_EV" "$E2E_ID.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_event "$E2E_EV" environment infrastructure pass false n/a - environment-baseline-verified
grep -Fq 'Compile gate' "$WORK/e2e-defect-evidence.log" || fail "e2e: the compile gate did not run"
# Each pass keeps its own native evidence: the RED passes and the green cf-correct pass.
for pass in live repeat cf-correct cf-tamper-1 cf-tamper-2; do
  [ -f "$E/reports/evidence/passes/$pass/html/index.html" ] && [ -f "$E/reports/evidence/passes/$pass/report.json" ] &&
    [ -f "$E/reports/evidence/passes/$pass/junit.xml" ] || fail "e2e: pass $pass kept no native evidence"
done
for pass in live repeat cf-tamper-1 cf-tamper-2; do
  pass_report "$pass" '.total == 1 and .failed == 1 and (.passed // 0) == 0' || fail "e2e: pass $pass evidence is not its own RED run"
done
pass_report cf-correct '.total == 1 and .passed == 1 and (.failed // 0) == 0' || fail "e2e: cf-correct evidence is not its own green run"

# A regression that checks only the status lets the missing-field tamper survive.
cp "$E2E_TESTS/api/test_widget_regression.py" "$WORK/test_widget_regression.py"
grep -v 'argus-smoke: strict body' "$WORK/test_widget_regression.py" >"$E2E_TESTS/api/test_widget_regression.py"
e2e weakened 11 defect-evidence
cp "$WORK/test_widget_regression.py" "$E2E_TESTS/api/test_widget_regression.py"
expect_event "$E2E_EV" "$E2E_ID.cf-missing-field" automation fail false n/a BUG-0001 counterfactual-tamper-survived

# A regression that does not compile stops the run before any test.
printf 'def broken(:\n' >"$E2E_TESTS/api/test_syntax_error.py"
e2e compile-error 11 baseline
rm -f "$E2E_TESTS/api/test_syntax_error.py"
expect_event "$E2E_EV" compile automation fail false n/a - python-compile-failed
[ ! -e "$E/reports/test-inventory.tsv" ] || fail "e2e: a compile failure still ran the inventory"

# baseline stays strict green while the known bug is RED: it never selects the regression.
e2e baseline 0 baseline
expect_event "$E2E_EV" "$E2E_HEALTH_ID" product pass false n/a - passed
expect_event "$E2E_EV" lane.api policy pass false n/a - lane-executed
if grep -Fq -- "$E2E_ID" "$E2E_EV"; then cat "$E2E_EV" >&2; fail "e2e: baseline selected the regression"; fi

start_target fixed
e2e candidate 0 candidate-regression
expect_event "$E2E_EV" "$E2E_ID" product pass false fixed BUG-0001 regression-green
if grep -Fq -- "$E2E_HEALTH_ID" "$E2E_EV"; then cat "$E2E_EV" >&2; fail "e2e: candidate-regression selected a non-regression test"; fi
e2e full 0 full-suite
jq -e '.deliveryGate == true' "$E/reports/argus-runner-result.json" >/dev/null || fail "e2e: full-suite is not the delivery gate"
expect_event "$E2E_EV" "$E2E_ID" product pass false fixed BUG-0001 regression-green
expect_event "$E2E_EV" "$E2E_HEALTH_ID" product pass false n/a - passed
expect_event "$E2E_EV" lane.api policy pass false n/a - lane-executed
for lane in ui perf security db resilience; do
  expect_event "$E2E_EV" "lane.$lane" policy pass false n/a - lane-disabled.residual.not-in-fixture
done
# The contract-smoke self-tests stay in the scaffold but belong to the contract smoke only.
if grep -Fq -- quality.python-tests.contract. "$E2E_EV"; then cat "$E2E_EV" >&2; fail "e2e: full-suite selected a contract-smoke test"; fi
e2e full-narrowed 13 full-suite -- -k x
expect_event "$E2E_EV" runner-selection policy denied false n/a - full-suite-narrowing-forbidden

# Lane and environment decisions are enforced before any test runs.
cp "$E/solution/test-lanes.tsv" "$WORK/test-lanes.tsv"
awk 'BEGIN { FS = OFS = "\t" } $1 == "ui" { $2 = "enabled"; $5 = "-" } { print }' "$WORK/test-lanes.tsv" >"$E/solution/test-lanes.tsv"
e2e ui-without-url 13 full-suite
expect_event "$E2E_EV" lane.ui policy denied false n/a - lane-prerequisite-missing
awk 'BEGIN { FS = OFS = "\t" } $1 == "perf" { $5 = "not-yet-planned" } { print }' "$WORK/test-lanes.tsv" >"$E/solution/test-lanes.tsv"
e2e undecided-lane 13 full-suite
expect_event "$E2E_EV" lane.perf policy denied false n/a - lane-decision-missing
cp "$WORK/test-lanes.tsv" "$E/solution/test-lanes.tsv"
cp "$E/scripts/verify-baseline.sh" "$WORK/verify-baseline.sh"
printf '#!/usr/bin/env bash\nexit 1\n' >"$E/scripts/verify-baseline.sh"
e2e not-at-baseline 12 full-suite
cp "$WORK/verify-baseline.sh" "$E/scripts/verify-baseline.sh"
expect_event "$E2E_EV" environment infrastructure fail false n/a - environment-not-at-baseline
stop_target || fail "the faulty target still listens after stop_target"

printf 'PASS  Argus Python runtime adapter: collect-only inventory, ledger join, SD-5/SD-6 events, xdist parity, repetition, fail-closed status, inert default, contract, data, and behaviour oracle self-tests, SD-10 counterfactual plan, cf-correct/cf-tamper passes against the in-process stub, strict cleanup and fault-restore fixtures, and an end-to-end runner against a faulty target\n'
