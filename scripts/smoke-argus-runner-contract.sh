#!/usr/bin/env bash
# Verify identical runner-mode semantics across TypeScript, Java, and Python templates.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/scripts/fixtures/argus-runner"
CLI="$ROOT/argus/claude/bin/argus-assets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ENGINES=(
  "$ROOT/argus/framework-template/scripts/runner-contract.sh"
  "$ROOT/argus/framework-template-java/scripts/runner-contract.sh"
  "$ROOT/argus/framework-template-python/scripts/runner-contract.sh"
)
ADAPTERS=(
  "$ROOT/argus/framework-template/scripts/outcome-event.sh"
  "$ROOT/argus/framework-template-java/scripts/outcome-event.sh"
  "$ROOT/argus/framework-template-python/scripts/outcome-event.sh"
)

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

cmp "${ENGINES[0]}" "${ENGINES[1]}" || fail "Java runner contract drifted from TypeScript"
cmp "${ENGINES[0]}" "${ENGINES[2]}" || fail "Python runner contract drifted from TypeScript"
cmp "${ADAPTERS[0]}" "${ADAPTERS[1]}" || fail "Java outcome adapter drifted from TypeScript"
cmp "${ADAPTERS[0]}" "${ADAPTERS[2]}" || fail "Python outcome adapter drifted from TypeScript"

PARALLEL_EVENTS="$WORK/parallel.tsv"
for index in $(seq 1 24); do
  ARGUS_OUTCOME_FILE="$PARALLEL_EVENTS" "${ADAPTERS[0]}" "case-$index" product pass false n/a - event-recorded &
done
wait
[ "$(wc -l <"$PARALLEL_EVENTS" | tr -d ' ')" -eq 24 ] || fail "parallel outcome events were lost"
if ARGUS_OUTCOME_FILE="$PARALLEL_EVENTS" "${ADAPTERS[0]}" invalid unknown pass false n/a - bad >/dev/null 2>&1; then
  fail "outcome adapter accepted an invalid category"
fi
cat "$FIXTURES/defect-evidence.tsv" "$FIXTURES/automation-failure.tsv" >"$WORK/evidence-with-unexpected.tsv"

evaluate() {
  local engine="$1" mode="$2" fixture="$3" native_exit="$4" expected_exit="$5" label="$6" output code
  shift 6
  output="$WORK/$label.json"
  set +e
  "$engine" --mode "$mode" --events "$fixture" --output "$output" --runner-exit "$native_exit" "$@"
  code=$?
  set -e
  [ "$code" -eq "$expected_exit" ] || fail "$label exited $code instead of $expected_exit"
  jq -e --arg mode "$mode" --argjson code "$expected_exit" '."$schema" == "argus/runner-result@1" and .schemaVersion == 1 and .mode == $mode and .exitCode == $code' "$output" >/dev/null || fail "$label result contract is invalid"
  "$CLI" schema validate --kind runner-result --input "$output" >/dev/null || fail "$label result failed packaged runtime validation"
}

