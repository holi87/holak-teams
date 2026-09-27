#!/usr/bin/env bash
# Clean-room validation of the Java runtime adapter: the JUnit Platform outcome listener,
# the Launcher-discovery inventory, and the SD-4 ledger join, run against a
# target-independent fixture in a freshly copied Java template; then the contract, data and
# behaviour oracle self-tests and the exact-oracle anchors of the ADAPT-ME examples in a
# second copy, the counterfactual evidence passes (SD-10) in a third,
# and an end-to-end run of run-tests.sh (runner-lib.sh, lane plan, environment baseline,
# evidence passes) in a scaffold against scripts/fixtures/argus-runtime/faulty-target.mjs.
# Only that local 127.0.0.1 target is ever contacted; no browser is needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-runtime/java"
WORK="$(mktemp -d)"
TARGET_PID="" TARGET_URL=""

# stop_target: stops the end-to-end target started by start_target, if any.
stop_target() {
  if [ -n "$TARGET_PID" ]; then
    kill "$TARGET_PID" 2>/dev/null || true
    wait "$TARGET_PID" 2>/dev/null || true
    TARGET_PID=""
  fi
}
trap 'stop_target; rm -rf "$WORK"' EXIT
# The adapter reads these; a caller's environment must not leak into the clean room. The
# same holds for the runner library's inputs in the end-to-end section.
unset ARGUS_RUNNER_MODE ARGUS_EVIDENCE_PASS ARGUS_INVENTORY_ONLY ARGUS_OUTCOME_FILE ARGUS_CONTRACT_SMOKE \
  ARGUS_API_ROUTE_PATTERN OPENAPI_PATH ARGUS_ENGAGEMENT_MANIFEST ARGUS_ENGAGEMENT_LANE ARGUS_ENVIRONMENT_RESET \
  ARGUS_FAULT_INJECTION ARGUS_FAULT_INJECTION_GRANT ARGUS_READINESS_URLS ARGUS_TEST_ROOT ARGUS_AUTH_DIRECTORY ARGUS_RESET_TIMEOUT_SECONDS \
  ARGUS_VERIFY_TIMEOUT_SECONDS UI_URL PERF_BUDGET_MS SECURITY_ENABLED DB_URL

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
for tool in java mvn jq node; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done

APP="$WORK/java"
C=qa.contract.ClassificationFixtureTest
INVENTORY="$APP/reports/test-inventory.tsv"
EXPECTED_BUGS="$APP/reports/expected-bugs.txt"
PLAN="$APP/reports/counterfactual-plan.tsv"
STATUS="$APP/reports/argus-adapter-status.txt"
MVN=(mvn -B -ntp)

in_app() { (cd "$APP" && "$@"); }
in_dir() { local dir="$1"; shift; (cd "$dir" && "$@"); }
run_logged() {
  local name="$1"
  shift
  if ! "$@" >"$WORK/$name.log" 2>&1; then
    tail -80 "$WORK/$name.log" >&2
    fail "$name failed"
  fi
}
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi
}
tsv() { local line; line="$(printf '%s\t' "$@")"; printf '%s' "${line%$'\t'}"; }
expect_row() {
  local id="$1"
  shift
  grep -Fxq -- "$(tsv "$id" "$@")" "$INVENTORY" || fail "inventory row for $id is $(awk -F'\t' -v id="$id" '$1 == id' "$INVENTORY" | tr '\t' ' ')"
}
expect_event() {
  local file="$1"
  shift
  grep -Fxq -- "$(tsv "$@")" "$file" || fail "missing event in $(basename "$file"): $*"
}
expect_lines() {
  local file="$1" count="$2"
  [ "$(wc -l <"$file" | tr -d ' ')" -eq "$count" ] || { cat "$file" >&2; fail "$(basename "$file") holds $(wc -l <"$file" | tr -d ' ') lines, expected $count"; }
}

# The fixture replaces the stock contract-smoke classes: the legacy case writes its own event
# by hand, and the oracle self-tests run in their own copy in section (4).
"$CLI" copy-template java "$APP" >/dev/null
grep -Fxq 'qa.support.argus.ArgusOutcomeListener' "$APP/src/test/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener" \
  || fail "outcome listener is not registered with the JUnit Platform launcher"
grep -Fxq 'qa.support.SummaryListener' "$APP/src/test/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener" \
  || fail "summary listener registration was dropped"
