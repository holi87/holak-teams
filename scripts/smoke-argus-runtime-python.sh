#!/usr/bin/env bash
# Python runtime adapter smoke (template contract v2, RUNNER-CONTRACT.md SD-1 to SD-7).
# In a clean-room copy of the Python template, the qa.argus_plugin pytest plugin must write
# the SD-3 inventory and SD-4 expected bugs from a collect-only pass, turn every SD-5/SD-6
# outcome into exactly the expected events (identically under pytest-xdist), fail closed on
# emission problems, and stay inert without ARGUS_RUNNER_MODE. No browser and no target.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-runtime/python"
PYTHON_BIN="${PYTHON:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The host environment must not activate or redirect the adapter behind the smoke's back.
unset ARGUS_RUNNER_MODE ARGUS_INVENTORY_ONLY ARGUS_EVIDENCE_PASS ARGUS_OUTCOME_FILE ARGUS_CONTRACT_SMOKE

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
tab() { local IFS=$'\t'; printf '%s\n' "$*"; }

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
awk -F'\t' -v id="${CASE}test_plain_pass" '$1 == id { exit !($8 ~ /^tests\/contract\/test_classification_fixture\.py:[0-9]+$/) }' "$INVENTORY" || fail "inventory source is not posix-path:line"
[ "$(cat "$EXPECTED_BUGS")" = "$(printf 'BUG-0001\nBUG-0003')" ] || fail "expected-bugs must list exactly the confirmed ids (needs-oracle and suspected excluded)"
[ ! -s "$WORK/inventory-events.tsv" ] || fail "the inventory pass emitted events for a valid ledger"
expect_status "ok 0" inventory
cp "$INVENTORY" "$WORK/inventory.reference.tsv"

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
done
jq '."$schema" = "argus/bug-ledger@1" | .schemaVersion = 1' "$FIXTURES/bug-ledger.json" >"$WORK/v1-ledger.json"
ledger_inventory ledger-v1 defect-evidence "$WORK/v1-ledger.json"
[ ! -s "$WORK/ledger-v1-events.tsv" ] || fail "a valid bug-ledger@1 was rejected"
[ "$(cat "$EXPECTED_BUGS")" = "$(printf 'BUG-0001\nBUG-0003')" ] || fail "bug-ledger@1 expected-bugs differ"
cmp -s "$INVENTORY" "$WORK/inventory.reference.tsv" || fail "bug-ledger@1 and @2 produced different inventories"
cp "$FIXTURES/bug-ledger.json" solution/bug-ledger.json

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
rm -rf reports/argus-adapter-status.txt reports/argus-adapter-errors "$INVENTORY" "$EXPECTED_BUGS"
pytest_run inert ARGUS_OUTCOME_FILE="$WORK/inert.tsv" -- -m contract_smoke "$FIXTURE"
expect_exit inert 1
pytest_run inert-invalid-mode ARGUS_RUNNER_MODE=not-a-mode ARGUS_INVENTORY_ONLY=1 ARGUS_OUTCOME_FILE="$WORK/inert.tsv" -- --collect-only
expect_exit inert-invalid-mode 0
for artifact in "$WORK/inert.tsv" "$STATUS" reports/argus-adapter-errors "$INVENTORY" "$EXPECTED_BUGS"; do
  [ ! -e "$artifact" ] || fail "the inert adapter wrote $artifact"
done

printf 'PASS  Argus Python runtime adapter: collect-only inventory, ledger join, SD-5/SD-6 events, xdist parity, repetition, fail-closed status, and inert default\n'