for index in "${!ENGINES[@]}"; do
  engine="${ENGINES[$index]}"
  # An approved skip needs a quarantine row; the same fixture without the register is an
  # unapproved skip, because `expected=true` is written by the adapter about itself.
  evaluate "$engine" baseline "$FIXTURES/baseline.tsv" 0 0 "baseline-$index" --quarantine "$FIXTURES/quarantine.tsv"
  evaluate "$engine" baseline "$FIXTURES/baseline.tsv" 0 15 "baseline-unregistered-skip-$index"
  # An empty event stream with a green native runner is a broken adapter, never a pass.
  evaluate "$engine" baseline /dev/null 0 14 "baseline-no-events-$index"
  evaluate "$engine" full-suite /dev/null 0 14 "full-no-events-$index"
  # Every confirmed defect the caller names must appear as an event.
  evaluate "$engine" defect-evidence "$FIXTURES/defect-evidence.tsv" 1 0 "evidence-expected-$index" --expected-bugs "$FIXTURES/expected-bugs.txt"
  evaluate "$engine" defect-evidence "$FIXTURES/defect-evidence.tsv" 1 13 "evidence-missing-bug-$index" --expected-bugs "$FIXTURES/expected-bugs-missing.txt"
  evaluate "$engine" defect-evidence "$FIXTURES/defect-evidence.tsv" 1 0 "evidence-$index"
  evaluate "$engine" defect-evidence "$WORK/evidence-with-unexpected.tsv" 1 11 "evidence-unexpected-$index"
  evaluate "$engine" candidate-regression "$FIXTURES/candidate-regression.tsv" 0 0 "candidate-$index"
  evaluate "$engine" full-suite "$FIXTURES/full-suite.tsv" 0 0 "full-$index" --quarantine "$FIXTURES/quarantine.tsv"
  evaluate "$engine" candidate-regression "$FIXTURES/known-red.tsv" 1 10 "known-red-candidate-$index"
  evaluate "$engine" full-suite "$FIXTURES/known-red.tsv" 1 10 "known-red-full-$index"
  evaluate "$engine" full-suite "$FIXTURES/automation-failure.tsv" 1 11 "automation-$index"
  evaluate "$engine" full-suite "$FIXTURES/infrastructure-failure.tsv" 1 12 "infrastructure-$index"
  evaluate "$engine" full-suite "$FIXTURES/policy-denial.tsv" 1 13 "policy-$index"
  evaluate "$engine" defect-evidence /dev/null 1 14 "missing-evidence-$index"
  evaluate "$engine" full-suite "$FIXTURES/unapproved-skip.tsv" 0 15 "skip-$index"
  # A contract smoke proves the scaffold, not the target: never a delivery gate.
  evaluate "$engine" full-suite "$FIXTURES/full-suite.tsv" 0 0 "full-contract-smoke-$index" --quarantine "$FIXTURES/quarantine.tsv" --contract-smoke
  jq -e '.deliveryGate == true' "$WORK/full-$index.json" >/dev/null || fail "full-suite result $index is not marked as the delivery gate"
  jq -e '.deliveryGate == false' "$WORK/full-contract-smoke-$index.json" >/dev/null || fail "contract smoke result $index was marked as a delivery gate"
done

for runner in "$ROOT/argus/framework-template/run-tests.sh" "$ROOT/argus/framework-template-java/run-tests.sh" "$ROOT/argus/framework-template-python/run-tests.sh"; do
  # A runner on the common library gets its modes and result path from runner-lib.sh, which
  # the loop below checks; the literal checks remain for runners not yet migrated to it.
  if grep -Fxq 'source scripts/runner-lib.sh' "$runner" && grep -Fxq 'argus_main "$@"' "$runner"; then continue; fi
  grep -Fq 'baseline|defect-evidence|candidate-regression|full-suite' "$runner" || fail "$(basename "$(dirname "$runner")") does not expose all modes"
  grep -Fq 'reports/argus-runner-result.json' "$runner" || fail "$(basename "$(dirname "$runner")") does not emit the canonical result"
done
for library in "$ROOT/argus/framework-template/scripts/runner-lib.sh" "$ROOT/argus/framework-template-java/scripts/runner-lib.sh" "$ROOT/argus/framework-template-python/scripts/runner-lib.sh"; do
  grep -Fq 'baseline|defect-evidence|candidate-regression|full-suite' "$library" || fail "$(basename "$(dirname "$(dirname "$library")")") runner library does not expose all modes"
  grep -Fq 'reports/argus-runner-result.json' "$library" || fail "$(basename "$(dirname "$(dirname "$library")")") runner library does not emit the canonical result"
  cmp "$library" "$ROOT/argus/framework-template-common/scripts/runner-lib.sh" >/dev/null || fail "$library drifted from the common runner library"
done

jq -e '.categories == {"product":1,"automation":1,"infrastructure":1,"skip":1,"policy":1}' "$WORK/full-0.json" >/dev/null || fail "full-suite categories are not distinct"
grep -Fq '"lifecycle":"discovered"' "$WORK/evidence-0.json" || fail "discovery lifecycle event missing"
grep -Fq '"lifecycle":"reproduced"' "$WORK/evidence-0.json" || fail "reproduction lifecycle event missing"
grep -Fq '"lifecycle":"automated"' "$WORK/evidence-0.json" || fail "automation lifecycle event missing"
grep -Fq '"lifecycle":"fixed"' "$WORK/candidate-0.json" || fail "fixed lifecycle event missing"
grep -Fq '"lifecycle":"closed"' "$WORK/full-0.json" || fail "closed lifecycle event missing"

