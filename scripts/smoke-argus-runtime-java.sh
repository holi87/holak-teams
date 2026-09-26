#!/usr/bin/env bash
# Clean-room validation of the Java runtime adapter: the JUnit Platform outcome listener,
# the Launcher-discovery inventory, and the SD-4 ledger join, run against a
# target-independent fixture in a freshly copied Java template.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-runtime/java"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The adapter reads these; a caller's environment must not leak into the clean room.
unset ARGUS_RUNNER_MODE ARGUS_EVIDENCE_PASS ARGUS_INVENTORY_ONLY ARGUS_OUTCOME_FILE ARGUS_CONTRACT_SMOKE

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
for tool in java mvn jq; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done

APP="$WORK/java"
C=qa.contract.ClassificationFixtureTest
INVENTORY="$APP/reports/test-inventory.tsv"
EXPECTED_BUGS="$APP/reports/expected-bugs.txt"
STATUS="$APP/reports/argus-adapter-status.txt"
MVN=(mvn -B -ntp)

in_app() { (cd "$APP" && "$@"); }
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

# The fixture replaces the legacy contract-smoke case, which writes its own event by hand.
"$CLI" copy-template java "$APP" >/dev/null
grep -Fxq 'qa.support.argus.ArgusOutcomeListener' "$APP/src/test/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener" \
  || fail "outcome listener is not registered with the JUnit Platform launcher"
grep -Fxq 'qa.support.SummaryListener' "$APP/src/test/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener" \
  || fail "summary listener registration was dropped"
rm "$APP/src/test/java/qa/contract/TemplateContractTest.java"
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

# (2) SD-4 ledger states, run directly on the resolved test classpath for speed.
run_logged classpath in_app "${MVN[@]}" -q org.apache.maven.plugins:maven-dependency-plugin:3.6.1:build-classpath \
  -Dmdep.outputFile="$WORK/classpath.txt" -Dmdep.includeScope=test
CLASSPATH_TEST="$APP/target/test-classes:$(cat "$WORK/classpath.txt")"
inventory_direct() {
  local mode="$1" events="$2"
  rm -f "$events" "$INVENTORY" "$EXPECTED_BUGS"
  in_app env ARGUS_RUNNER_MODE="$mode" ARGUS_OUTCOME_FILE="$events" java -cp "$CLASSPATH_TEST" qa.support.argus.ArgusInventory >"$WORK/direct.log" 2>&1 \
    || { cat "$WORK/direct.log" >&2; fail "direct inventory failed in $mode"; }
  test -s "$INVENTORY" && test -f "$EXPECTED_BUGS" || fail "direct inventory omitted an artifact in $mode"
}
LEDGER="$APP/solution/bug-ledger.json"

jq '."$schema" = "argus/bug-ledger@1" | .schemaVersion = 1' "$FIXTURES/bug-ledger.json" >"$LEDGER"
inventory_direct defect-evidence "$WORK/v1-events.tsv"
test ! -s "$WORK/v1-events.tsv" || fail "a valid bug-ledger@1 produced ledger events"
expect_row "$C.regression_assertion_reproduces_the_defect" contract-smoke true false BUG-0001 - - "$C"

rm -f "$LEDGER"
inventory_direct baseline "$WORK/missing-baseline.tsv"
test ! -s "$WORK/missing-baseline.tsv" && test ! -s "$EXPECTED_BUGS" || fail "a missing ledger in baseline was not silent and empty"
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

# A pass this adapter cannot map fails closed instead of posing as live evidence.
run_fixture unsupported-pass regression ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=cf-correct
test ! -s "$WORK/unsupported-pass.tsv" || fail "an unsupported evidence pass emitted events"
expect_status unsupported-pass "error 1"

# Without ARGUS_RUNNER_MODE (or in a collect-only pass) the adapter is inert.
run_fixture inert contract-smoke
test ! -e "$WORK/inert.tsv" && test ! -e "$STATUS" || fail "the adapter emitted without ARGUS_RUNNER_MODE"
run_fixture collect-only contract-smoke ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1
test ! -e "$WORK/collect-only.tsv" && test ! -e "$STATUS" || fail "the adapter emitted in a collect-only pass"

printf 'PASS  Argus Java runtime adapter: Launcher-discovery inventory, SD-2 case ids, SD-4 ledger states, SD-5 classification, SD-6 live/repeat/candidate events, fail-closed passes, and inert activation\n'