rm "$APP"/src/test/java/qa/contract/*.java
cp "$FIXTURES/ClassificationFixtureTest.java" "$APP/src/test/java/qa/contract/ClassificationFixtureTest.java"
cp "$FIXTURES/bug-ledger.json" "$APP/solution/bug-ledger.json"
run_logged test-compile in_app "${MVN[@]}" -q -DskipTests test-compile

# (1) Inventory through the exact command the runner uses: full collection, one row per test
# and per template/factory method, the ledger join, and expected bugs = confirmed only.
run_logged inventory in_app env ARGUS_RUNNER_MODE=defect-evidence ARGUS_OUTCOME_FILE="$WORK/inventory-events.tsv" \
  "${MVN[@]}" -q org.codehaus.mojo:exec-maven-plugin:3.1.1:java -Dexec.mainClass=qa.support.argus.ArgusInventory -Dexec.classpathScope=test
test -s "$INVENTORY" || fail "inventory was not written"
test ! -s "$WORK/inventory-events.tsv" || fail "a valid ledger produced ledger events"
awk -F'\t' 'NF != 8 || $1 !~ /^[A-Za-z0-9_.:-]+$/ || $2 !~ /^(api|ui|perf|security|db|resilience|contract-smoke|setup|-|ambiguous)$/ \
  || $3 !~ /^(true|false)$/ || $4 !~ /^(true|false)$/ || $5 !~ /^(-|BUG-[0-9]{4}(,BUG-[0-9]{4})*)$/ \
  || $6 !~ /^[A-Za-z0-9_.:,-]+$/ || $7 !~ /^(-|skip|fixme|expected-failure|conditional)$/ || $8 !~ /^[A-Za-z0-9_.\/:-]+$/ { bad = 1 } END { exit bad }' "$INVENTORY" \
  || fail "inventory holds a row that is not 8 safe SD-3 fields"
[ -z "$(cut -f1 "$INVENTORY" | sort | uniq -d)" ] || fail "inventory case ids are not unique"
! grep -Eq '\.i[0-9]+'$'\t' "$INVENTORY" || fail "inventory listed a runtime invocation instead of its template"
awk -F'\t' '$8 !~ /^qa[.]contract[.]/' "$INVENTORY" | grep -q . || fail "inventory is not the full collection"
expect_row "$C.regression_assertion_reproduces_the_defect" contract-smoke true false BUG-0001 - - "$C"
expect_row "$C.regression_that_passes" contract-smoke true false BUG-0004 - - "$C"
expect_row "$C.regression_with_unresolved_provenance" contract-smoke true false - XYZ-999 - "$C"
expect_row "$C.regression_disabled" contract-smoke true false BUG-0001 - skip "$C"
expect_row "$C.disabled_case" contract-smoke false false - - skip "$C"
expect_row "$C.conditional_case" contract-smoke false false - - conditional "$C"
expect_row "$C.two_lane_tags" ambiguous false false - - - "$C"
expect_row "$C.parameterized_invocations" contract-smoke false false - - - "$C"
expect_row "$C.dynamic_cases" contract-smoke false false - - - "$C"
expect_row "$C.overloaded" contract-smoke false false - - - "$C"
expect_row "$C.overloaded-TestInfo" contract-smoke false false - - - "$C"
expect_row "$C.na-ve_caf" contract-smoke false false - - - "$C"
expect_row "$C.na-ve_caf.2" contract-smoke false false - - - "$C"
expect_row "$C-CleanupAfterPass.body_passes" contract-smoke false false - - - "$C-CleanupAfterPass"
expect_row "$C-FailingSetup.never_runs" contract-smoke false false - - - "$C-FailingSetup"
expect_row "$C-DisabledGroup.skipped_with_its_class" contract-smoke false false - - skip "$C-DisabledGroup"
LONG_X="$C.method_name_long_enough_that_its_sanitized_case_id_exceeds_two_hundred_characters_and_is_therefore_truncated_to_a_prefix_of_one_hundred_eighty_seven_characters_plus_a_digest"
LONG_ID="${LONG_X:0:187}.$(sha256_hex "$LONG_X" | cut -c1-12)"
[ "${#LONG_ID}" -eq 200 ] || fail "truncated case id is not 200 characters"
expect_row "$LONG_ID" contract-smoke false false - - - "$C"
printf 'BUG-0001\nBUG-0003\nBUG-0004\n' | cmp -s - "$EXPECTED_BUGS" || fail "expected bugs are not exactly the confirmed ledger entries"
printf '%s\n' "$(tsv BUG-0001 missing - -)" "$(tsv BUG-0003 missing - -)" "$(tsv BUG-0004 missing - -)" | cmp -s - "$PLAN" \
  || fail "the counterfactual plan does not list every expected bug, each without a fixture"

# (2) SD-4 ledger states, run directly on the resolved test classpath for speed.
run_logged classpath in_app "${MVN[@]}" -q org.apache.maven.plugins:maven-dependency-plugin:3.6.1:build-classpath \
  -Dmdep.outputFile="$WORK/classpath.txt" -Dmdep.includeScope=test
CLASSPATH_TEST="$APP/target/test-classes:$(cat "$WORK/classpath.txt")"
inventory_direct() {
  local mode="$1" events="$2"
  rm -f "$events" "$INVENTORY" "$EXPECTED_BUGS" "$PLAN"
  in_app env ARGUS_RUNNER_MODE="$mode" ARGUS_OUTCOME_FILE="$events" java -cp "$CLASSPATH_TEST" qa.support.argus.ArgusInventory >"$WORK/direct.log" 2>&1 \
    || { cat "$WORK/direct.log" >&2; fail "direct inventory failed in $mode"; }
  test -s "$INVENTORY" && test -f "$EXPECTED_BUGS" && test -f "$PLAN" || fail "direct inventory omitted an artifact in $mode"
}
LEDGER="$APP/solution/bug-ledger.json"

jq '."$schema" = "argus/bug-ledger@1" | .schemaVersion = 1' "$FIXTURES/bug-ledger.json" >"$LEDGER"
inventory_direct defect-evidence "$WORK/v1-events.tsv"
test ! -s "$WORK/v1-events.tsv" || fail "a valid bug-ledger@1 produced ledger events"
expect_row "$C.regression_assertion_reproduces_the_defect" contract-smoke true false BUG-0001 - - "$C"

rm -f "$LEDGER"
inventory_direct baseline "$WORK/missing-baseline.tsv"
test ! -s "$WORK/missing-baseline.tsv" && test ! -s "$EXPECTED_BUGS" && test ! -s "$PLAN" || fail "a missing ledger in baseline was not silent and empty"
inventory_direct defect-evidence "$WORK/missing-evidence.tsv"
expect_event "$WORK/missing-evidence.tsv" bug-ledger policy denied false n/a - bug-ledger-missing
expect_lines "$WORK/missing-evidence.tsv" 1
test ! -s "$EXPECTED_BUGS" || fail "a missing ledger produced expected bugs"
expect_row "$C.regression_assertion_reproduces_the_defect" contract-smoke true false - ATA-001 - "$C"

invalid_case() {
  local name="$1"
  inventory_direct baseline "$WORK/invalid-$name.tsv"
  expect_event "$WORK/invalid-$name.tsv" bug-ledger policy denied false n/a - bug-ledger-invalid
  expect_lines "$WORK/invalid-$name.tsv" 1
  test ! -s "$EXPECTED_BUGS" || fail "invalid ledger ($name) produced expected bugs"
}
printf '{"$schema": "argus/bug-ledger@2", "bugs": [' >"$LEDGER"
invalid_case not-json
jq '."$schema" = "argus/bug-ledger@3" | .schemaVersion = 3' "$FIXTURES/bug-ledger.json" >"$LEDGER"
invalid_case unsupported-schema
jq '.schemaVersion = 1' "$FIXTURES/bug-ledger.json" >"$LEDGER"
invalid_case version-mismatch
jq '.bugs[1].id = "BUG-0001"' "$FIXTURES/bug-ledger.json" >"$LEDGER"
invalid_case duplicate-id
jq '.bugs[1].origin = ["ATA-001"]' "$FIXTURES/bug-ledger.json" >"$LEDGER"
invalid_case ambiguous-alias
if in_app java -cp "$CLASSPATH_TEST" qa.support.argus.ArgusInventory >"$WORK/no-mode.log" 2>&1; then fail "inventory ran without ARGUS_RUNNER_MODE"; fi
cp "$FIXTURES/bug-ledger.json" "$LEDGER"

# (3) Execution events. Each run starts without an adapter status, as runner-lib guarantees.
# run_fixture <name> <surefire groups> [VAR=value ...]
run_fixture() {
  local name="$1" groups="$2"
  shift 2
  rm -f "$STATUS" "$WORK/$name.tsv"
  if in_app env "$@" ARGUS_OUTCOME_FILE="$WORK/$name.tsv" "${MVN[@]}" test -Dgroups="$groups" >"$WORK/$name.log" 2>&1; then native=0; else native=$?; fi
  grep -Fq 'Tests run:' "$WORK/$name.log" || { tail -80 "$WORK/$name.log" >&2; fail "$name did not execute the fixture"; }
}
expect_status() {
  local name="$1" expected="$2"
  [ "$(cat "$STATUS" 2>/dev/null)" = "$expected" ] || fail "$name adapter status is '$(cat "$STATUS" 2>/dev/null)', expected '$expected'"
}

run_fixture live contract-smoke ARGUS_RUNNER_MODE=defect-evidence
[ "$native" -ne 0 ] || fail "the fixture's failing cases did not fail the native run"
L="$WORK/live.tsv"
expect_event "$L" "$C.regression_assertion_reproduces_the_defect" product fail true reproduced BUG-0001 expected-red
expect_event "$L" "$C.regression_that_passes" product pass true automated BUG-0004 expected-red-passed
expect_event "$L" "$C.regression_with_unresolved_provenance" product pass false n/a - passed
expect_event "$L" "$C.regression_disabled" policy denied false n/a BUG-0001 regression-skipped
expect_event "$L" "$C.intermittent_regression_unreproduced" product pass false n/a BUG-0003 intermittent-unreproduced
expect_event "$L" "$C.intermittent_regression_below_bound" policy denied false n/a BUG-0003 repetition-invalid
expect_event "$L" "$C.passing_check" product pass false n/a - passed
expect_event "$L" "$C.product_assertion_fails" product fail false n/a - assertion-failed
expect_event "$L" "$C.uncaught_runtime_error" automation fail false n/a - uncaught-error
expect_event "$L" "$C.runtime_assumption_skips" skip skipped false n/a - test-skipped
expect_event "$L" "$C.refused_connection_is_unreachable" infrastructure fail false n/a - target-unreachable
expect_event "$L" "$C.socket_timeout_is_a_test_timeout" automation fail false n/a - test-timeout
expect_event "$L" "$C.missing_prerequisite" infrastructure fail false n/a - prerequisite-missing
expect_event "$L" "$C.disabled_case" skip skipped false n/a - test-skipped
expect_event "$L" "$C.conditional_case" skip skipped false n/a - test-skipped
expect_event "$L" "$C.two_lane_tags" product pass false n/a - passed
expect_event "$L" "$C.parameterized_invocations.i1" product pass false n/a - passed
expect_event "$L" "$C.parameterized_invocations.i2" product pass false n/a - passed
expect_event "$L" "$C.dynamic_cases.i1" product pass false n/a - passed
expect_event "$L" "$C.dynamic_cases.i2.i1" product pass false n/a - passed
expect_event "$L" "$C.overloaded" product pass false n/a - passed
expect_event "$L" "$C.overloaded-TestInfo" product pass false n/a - passed
expect_event "$L" "$C.na-ve_caf" product pass false n/a - passed
expect_event "$L" "$C.na-ve_caf.2" product pass false n/a - passed
expect_event "$L" "$LONG_ID" product pass false n/a - passed
expect_event "$L" "$C-CleanupAfterPass.body_passes" automation fail false n/a - cleanup-failed
expect_event "$L" "$C-CleanupAfterFailure.body_fails" product fail false n/a - assertion-failed
expect_event "$L" "$C-CleanupAfterFailure.body_fails.cleanup" automation fail false n/a - cleanup-failed
expect_event "$L" "$C-FailingSetup" automation fail false n/a - container-failed
expect_event "$L" "$C-AbortedSetup.skipped_with_its_container" skip skipped false n/a - test-skipped
expect_event "$L" "$C-DisabledGroup.skipped_with_its_class" skip skipped false n/a - test-skipped
expect_lines "$L" 31
expect_status live "ok 31"
if grep -Eq 'synthetic|127[.]0[.]0[.]1|Connection refused' "$L"; then fail "an event carried test messages or target details"; fi
# Every executed or skipped case joins its inventory row by id or '<id>.' prefix.
cut -f1 "$L" | while IFS= read -r event_id; do
  cut -f1 "$INVENTORY" | awk -v e="$event_id" '$0 == e || index(e, $0 ".") == 1 || index($0, e ".") == 1 { found = 1 } END { exit !found }' \
    || fail "event $event_id does not join the inventory"
done

run_fixture repeat regression ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=repeat
R="$WORK/repeat.tsv"
expect_event "$R" "$C.regression_assertion_reproduces_the_defect.repeat" product fail true reproduced BUG-0001 expected-red-repeat
expect_event "$R" "$C.regression_that_passes.repeat" automation fail false n/a BUG-0004 flaky-red
expect_event "$R" "$C.intermittent_regression_unreproduced.repeat" product pass false n/a BUG-0003 intermittent-unreproduced
expect_event "$R" "$C.intermittent_regression_below_bound.repeat" policy denied false n/a BUG-0003 repetition-invalid
expect_event "$R" "$C.regression_disabled.repeat" policy denied false n/a BUG-0001 regression-skipped
expect_event "$R" "$C.regression_with_unresolved_provenance.repeat" product pass false n/a - passed
expect_lines "$R" 6
expect_status repeat "ok 6"

run_fixture candidate regression ARGUS_RUNNER_MODE=candidate-regression
K="$WORK/candidate.tsv"
expect_event "$K" "$C.regression_assertion_reproduces_the_defect" product fail false automated BUG-0001 regression-red
expect_event "$K" "$C.regression_that_passes" product pass false fixed BUG-0004 regression-green
expect_event "$K" "$C.intermittent_regression_unreproduced" product pass false fixed BUG-0003 regression-green
expect_lines "$K" 6
expect_status candidate "ok 6"

# A counterfactual pass without fixtures isolates every regression: nothing runs, nothing reports.
run_fixture cf-without-fixtures regression ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=cf-correct
[ "$native" -eq 0 ] || fail "a counterfactual pass without fixtures ran a regression"
test ! -s "$WORK/cf-without-fixtures.tsv" || fail "a counterfactual pass without fixtures emitted events"
expect_status cf-without-fixtures "ok 0"

# A pass this adapter cannot map fails closed instead of posing as live evidence, and
# counterfactual evidence belongs to defect-evidence only.
run_fixture unsupported-pass regression ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=cf-bogus
test ! -s "$WORK/unsupported-pass.tsv" || fail "an unsupported evidence pass emitted events"
expect_status unsupported-pass "error 1"
run_fixture cf-outside-evidence regression ARGUS_RUNNER_MODE=candidate-regression ARGUS_EVIDENCE_PASS=cf-correct
test ! -s "$WORK/cf-outside-evidence.tsv" || fail "a counterfactual pass outside defect-evidence emitted events"
expect_status cf-outside-evidence "error 1"

# Without ARGUS_RUNNER_MODE (or in a collect-only pass) the adapter is inert.
run_fixture inert contract-smoke
test ! -e "$WORK/inert.tsv" && test ! -e "$STATUS" || fail "the adapter emitted without ARGUS_RUNNER_MODE"
run_fixture collect-only contract-smoke ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1
test ! -e "$WORK/collect-only.tsv" && test ! -e "$STATUS" || fail "the adapter emitted in a collect-only pass"

# (4) Contract oracle self-tests in a clean copy: a baseline run where every case is a product pass.
ORACLES="$WORK/java-oracles"
O="$WORK/oracles.tsv"
"$CLI" copy-template java "$ORACLES" >/dev/null
cmp -s "$ROOT/argus/framework-template/tests/contract/fixtures/openapi.selftest.json" "$ORACLES/src/test/resources/openapi.selftest.json" \
  || fail "the Java oracle self-test OpenAPI fixture drifted from the TypeScript fixture"
oracle_cases="$(grep -Ec '^[[:space:]]*@Test[[:space:]]*$' "$ORACLES/src/test/java/qa/contract/OraclesContractSelfTest.java")"
[ "$oracle_cases" -gt 0 ] || fail "the oracle self-test class declares no cases"
run_logged oracles in_dir "$ORACLES" env ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$O" "${MVN[@]}" test -Dtest=OraclesContractSelfTest
expect_lines "$O" "$oracle_cases"
awk -F'\t' 'NF != 7 || index($1, "qa.contract.OraclesContractSelfTest.") != 1 || $2 != "product" || $3 != "pass" { bad = 1 } END { exit bad }' "$O" \
  || { cat "$O" >&2; fail "an oracle self-test event is not a product pass"; }
[ "$(cat "$ORACLES/reports/argus-adapter-status.txt" 2>/dev/null)" = "ok $oracle_cases" ] || fail "oracle self-test adapter status is not 'ok $oracle_cases'"
if grep -Eq '127[.]0[.]0[.]1|argus-never-print-me' "$O"; then fail "an oracle self-test event carried test details"; fi

# Data oracle self-tests in the same copy: invalid partitions, pagination conservation,
# boundary and exact sums, identity vectors with credential consistency, and the i18n round
# trip. Each passes on a correct in-memory or 127.0.0.1 stub implementation and fails on a
# faulty one (a duplicate page, total drift, penny drift, byte truncation, one-sided
# trimming), so a healthy run is `product pass` for every case.
D="$WORK/oracles-data.tsv"
data_oracle_cases="$(grep -Ec '^[[:space:]]*@Test[[:space:]]*$' "$ORACLES/src/test/java/qa/contract/OraclesDataSelfTest.java")"
[ "$data_oracle_cases" -gt 0 ] || fail "the data oracle self-test class declares no cases"
rm -f "$ORACLES/reports/argus-adapter-status.txt"
run_logged oracles-data in_dir "$ORACLES" env ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$D" "${MVN[@]}" test -Dtest=OraclesDataSelfTest
expect_lines "$D" "$data_oracle_cases"
awk -F'\t' 'NF != 7 || index($1, "qa.contract.OraclesDataSelfTest.") != 1 || $2 != "product" || $3 != "pass" { bad = 1 } END { exit bad }' "$D" \
  || { cat "$D" >&2; fail "a data oracle self-test event is not a product pass"; }
[ "$(cat "$ORACLES/reports/argus-adapter-status.txt" 2>/dev/null)" = "ok $data_oracle_cases" ] || fail "data oracle self-test adapter status is not 'ok $data_oracle_cases'"
if grep -Eq '127[.]0[.]0[.]1|Qa7' "$D"; then fail "a data oracle self-test event carried test details"; fi

# Behaviour oracle self-tests in the same copy: the pure bounds and scaling analyses, and the
# soft-delete sweep, double submit, and concurrent race against 127.0.0.1 stubs. A list that
# still serves a deleted id, a double submit with two effects, and a race that overbooks are
# RED while their correct twins are GREEN, so a healthy run is `product pass` for every
# case; no browser starts.
B="$WORK/oracles-behavior.tsv"
behavior_oracle_cases="$(grep -Ec '^[[:space:]]*@Test[[:space:]]*$' "$ORACLES/src/test/java/qa/contract/OraclesBehaviorSelfTest.java")"
[ "$behavior_oracle_cases" -gt 0 ] || fail "the behaviour oracle self-test class declares no cases"
rm -f "$ORACLES/reports/argus-adapter-status.txt"
run_logged oracles-behavior in_dir "$ORACLES" env ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$B" "${MVN[@]}" test -Dtest=OraclesBehaviorSelfTest
expect_lines "$B" "$behavior_oracle_cases"
awk -F'\t' 'NF != 7 || index($1, "qa.contract.OraclesBehaviorSelfTest.") != 1 || $2 != "product" || $3 != "pass" { bad = 1 } END { exit bad }' "$B" \
  || { cat "$B" >&2; fail "a behaviour oracle self-test event is not a product pass"; }
[ "$(cat "$ORACLES/reports/argus-adapter-status.txt" 2>/dev/null)" = "ok $behavior_oracle_cases" ] || fail "behaviour oracle self-test adapter status is not 'ok $behavior_oracle_cases'"
if grep -Eq '127[.]0[.]0[.]1|overbooked|still serves' "$B"; then fail "a behaviour oracle self-test event carried test details"; fi

# Inside an engagement the opt-in alone never injects a server fault: FaultInjector also needs
# the grant runner-lib.sh issues after the chaos authorization, whether ARGUS_ENGAGEMENT_MANIFEST
# names the engagement or its manifest sits above the Maven basedir.
cat >"$ORACLES/src/test/java/qa/contract/ServerFaultProbeTest.java" <<'JAVA'
package qa.contract;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.argus.FaultInjector;
import qa.support.argus.FaultInjector.Fault;
import qa.support.argus.FaultInjector.Scope;

@Tag("contract-smoke")
class ServerFaultProbeTest {
    @Test
    void a_server_fault() throws Exception {
        FaultInjector.run(new Fault("probe-fault", Scope.SERVER, () -> { }, () -> { }, () -> { }), () -> null);
    }
}
JAVA
SF_ID=qa.contract.ServerFaultProbeTest.a_server_fault
server_fault() {  # server_fault <label> [VAR=value ...]: one baseline run of the probe with the opt-in
  local label="$1"
  shift
  rm -f "$ORACLES/reports/argus-adapter-status.txt" "$WORK/$label.tsv"
  in_dir "$ORACLES" env ARGUS_RUNNER_MODE=baseline ARGUS_OUTCOME_FILE="$WORK/$label.tsv" ARGUS_FAULT_INJECTION=authorized "$@" \
    "${MVN[@]}" -q test -Dtest=ServerFaultProbeTest >"$WORK/$label.log" 2>&1 || true
  [ -f "$WORK/$label.tsv" ] || { tail -40 "$WORK/$label.log" >&2; fail "$label emitted no event"; }
}
server_fault server-fault-outside
expect_event "$WORK/server-fault-outside.tsv" "$SF_ID" product pass false n/a - passed
server_fault server-fault-named "ARGUS_ENGAGEMENT_MANIFEST=$WORK/engagement/ai_agents_internal/engagement.json"
expect_event "$WORK/server-fault-named.tsv" "$SF_ID" infrastructure fail false n/a - prerequisite-missing
server_fault server-fault-granted "ARGUS_ENGAGEMENT_MANIFEST=$WORK/engagement/ai_agents_internal/engagement.json" ARGUS_FAULT_INJECTION_GRANT=tyche
expect_event "$WORK/server-fault-granted.tsv" "$SF_ID" product pass false n/a - passed
: >"$ORACLES/ai_agents_internal/engagement.json"
server_fault server-fault-detected
rm -f "$ORACLES/ai_agents_internal/engagement.json" "$ORACLES/src/test/java/qa/contract/ServerFaultProbeTest.java"
expect_event "$WORK/server-fault-detected.tsv" "$SF_ID" infrastructure fail false n/a - prerequisite-missing

# The ADAPT-ME examples (compiled in section 1) teach exact oracles: one documented status,
# never a class or a presence-only body check, a strict schema by operationId, a read-back
# with cleanup, and a measured p95 instead of a polling wait.
EXAMPLES="$ORACLES/src/test/java/qa"
if grep -Eq 'anyOf\(|notNullValue|assumeTrue|EnabledIf' "$EXAMPLES/api/ExampleApiTest.java" "$EXAMPLES/perf/BudgetSmokeTest.java"; then
  fail "an ADAPT-ME example accepts a status class, a presence-only body, or skips itself"
fi
for anchor in 'Http.expectStatus(res, SPEC_ANONYMOUS_STATUS)' 'Schema.assertSchema(res, OP_GET_ME)' 'Http.assertRestStatus(res, RestState.CREATED)' \
  'created.register(user, location)' 'Boundary.boundary3(' 'Partitions.invalidObjectPartitions('; do
  grep -Fq -- "$anchor" "$EXAMPLES/api/ExampleApiTest.java" || fail "ExampleApiTest lost its exact oracle: $anchor"
done
if grep -Fq 'Awaitility' "$EXAMPLES/perf/BudgetSmokeTest.java"; then fail "BudgetSmokeTest polls instead of measuring a p95"; fi
grep -Fq 'nearestRank(samples, 95)' "$EXAMPLES/perf/BudgetSmokeTest.java" && grep -Fq 'Scaling.n1Scaling(' "$EXAMPLES/perf/BudgetSmokeTest.java" \
  || fail "BudgetSmokeTest lost its p95 or n1Scaling oracle"
if grep -Fq 'Pattern.compile("dashboard|home' "$EXAMPLES/ui/ExampleUiTest.java"; then fail "ExampleUiTest asserts a URL pattern instead of the exact URL"; fi

# (5) Counterfactual evidence (SD-6, SD-10) in a clean copy: the plan, every cf pass, and the
# evidence gate over the adapter's own events. API_URL is a refused loopback port, so a case
# that escaped the stub would report target-unreachable instead of its verdict.
CF="$WORK/java-counterfactual"
CFC=qa.api.CounterfactualFixtureTest
CF_PLAN="$CF/reports/counterfactual-plan.tsv"
CF_FIXTURE="$CF/solution/counterfactual/BUG-0001.json"
CF_EXEMPT="$CF/solution/counterfactual/BUG-0004.json"
CF_ENV=(OPENAPI_PATH="$CF/counterfactual-openapi.json" API_URL=http://127.0.0.1:9)
"$CLI" copy-template java "$CF" >/dev/null
grep -Fxq 'qa.support.argus.ArgusCounterfactualExtension' "$CF/src/test/resources/META-INF/services/org.junit.jupiter.api.extension.Extension" \
  || fail "the counterfactual extension is not registered for JUnit Jupiter autodetection"
grep -Eq '^junit[.]jupiter[.]extensions[.]autodetection[.]enabled[[:space:]]*=[[:space:]]*true$' "$CF/src/test/resources/junit-platform.properties" \
  || fail "JUnit Jupiter extension autodetection is not enabled"
cp "$FIXTURES/CounterfactualFixtureTest.java" "$CF/src/test/java/qa/api/CounterfactualFixtureTest.java"
cp "$FIXTURES/bug-ledger.json" "$CF/solution/bug-ledger.json"
cp "$FIXTURES/counterfactual-openapi.json" "$CF/counterfactual-openapi.json"
mkdir -p "$CF/solution/counterfactual"
cp "$FIXTURES/counterfactual/BUG-0001.json" "$CF_FIXTURE"
cp "$CF_FIXTURE" "$WORK/BUG-0001.json"
jq -n '{"$schema": "argus/counterfactual-fixture@1", schemaVersion: 1, bugId: "BUG-0004",
  exemption: {reason: "front-end-logic", justification: "Client-side rendering logic; no HTTP exchange distinguishes the defect."}}' >"$CF_EXEMPT"
cp "$CF_EXEMPT" "$WORK/BUG-0004.json"
# Only BUG-NNNN.json is ever read: a broken example next to the fixtures changes nothing.
printf '{' >"$CF/solution/counterfactual/BUG-0000.example.json"
run_logged cf-compile in_dir "$CF" "${MVN[@]}" -q -DskipTests test-compile
run_logged cf-classpath in_dir "$CF" "${MVN[@]}" -q org.apache.maven.plugins:maven-dependency-plugin:3.6.1:build-classpath \
  -Dmdep.outputFile="$WORK/cf-classpath.txt" -Dmdep.includeScope=test
CF_CLASSPATH="$CF/target/test-classes:$(cat "$WORK/cf-classpath.txt")"

# cf_plan <row...>: the inventory pass writes exactly these SD-10 rows, one per expected bug.
cf_plan() {
  rm -f "$CF_PLAN" "$WORK/cf-inventory.tsv"
  in_dir "$CF" env ARGUS_RUNNER_MODE=defect-evidence ARGUS_OUTCOME_FILE="$WORK/cf-inventory.tsv" "${CF_ENV[@]}" \
    java -cp "$CF_CLASSPATH" qa.support.argus.ArgusInventory >"$WORK/cf-plan.log" 2>&1 \
    || { cat "$WORK/cf-plan.log" >&2; fail "counterfactual inventory failed"; }
  test ! -s "$WORK/cf-inventory.tsv" || fail "the counterfactual inventory emitted events"
  printf '%s\n' "$@" | cmp -s - "$CF_PLAN" || { cat "$CF_PLAN" >&2; fail "counterfactual plan is not: $*"; }
}
FIXTURE_ROW="$(tsv BUG-0001 fixture observed-defect,missing-field -)"
MISSING_ROW="$(tsv BUG-0003 missing - -)"
EXEMPT_ROW="$(tsv BUG-0004 exempt - front-end-logic)"
cf_plan "$FIXTURE_ROW" "$MISSING_ROW" "$EXEMPT_ROW"
[ "$(bash "$CF/scripts/evidence-gate.sh" --plan "$CF_PLAN" --list-passes | tr '\n' ' ')" = "cf-correct cf-tamper-1 cf-tamper-2 " ] \
  || fail "the evidence gate does not derive cf-correct, cf-tamper-1 and cf-tamper-2 from the written plan"
invalid_fixture() {
  local reason="$1" filter="$2"
  jq "$filter" "$WORK/BUG-0001.json" >"$CF_FIXTURE"
  cf_plan "$(tsv BUG-0001 invalid - "$reason")" "$MISSING_ROW" "$EXEMPT_ROW"
}
invalid_fixture missing-observed-defect '.tampers |= map(select(.id != "observed-defect"))'
invalid_fixture correct-violates-contract '.exchanges[0].response.body.extra = true'
invalid_fixture correct-violates-contract '.contract.status = 201'
invalid_fixture schema-invalid '.subject = "unrecorded"'
invalid_fixture schema-invalid '.bugId = "BUG-0002"'
invalid_fixture schema-invalid '.tampers[1].id = "correct"'
invalid_fixture schema-invalid '.tampers += [.tampers[1]]'
invalid_fixture schema-invalid '.exchanges[0].request.method = "get"'
invalid_fixture schema-invalid '.exchanges[0].response.headers = {"Content-Type": "application/json"}'
invalid_fixture schema-invalid '.oracle.kind = "hunch"'
invalid_fixture schema-invalid '.unexpected = true'
invalid_fixture schema-invalid '. + {exemption: {reason: "front-end-logic", justification: "Both shapes at once."}}'
printf '{' >"$CF_FIXTURE"
cf_plan "$(tsv BUG-0001 invalid - schema-invalid)" "$MISSING_ROW" "$EXEMPT_ROW"
cp "$WORK/BUG-0001.json" "$CF_FIXTURE"
jq '.exemption.reason = "too-hard"' "$WORK/BUG-0004.json" >"$CF_EXEMPT"
cf_plan "$FIXTURE_ROW" "$MISSING_ROW" "$(tsv BUG-0004 invalid - schema-invalid)"
cp "$WORK/BUG-0004.json" "$CF_EXEMPT"
cf_plan "$FIXTURE_ROW" "$MISSING_ROW" "$EXEMPT_ROW"

# cf_run <name> <pass|live> <methods>: one native run of the selected fixture cases.
cf_run() {
  local name="$1" pass="$2" methods="$3"
  local selection=(ARGUS_RUNNER_MODE=defect-evidence)
  if [ "$pass" != live ]; then selection+=(ARGUS_EVIDENCE_PASS="$pass"); fi
  rm -f "$CF/reports/argus-adapter-status.txt" "$WORK/$name.tsv"
  if in_dir "$CF" env "${selection[@]}" "${CF_ENV[@]}" ARGUS_OUTCOME_FILE="$WORK/$name.tsv" \
    "${MVN[@]}" test -Dtest="CounterfactualFixtureTest#$methods" >"$WORK/$name.log" 2>&1; then native=0; else native=$?; fi
  grep -Fq 'Tests run:' "$WORK/$name.log" || { tail -80 "$WORK/$name.log" >&2; fail "$name did not execute the counterfactual fixture"; }
  touch "$WORK/$name.tsv"
}
cf_status() {
  [ "$(cat "$CF/reports/argus-adapter-status.txt" 2>/dev/null)" = "$2" ] \
    || fail "$1 adapter status is '$(cat "$CF/reports/argus-adapter-status.txt" 2>/dev/null)', expected '$2'"
}
PROOF=widget_matches_the_contract+widget_status_only+exempt_front_end_regression+regression_without_fixture

# Outside a counterfactual pass the extension is inert: the regression reaches API_URL.
cf_run cf-live live widget_matches_the_contract
expect_event "$WORK/cf-live.tsv" "$CFC.widget_matches_the_contract" infrastructure fail false n/a BUG-0001 target-unreachable
expect_lines "$WORK/cf-live.tsv" 1

cf_run cf-correct cf-correct "$PROOF"
[ "$native" -eq 0 ] || fail "cf-correct failed a case natively"
C1="$WORK/cf-correct.tsv"
expect_event "$C1" "$CFC.widget_matches_the_contract.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
expect_event "$C1" "$CFC.widget_status_only.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
expect_event "$C1" "$CFC.exempt_front_end_regression.cf" policy pass false n/a BUG-0004 counterfactual-exempt.front-end-logic
expect_lines "$C1" 3
cf_status cf-correct "ok 3"

cf_run cf-tamper-1 cf-tamper-1 "$PROOF"
T1="$WORK/cf-tamper-1.tsv"
expect_event "$T1" "$CFC.widget_matches_the_contract.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_event "$T1" "$CFC.widget_status_only.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_lines "$T1" 2
cf_status cf-tamper-1 "ok 2"

# The weakened copy checks the status only, so the 200 response without a field survives it.
cf_run cf-tamper-2 cf-tamper-2 "$PROOF"
T2="$WORK/cf-tamper-2.tsv"
expect_event "$T2" "$CFC.widget_matches_the_contract.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_event "$T2" "$CFC.widget_status_only.cf-missing-field" automation fail false n/a BUG-0001 counterfactual-tamper-survived
expect_lines "$T2" 2
cf_status cf-tamper-2 "ok 2"

# A tamper pass beyond the fixture's tampers is not applicable: nothing runs, nothing reports.
cf_run cf-tamper-3 cf-tamper-3 "$PROOF"
[ "$native" -eq 0 ] && test ! -s "$WORK/cf-tamper-3.tsv" || fail "a not-applicable tamper pass ran or reported a case"
cf_status cf-tamper-3 "ok 0"

# A request outside the recorded exchanges voids the verdict whether or not the body passed,
# and a test cannot silence itself with the not-applicable sentinel.
cf_run cf-unmatched cf-correct widget_with_an_undeclared_call+undeclared_call_breaks_the_assertion+spoofed_not_applicable
U="$WORK/cf-unmatched.tsv"
expect_event "$U" "$CFC.widget_with_an_undeclared_call.cf-correct" automation fail false n/a BUG-0001 counterfactual-unmatched-request
expect_event "$U" "$CFC.undeclared_call_breaks_the_assertion.cf-correct" automation fail false n/a BUG-0001 counterfactual-unmatched-request
expect_event "$U" "$CFC.spoofed_not_applicable.cf-correct" policy denied false n/a BUG-0001 regression-skipped
expect_lines "$U" 3
cf_status cf-unmatched "ok 3"

# A correct response the regression rejects is counterfactual-correct-red.
jq 'del(.contract) | .exchanges[0].response.body.extra = true' "$WORK/BUG-0001.json" >"$CF_FIXTURE"
cf_run cf-correct-red cf-correct widget_matches_the_contract
expect_event "$WORK/cf-correct-red.tsv" "$CFC.widget_matches_the_contract.cf-correct" automation fail false n/a BUG-0001 counterfactual-correct-red
expect_lines "$WORK/cf-correct-red.tsv" 1
cp "$WORK/BUG-0001.json" "$CF_FIXTURE"

if cat "$C1" "$T1" "$T2" "$U" "$WORK/cf-correct-red.tsv" | grep -Eq 'target-unreachable|127[.]0[.]0[.]1|boom'; then
  fail "a counterfactual case reached the target or carried response details"
fi

# The evidence gate accepts the adapter's own proof for the fixture and the exemption, and
# fails the bug that has no fixture: plan rows and event suffixes agree byte for byte.
awk -F'\t' -v a="$CFC.widget_matches_the_contract." -v b="$CFC.exempt_front_end_regression." 'index($1, a) == 1 || index($1, b) == 1' \
  "$C1" "$T1" "$T2" >"$WORK/cf-proof.tsv"
expect_lines "$WORK/cf-proof.tsv" 4
bash "$CF/scripts/evidence-gate.sh" --expected-bugs "$CF/reports/expected-bugs.txt" --plan "$CF_PLAN" --events "$WORK/cf-proof.tsv" \
  || fail "the evidence gate failed on the counterfactual proof"
if grep -Eq '^counterfactual[.]BUG-000[14]'$'\t' "$WORK/cf-proof.tsv"; then
  grep -E '^counterfactual[.]' "$WORK/cf-proof.tsv" >&2
  fail "the evidence gate rejected the adapter's counterfactual proof"
fi
expect_event "$WORK/cf-proof.tsv" counterfactual.BUG-0003 policy denied false n/a BUG-0003 counterfactual-missing

# (6) End-to-end runner against a local faulty target. A scaffold from `template select` +
# `template scaffold` (non-default layout) runs ./run-tests.sh end to end: runner-lib.sh, the
# lane plan, readiness, the environment baseline, the inventory, the quarantine, inventory,
# and evidence gates, and every evidence pass. scripts/fixtures/argus-runtime/faulty-target.mjs
# answers GET /widgets/1 with 500 (buggy) or the specified widget (fixed).
E="$WORK/e2e"
E2E="$FIXTURES/e2e"
E2E_TESTS="$E/quality/java-tests"
E2E_ID=qa.api.WidgetRegressionTest.widget_read_returns_the_specified_widget
E2E_HEALTH_ID=qa.api.WidgetRegressionTest.health_endpoint_reports_ok
E2E_EV="$E/reports/outcomes.raw.tsv"
mkdir -p "$WORK/e2e-target"
"$CLI" template select --target "$WORK/e2e-target" --runtime java --package-manager maven \
  --test-root quality/java-tests --harness-root quality/java-support --output "$WORK/e2e-selection.json" >/dev/null
"$CLI" template scaffold --selection "$WORK/e2e-selection.json" --destination "$E" >/dev/null
# The ADAPT-ME examples go before the first compile, so no stale class reaches the inventory.
for lane in api ui perf security db resilience; do rm -f "$E2E_TESTS/qa/$lane/"*.java; done
[ -z "$(find "$E2E_TESTS" -name '*.java' ! -path '*/qa/contract/*' -print -quit)" ] || fail "e2e: an ADAPT-ME example test survived"
cp "$E2E/WidgetRegressionTest.java" "$E2E_TESTS/qa/api/WidgetRegressionTest.java"
cp "$E2E/bug-ledger.json" "$E/solution/bug-ledger.json"
cp "$E2E/BUG-0001.json" "$E/solution/counterfactual/BUG-0001.json"
cp "$E2E/test-lanes.tsv" "$E2E/environment.tsv" "$E/solution/"
# The same read-only verify as the TypeScript end-to-end fixture: the target holds no state.
cp "$ROOT/scripts/fixtures/argus-runtime/typescript/e2e/verify-baseline.sh" "$E/scripts/verify-baseline.sh"

# start_target <buggy|fixed>: (re)starts the faulty target on an ephemeral 127.0.0.1 port.
start_target() {
  local port="" attempt
  stop_target
  : >"$WORK/target.log"
  FAULTY_MODE="$1" PORT=0 node "$ROOT/scripts/fixtures/argus-runtime/faulty-target.mjs" >"$WORK/target.log" 2>&1 &
  TARGET_PID=$!
  for attempt in $(seq 1 100); do
    port="$(sed -n 's/^listening \([0-9][0-9]*\)$/\1/p' "$WORK/target.log")"
    [ -z "$port" ] || break
    sleep 0.1
  done
  [ -n "$port" ] || { cat "$WORK/target.log" >&2; fail "the faulty target did not start after $attempt checks"; }
  TARGET_URL="http://127.0.0.1:$port"
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
# pass_summary <pass> <jq filter>: the collected summary of one evidence pass.
pass_summary() {
  jq -e "$2" "$E/reports/evidence/passes/$1/summary.json" >/dev/null
}

start_target buggy
e2e defect-evidence 0 defect-evidence
expect_event "$E2E_EV" "$E2E_ID" product fail true reproduced BUG-0001 expected-red
expect_event "$E2E_EV" "$E2E_ID.repeat" product fail true reproduced BUG-0001 expected-red-repeat
expect_event "$E2E_EV" "$E2E_ID.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
expect_event "$E2E_EV" "$E2E_ID.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_event "$E2E_EV" "$E2E_ID.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_event "$E2E_EV" environment infrastructure pass false n/a - environment-baseline-verified
# Each pass keeps its own native evidence: the RED passes and the green cf-correct pass.
for pass in live repeat cf-correct cf-tamper-1 cf-tamper-2; do
  [ -f "$E/reports/evidence/passes/$pass/surefire-reports/TEST-qa.api.WidgetRegressionTest.xml" ] &&
    [ -f "$E/reports/evidence/passes/$pass/summary.json" ] && [ -f "$E/reports/evidence/passes/$pass/summary.html" ] ||
    fail "e2e: pass $pass kept no native evidence"
done
for pass in live repeat cf-tamper-1 cf-tamper-2; do
  pass_summary "$pass" '.total == 1 and .failed == 1 and .passed == 0' || fail "e2e: pass $pass evidence is not its own RED run"
done
pass_summary cf-correct '.total == 1 and .passed == 1 and .failed == 0' || fail "e2e: cf-correct evidence is not its own green run"

# A regression that checks only the status lets the missing-field tamper survive.
cp "$E2E_TESTS/qa/api/WidgetRegressionTest.java" "$WORK/WidgetRegressionTest.java"
grep -v 'argus-smoke: strict body' "$WORK/WidgetRegressionTest.java" >"$E2E_TESTS/qa/api/WidgetRegressionTest.java"
e2e weakened 11 defect-evidence
cp "$WORK/WidgetRegressionTest.java" "$E2E_TESTS/qa/api/WidgetRegressionTest.java"
expect_event "$E2E_EV" "$E2E_ID.cf-missing-field" automation fail false n/a BUG-0001 counterfactual-tamper-survived

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
if grep -Fq -- qa.contract. "$E2E_EV"; then cat "$E2E_EV" >&2; fail "e2e: full-suite selected a contract-smoke test"; fi
e2e full-narrowed 13 full-suite -- -Dtest=WidgetRegressionTest
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
stop_target

printf 'PASS  Argus Java runtime adapter: Launcher-discovery inventory, SD-2 case ids, SD-4 ledger states, SD-5 classification, SD-6 live/repeat/candidate events, fail-closed passes, inert activation, contract, data and behaviour oracle self-tests, exact-oracle examples, the SD-10 counterfactual plan, passes and evidence, and an end-to-end runner against a faulty target\n'