# ---------------------------------------------------------------------------------------
# Automation review gate (scripts/runner-lib.sh): the latest round of Aristarchus's
# solution/automation-review.json decides a full-suite run. The node and python3 readers must
# agree on every record, so a delivered suite without node reads it exactly as an engagement.
COMMON="$ROOT/argus/framework-template-common"
GATES="$ROOT/scripts/fixtures/argus-runner-gates"
REVIEWS="$WORK/reviews"
mkdir -p "$REVIEWS"
command -v python3 >/dev/null || fail "python3 is required to check the automation review readers"
for fixture in approve block; do
  "$CLI" schema validate --kind automation-review --input "$FIXTURES/automation-review-$fixture.json" >/dev/null ||
    fail "automation-review-$fixture.json is not a valid argus/automation-review@1 record"
done
APPROVE_RECORD="$FIXTURES/automation-review-approve.json"
BLOCK_RECORD="$FIXTURES/automation-review-block.json"

# Malformed records: each must fail closed in both readers.
printf '{"$schema":"argus/automation-review@1","schemaVersion":1,"reviews":[' >"$REVIEWS/truncated.json"
printf '[]\n' >"$REVIEWS/not-an-object.json"
jq '."$schema" = "argus/automation-review@2"' "$APPROVE_RECORD" >"$REVIEWS/wrong-schema.json"
jq '.schemaVersion = true' "$APPROVE_RECORD" >"$REVIEWS/boolean-version.json"
jq '.reviews = []' "$APPROVE_RECORD" >"$REVIEWS/no-rounds.json"
jq 'del(.reviews[0])' "$APPROVE_RECORD" >"$REVIEWS/round-gap.json"
jq '.reviews[-1].round = "2"' "$APPROVE_RECORD" >"$REVIEWS/string-round.json"
jq '.reviews[-1].verdict = "REJECT"' "$BLOCK_RECORD" >"$REVIEWS/unknown-verdict.json"
jq '.reviews[-1].blockers = []' "$BLOCK_RECORD" >"$REVIEWS/block-without-blockers.json"
jq '.reviews[-1].blockers = .reviews[0].blockers' "$APPROVE_RECORD" >"$REVIEWS/approve-with-blockers.json"
jq -c . "$APPROVE_RECORD" | sed 's/"line":8/"line":NaN/' >"$REVIEWS/nan-constant.json"
{ printf '\357\273\277'; cat "$APPROVE_RECORD"; } >"$REVIEWS/byte-order-mark.json"
{ printf '{"$schema":"argus/automation-review@1","schemaVersion":1,"engagementId":"\377","reviews":'; jq -c .reviews "$APPROVE_RECORD"; printf '}\n'; } >"$REVIEWS/invalid-utf8.json"

# reader_output <function> <record> [PATH]: `status=<n> <stdout>` of one reader call.
reader_output() {
  local output status=0
  output="$(PATH="${3:-$PATH}" && source "$COMMON/scripts/runner-lib.sh" && "$1" "$2" 2>/dev/null)" || status=$?
  printf 'status=%s %s' "$status" "$output"
}
[ "$(reader_output argus_automation_review_node "$APPROVE_RECORD")" = "$(printf 'status=0 APPROVE\tREV-02\t2\t0')" ] ||
  fail "the node reader misread the latest APPROVE round"
[ "$(reader_output argus_automation_review_node "$BLOCK_RECORD")" = "$(printf 'status=0 BLOCK\tREV-02\t2\t1')" ] ||
  fail "the node reader misread the latest BLOCK round"
