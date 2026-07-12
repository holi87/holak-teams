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
  output="$WORK/$label.json"
  set +e
  "$engine" --mode "$mode" --events "$fixture" --output "$output" --runner-exit "$native_exit"
  code=$?
  set -e
  [ "$code" -eq "$expected_exit" ] || fail "$label exited $code instead of $expected_exit"
  jq -e --arg mode "$mode" --argjson code "$expected_exit" '."$schema" == "argus/runner-result@1" and .schemaVersion == 1 and .mode == $mode and .exitCode == $code' "$output" >/dev/null || fail "$label result contract is invalid"
  "$CLI" schema validate --kind runner-result --input "$output" >/dev/null || fail "$label result failed packaged runtime validation"
}

for index in "${!ENGINES[@]}"; do
  engine="${ENGINES[$index]}"
  evaluate "$engine" baseline "$FIXTURES/baseline.tsv" 0 0 "baseline-$index"
  evaluate "$engine" defect-evidence "$FIXTURES/defect-evidence.tsv" 1 0 "evidence-$index"
  evaluate "$engine" defect-evidence "$WORK/evidence-with-unexpected.tsv" 1 11 "evidence-unexpected-$index"
  evaluate "$engine" candidate-regression "$FIXTURES/candidate-regression.tsv" 0 0 "candidate-$index"
  evaluate "$engine" full-suite "$FIXTURES/full-suite.tsv" 0 0 "full-$index"
  evaluate "$engine" candidate-regression "$FIXTURES/known-red.tsv" 1 10 "known-red-candidate-$index"
  evaluate "$engine" full-suite "$FIXTURES/known-red.tsv" 1 10 "known-red-full-$index"
  evaluate "$engine" full-suite "$FIXTURES/automation-failure.tsv" 1 11 "automation-$index"
  evaluate "$engine" full-suite "$FIXTURES/infrastructure-failure.tsv" 1 12 "infrastructure-$index"
  evaluate "$engine" full-suite "$FIXTURES/policy-denial.tsv" 1 13 "policy-$index"
  evaluate "$engine" defect-evidence /dev/null 1 14 "missing-evidence-$index"
  evaluate "$engine" full-suite "$FIXTURES/unapproved-skip.tsv" 0 15 "skip-$index"
done

for runner in "$ROOT/argus/framework-template/run-tests.sh" "$ROOT/argus/framework-template-java/run-tests.sh" "$ROOT/argus/framework-template-python/run-tests.sh"; do
  grep -Fq 'baseline|defect-evidence|candidate-regression|full-suite' "$runner" || fail "$(basename "$(dirname "$runner")") does not expose all modes"
  grep -Fq 'reports/argus-runner-result.json' "$runner" || fail "$(basename "$(dirname "$runner")") does not emit the canonical result"
done

jq -e '.categories == {"product":1,"automation":1,"infrastructure":1,"skip":1,"policy":1}' "$WORK/full-0.json" >/dev/null || fail "full-suite categories are not distinct"
grep -Fq '"lifecycle":"discovered"' "$WORK/evidence-0.json" || fail "discovery lifecycle event missing"
grep -Fq '"lifecycle":"reproduced"' "$WORK/evidence-0.json" || fail "reproduction lifecycle event missing"
grep -Fq '"lifecycle":"automated"' "$WORK/evidence-0.json" || fail "automation lifecycle event missing"
grep -Fq '"lifecycle":"fixed"' "$WORK/candidate-0.json" || fail "fixed lifecycle event missing"
grep -Fq '"lifecycle":"closed"' "$WORK/full-0.json" || fail "closed lifecycle event missing"

printf 'PASS  Argus runner contract: four modes, lifecycle, categories, exit codes, and template parity\n'