for record in "$APPROVE_RECORD" "$BLOCK_RECORD" "$REVIEWS"/*.json; do
  node_output="$(reader_output argus_automation_review_node "$record")"
  [ "$(reader_output argus_automation_review_python "$record")" = "$node_output" ] ||
    fail "the python3 reader disagrees with the node reader on $(basename "$record")"
  case "$record" in
    "$REVIEWS"/*) [ "$node_output" = 'status=1 ' ] || fail "the readers accepted the malformed record $(basename "$record")" ;;
  esac
done
# The dispatcher prefers node, falls back to python3, and fails closed without either or for
# a record that is not a regular file.
PYTHON_ONLY="$WORK/python-only-bin"
mkdir -p "$PYTHON_ONLY" "$WORK/no-reader-bin"
ln -s "$(python3 -c 'import sys; print(sys.executable)')" "$PYTHON_ONLY/python3"
[ "$(reader_output argus_automation_review_latest "$BLOCK_RECORD" "$PYTHON_ONLY")" = "$(printf 'status=0 BLOCK\tREV-02\t2\t1')" ] ||
  fail "the dispatcher did not fall back to python3 without node"
[ "$(reader_output argus_automation_review_latest "$APPROVE_RECORD" "$WORK/no-reader-bin")" = 'status=1 ' ] ||
  fail "the dispatcher accepted a record without node or python3"
ln -s "$APPROVE_RECORD" "$REVIEWS/linked-record"
[ "$(reader_output argus_automation_review_latest "$REVIEWS/linked-record")" = 'status=1 ' ] ||
  fail "the dispatcher followed a symbolic link to an APPROVE record"
[ "$(reader_output argus_automation_review_latest "$REVIEWS")" = 'status=1 ' ] || fail "the dispatcher read a directory as a record"

# End to end, a replay runtime (the runner-gates smoke's fake runtime and green scenario)
# drives the whole library, so the gate runs as the last step of a real run. The runner reads
# these variables; a hermetic smoke never inherits them from its caller.
unset ARGUS_ENGAGEMENT_MANIFEST ARGUS_ENGAGEMENT_LANE ARGUS_ENVIRONMENT_RESET ARGUS_FAULT_INJECTION \
  ARGUS_CONTRACT_SMOKE ARGUS_OUTCOME_FILE ARGUS_READINESS_URLS ARGUS_TEST_ROOT ARGUS_TODAY \
  ARGUS_RUNNER_MODE ARGUS_EVIDENCE_PASS ARGUS_INVENTORY_ONLY PERF_BUDGET_MS SECURITY_ENABLED DB_URL
READY="$WORK/ready.txt"
printf 'ready\n' >"$READY"

# review_case <label> <runner-lib> <green|contract-smoke> <record|link:<record>|-> <mode>
#   <expected-exit> [env...]: the contract-smoke scenario is layered on green and runs without
#   a lane plan, as ARGUS_CONTRACT_SMOKE=1 does.
review_case() {
  local label="$1" library="$2" scenario="$3" record="$4" mode="$5" expected="$6" dir="$WORK/review-case-$1" code
  local environment=()
  shift 6
  environment=("$@")
  mkdir -p "$dir/scripts" "$dir/solution" "$dir/ai_agents_internal" "$dir/scenario"
  cp "$COMMON/scripts/"* "$dir/scripts/"
  cp "$library" "$dir/scripts/runner-lib.sh"
  cp -R "$GATES/scenarios/green/." "$dir/scenario/"
  cp "$dir/scenario/scripts/"* "$dir/scripts/"
  cp "$dir/scenario/environment.tsv" "$dir/solution/"
  if [ "$scenario" = green ]; then
    cp "$dir/scenario/test-lanes.tsv" "$dir/solution/"
  else
    cp -R "$GATES/scenarios/$scenario/." "$dir/scenario/"
  fi
  cp "$GATES/fake-runtime/run-tests.sh" "$dir/run-tests.sh"
  printf '{\n  "runtime": "fake",\n  "packageManager": "replay",\n  "choiceSource": "explicit-user"\n}\n' \
    >"$dir/ai_agents_internal/template-selection.json"
  case "$record" in
    -) ;;
    link:*) ln -s "${record#link:}" "$dir/solution/automation-review.json" ;;
    *) cp "$record" "$dir/solution/automation-review.json" ;;
  esac
  set +e
  (cd "$dir" && env ${environment[@]+"${environment[@]}"} API_URL="file://$READY" UI_URL="file://$READY" \
    ARGUS_FAKE_SCENARIO="$dir/scenario" ./run-tests.sh --mode "$mode" >"$dir/run.log" 2>&1)
  code=$?
  set -e
  if [ "$code" -ne "$expected" ]; then
    tail -20 "$dir/run.log" >&2
    fail "review case $label exited $code instead of $expected"
  fi
  jq -e --arg mode "$mode" --argjson code "$expected" '.mode == $mode and .exitCode == $code' "$dir/reports/argus-runner-result.json" >/dev/null ||
    fail "review case $label result does not record mode $mode and exit $expected"
  "$CLI" schema validate --kind runner-result --input "$dir/reports/argus-runner-result.json" >/dev/null ||
    fail "review case $label result failed packaged runtime validation"
}
review_event() {
  local label="$1"
  shift
  grep -Fxq "$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "$@")" "$WORK/review-case-$label/reports/outcomes.raw.tsv" ||
    fail "review case $label lacks event: $*"
}
review_silent() {
  if cut -f1 "$WORK/review-case-$1/reports/outcomes.raw.tsv" | grep -Eq '^automation-review'; then
    fail "review case $1 unexpectedly ran the automation review gate"
  fi
}
review_logged() { grep -Fq -- "$2" "$WORK/review-case-$1/run.log" || fail "review case $1 did not print: $2"; }

LIBRARY="$COMMON/scripts/runner-lib.sh"
review_case absent "$LIBRARY" green - full-suite 0
review_silent absent
review_case approve "$LIBRARY" green "$APPROVE_RECORD" full-suite 0
review_event approve automation-review.REV-02 policy pass false n/a - automation-review-approved
review_logged approve 'ARGUS AUTOMATION REVIEW: the latest round REV-02 (round 2) is APPROVE'
jq -e '.status == "pass" and .deliveryGate == true' "$WORK/review-case-approve/reports/argus-runner-result.json" >/dev/null ||
  fail "an APPROVE round changed the green delivery gate"
review_case block "$LIBRARY" green "$BLOCK_RECORD" full-suite 13
review_event block automation-review.REV-02 policy denied false n/a - automation-review-blocked
review_logged block 'the latest round REV-02 (round 2) is BLOCK with 1 blocker(s)'
# The suite still ran: every category stays in the result beside the denial.
jq -e '.categories.product == 3 and ([.events[] | select(.caseId == "automation-review.REV-02" and .status == "denied" and .reason == "automation-review-blocked")] | length) == 1' \
  "$WORK/review-case-block/reports/argus-runner-result.json" >/dev/null || fail "the BLOCK result lost the suite events or the denial"
# Only a full-suite run is gated; the repair loop and a contract smoke are not delivery gates.
review_case block-baseline "$LIBRARY" green "$BLOCK_RECORD" baseline 0
review_silent block-baseline
review_case block-candidate "$LIBRARY" green "$BLOCK_RECORD" candidate-regression 0
review_silent block-candidate
review_case block-contract-smoke "$LIBRARY" contract-smoke "$BLOCK_RECORD" full-suite 0 ARGUS_CONTRACT_SMOKE=1
review_silent block-contract-smoke
# A record the gate cannot read fails closed, even a link to an APPROVE record.
for malformed in truncated unknown-verdict block-without-blockers; do
  review_case "malformed-$malformed" "$LIBRARY" green "$REVIEWS/$malformed.json" full-suite 13
  review_event "malformed-$malformed" automation-review policy denied false n/a - automation-review-invalid
  review_logged "malformed-$malformed" 'is unreadable or malformed; the full-suite delivery gate fails closed'
done
review_case malformed-link "$LIBRARY" green "link:$APPROVE_RECORD" full-suite 13
review_event malformed-link automation-review policy denied false n/a - automation-review-invalid
# Every composed template carries the gate in its own copy of the library.
for template in framework-template framework-template-java framework-template-python; do
  review_case "block-$template" "$ROOT/argus/$template/scripts/runner-lib.sh" green "$BLOCK_RECORD" full-suite 13
  review_event "block-$template" automation-review.REV-02 policy denied false n/a - automation-review-blocked
done

printf 'PASS  Argus runner contract: four modes, lifecycle, categories, exit codes, the automation review gate, and template parity\n'
