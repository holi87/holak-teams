#!/usr/bin/env bash
# Clean-room validation of the TypeScript outcome adapter (RUNNER-CONTRACT.md SD-1 to SD-7):
# collection inventory, ledger join for ledger v1 and v2, expected bugs, SD-4 ledger events,
# SD-5 classification, SD-6 pass mapping including declared repetition, the adapter status,
# inertness without ARGUS_RUNNER_MODE, the contract, data, and behaviour oracle self-tests,
# counterfactual evidence (SD-10 plan, cf-correct and cf-tamper passes against the in-worker stub), bug
# provenance through Playwright's own collection plus the portable inventory and quarantine
# gates, and an end-to-end run of run-tests.sh (runner-lib.sh, lane plan, environment
# baseline, evidence passes) against scripts/fixtures/argus-runtime/faulty-target.mjs.
# Only that local 127.0.0.1 target is ever contacted; no browser is needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-runtime/typescript"
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

T="$WORK/typescript"
REPORTER=./scripts/argus-playwright-reporter.mjs
SPEC=tests/contract/classification.spec.ts
LEDGER="$T/solution/bug-ledger.json"
ID='contract-smoke:contract-classification.spec.ts:'
SRC="$SPEC:"

# The adapter reads its activation from the environment; a caller's values must not leak in.
# The same holds for the runner library's inputs in the end-to-end section.
unset ARGUS_RUNNER_MODE ARGUS_EVIDENCE_PASS ARGUS_INVENTORY_ONLY ARGUS_OUTCOME_FILE \
  ARGUS_CONTRACT_SMOKE ARGUS_SMOKE_UNSET_PREREQUISITE ARGUS_COUNTERFACTUAL_API_URL \
  ARGUS_API_ROUTE_PATTERN ARGUS_SMOKE_EXTRA_REQUEST OPENAPI_PATH \
  ARGUS_ENGAGEMENT_MANIFEST ARGUS_ENGAGEMENT_LANE ARGUS_ENVIRONMENT_RESET ARGUS_FAULT_INJECTION \
  ARGUS_READINESS_URLS ARGUS_TEST_ROOT ARGUS_TODAY ARGUS_BROWSER_ARTIFACTS ARGUS_AUTH_DIRECTORY \
  ARGUS_RESET_TIMEOUT_SECONDS ARGUS_VERIFY_TIMEOUT_SECONDS UI_URL PERF_BUDGET_MS SECURITY_ENABLED DB_URL

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

# pw <log-name> [VAR=value ...] <command ...>: run in the scaffold and record the exit code.
pw() {
  local log="$1"
  shift
  rm -rf "$T/reports"
  set +e
  (cd "$T" && env "$@") >"$WORK/$log.log" 2>&1
  PW_CODE=$?
  set -e
}

show() { printf -- '--- %s\n' "$1" >&2; cat "$1" >&2 2>/dev/null || printf '(absent)\n' >&2; }

# expect_line <file> <label> <field...>: the file holds this exact tab-separated line.
expect_line() {
  local file="$1" label="$2" line
  shift 2
  line="$(IFS=$'\t'; printf '%s' "$*")"
  grep -Fxq -- "$line" "$file" 2>/dev/null || { show "$file"; fail "$label: missing line: $line"; }
}

expect_count() {
  local file="$1" count="$2" label="$3" actual=0
  [ -f "$file" ] && actual="$(wc -l <"$file" | tr -d ' ')"
  [ "$actual" -eq "$count" ] || { show "$file"; fail "$label: expected $count lines, found $actual"; }
}

expect_status() {
  local pattern="$1" label="$2"
  grep -Eqx -- "$pattern" "$T/reports/argus-adapter-status.txt" 2>/dev/null || { show "$T/reports/argus-adapter-status.txt"; fail "$label: adapter status does not match $pattern"; }
}

line_of() {
  local number
  number="$(grep -nF -- "$1" "$T/$SPEC" | head -1 | cut -d: -f1)"
  [ -n "$number" ] || fail "fixture title not found: $1"
  printf '%s' "$number"
}

"$CLI" copy-template typescript "$T" >/dev/null
(cd "$T" && npm ci --ignore-scripts) >"$WORK/install.log" 2>&1 || { tail -40 "$WORK/install.log" >&2; fail "npm ci failed in the TypeScript template"; }
cp "$FIXTURES/classification.spec.ts" "$T/$SPEC"
cp "$FIXTURES/counterfactual.spec.ts" "$T/tests/contract/counterfactual.spec.ts"
cp "$FIXTURES/counterfactual-openapi.json" "$T/tests/contract/fixtures/counterfactual-openapi.json"
cp "$FIXTURES/bug-ledger.json" "$LEDGER"
cp "$LEDGER" "$WORK/bug-ledger.json"
PLAN="$T/reports/counterfactual-plan.tsv"
(cd "$T" && npx tsc --noEmit) >"$WORK/tsc.log" 2>&1 || { cat "$WORK/tsc.log" >&2; fail "the template with the Argus error helpers and fixtures does not typecheck"; }

INVENTORY_CMD=(npx playwright test --list "--reporter=$REPORTER")
LIVE_CMD=(npx playwright test --project=contract-smoke "--reporter=$REPORTER" "$SPEC")
REGRESSION_CMD=(npx playwright test --project=contract-smoke "--reporter=$REPORTER" --grep @regression "$SPEC")

# --- Inventory pass (SD-3, SD-4) over the complete collection ---------------------------
pw inventory ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 "${INVENTORY_CMD[@]}"
[ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/inventory.log" >&2; fail "inventory pass exited $PW_CODE"; }
INV="$WORK/inventory.tsv"
cp "$T/reports/test-inventory.tsv" "$INV" || fail "inventory pass wrote no reports/test-inventory.tsv"
listed="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$WORK/inventory.log")"
[ -n "$listed" ] || { tail -20 "$WORK/inventory.log" >&2; fail "Playwright did not report a collection total"; }
expect_count "$INV" "$listed" "inventory covers the full collection"
awk -F'\t' 'NF != 8 { exit 1 }' "$INV" || { show "$INV"; fail "an inventory row does not have 8 fields"; }
[ -z "$(cut -f1 "$INV" | sort | uniq -d)" ] || { show "$INV"; fail "inventory case ids are not unique"; }
awk -F'\t' '
  { split($8, path, "/"); dir = path[2]
    want = (dir == "contract") ? "contract-smoke" : dir
    if (path[1] != "tests" || $2 != want) { print "lane mismatch: " $0; bad = 1 } }
  END { exit bad }' "$INV" >&2 || fail "a project did not map onto its lane"

expect_line "$INV" "ATA-001 origin alias" "${ID}regression-reproduces-the-observed-defect" contract-smoke true false BUG-0001 - - "$SRC$(line_of "'regression reproduces the observed defect'")"
expect_line "$INV" "canonical provenance token" "${ID}regression-no-longer-reproduces" contract-smoke true false BUG-0001 - - "$SRC$(line_of "'regression no longer reproduces'")"
expect_line "$INV" "unknown provenance" "${ID}regression-with-unknown-provenance" contract-smoke true false - XYZ-999 - "$SRC$(line_of "'regression with unknown provenance'")"
expect_line "$INV" "static skip" "${ID}statically-skipped" contract-smoke false false - - skip "$SRC$(line_of "'statically skipped'")"
expect_line "$INV" "fixme" "${ID}fixme-placeholder" contract-smoke false false - - fixme "$SRC$(line_of "'fixme placeholder'")"
expect_line "$INV" "test.fail" "${ID}expected-failure-is-forbidden" contract-smoke false false - - expected-failure "$SRC$(line_of "'expected failure is forbidden'")"
expect_line "$INV" "spaces and non-ASCII" "${ID}Gr-e-suite-title-with-spaces-n-code" contract-smoke false false - - - "$SRC$(line_of "'title with spaces")"
expect_line "$INV" "collision first" "${ID}collision-a-b" contract-smoke false false - - - "$SRC$(line_of "'collision a/b'")"
expect_line "$INV" "collision second" "${ID}collision-a-b.2" contract-smoke false false - - - "$SRC$(line_of "'collision a b'")"
long_tail="$(printf 'x%.0s' $(seq 1 230))"
long_raw="contract-smoke:contract/classification.spec.ts:long title $long_tail"
long_clean="${ID}long-title-$long_tail"
long_hash="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1], "utf8").digest("hex").slice(0, 12))' "$long_raw")"
expect_line "$INV" "long title bound" "${long_clean:0:187}.$long_hash" contract-smoke false false - - - "$SRC$(line_of 'long title')"
printf 'BUG-0001\n' | cmp -s - "$T/reports/expected-bugs.txt" || { show "$T/reports/expected-bugs.txt"; fail "expected-bugs must hold only the confirmed BUG-0001"; }
printf 'BUG-0001\tmissing\t-\t-\n' | cmp -s - "$PLAN" || { show "$PLAN"; fail "the counterfactual plan must list the confirmed BUG-0001 as missing"; }
[ ! -e "$T/reports/outcomes.raw.tsv" ] || { show "$T/reports/outcomes.raw.tsv"; fail "a valid ledger produced inventory events"; }
expect_status 'ok 0' "inventory pass"

# Ledger v1 has the same id/origin shape and joins identically.
jq '."$schema" = "argus/bug-ledger@1" | .schemaVersion = 1' "$WORK/bug-ledger.json" >"$LEDGER"
pw inventory-v1 ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 "${INVENTORY_CMD[@]}"
[ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/inventory-v1.log" >&2; fail "v1 inventory pass exited $PW_CODE"; }
grep -Fq "${ID}regression-reproduces-the-observed-defect	contract-smoke	true	false	BUG-0001	-	-	" "$T/reports/test-inventory.tsv" || fail "ledger v1 origin alias did not resolve"
printf 'BUG-0001\n' | cmp -s - "$T/reports/expected-bugs.txt" || fail "ledger v1 expected-bugs drifted"
[ ! -e "$T/reports/outcomes.raw.tsv" ] || fail "a valid v1 ledger produced inventory events"

# A missing ledger is silent in baseline and a policy denial in every other mode.
rm -f "$LEDGER"
pw inventory-missing-baseline ARGUS_RUNNER_MODE=baseline ARGUS_INVENTORY_ONLY=1 "${INVENTORY_CMD[@]}"
[ -f "$T/reports/expected-bugs.txt" ] && [ ! -s "$T/reports/expected-bugs.txt" ] || fail "baseline without a ledger must write an empty expected-bugs file"
[ -f "$PLAN" ] && [ ! -s "$PLAN" ] || fail "baseline without a ledger must write an empty counterfactual plan"
[ ! -e "$T/reports/outcomes.raw.tsv" ] || fail "baseline without a ledger emitted an event"
grep -Fq "${ID}regression-reproduces-the-observed-defect	contract-smoke	true	false	-	ATA-001	-	" "$T/reports/test-inventory.tsv" || fail "provenance resolved without a ledger"
pw inventory-missing ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 "${INVENTORY_CMD[@]}"
expect_line "$T/reports/outcomes.raw.tsv" "missing ledger" bug-ledger policy denied false n/a - bug-ledger-missing
expect_count "$T/reports/outcomes.raw.tsv" 1 "missing ledger events"
expect_status 'ok 1' "missing-ledger inventory"

# An invalid ledger is a policy denial in every mode, baseline included.
# shellcheck disable=SC2016 # a literal, truncated JSON document
printf '{"$schema": "argus/bug-ledger@2",' >"$WORK/invalid-not-json.json"
jq '."$schema" = "argus/bug-ledger@9" | .schemaVersion = 9' "$WORK/bug-ledger.json" >"$WORK/invalid-schema.json"
jq '.schemaVersion = 1' "$WORK/bug-ledger.json" >"$WORK/invalid-version-mismatch.json"
jq '.bugs[1].id = "BUG-0001"' "$WORK/bug-ledger.json" >"$WORK/invalid-duplicate-id.json"
jq '.bugs[1].origin = ["ATA-001"]' "$WORK/bug-ledger.json" >"$WORK/invalid-shared-alias.json"
jq '.bugs[1].origin = ["BUG-0001"]' "$WORK/bug-ledger.json" >"$WORK/invalid-alias-names-id.json"
for variant in not-json schema version-mismatch duplicate-id shared-alias alias-names-id; do
  cp "$WORK/invalid-$variant.json" "$LEDGER"
  pw "inventory-invalid-$variant" ARGUS_RUNNER_MODE=baseline ARGUS_INVENTORY_ONLY=1 "${INVENTORY_CMD[@]}"
  expect_line "$T/reports/outcomes.raw.tsv" "invalid ledger ($variant)" bug-ledger policy denied false n/a - bug-ledger-invalid
  expect_count "$T/reports/outcomes.raw.tsv" 1 "invalid ledger ($variant) events"
  [ -f "$T/reports/expected-bugs.txt" ] && [ ! -s "$T/reports/expected-bugs.txt" ] || fail "invalid ledger ($variant) produced expected bugs"
done

# A collection error must never publish a partial inventory.
cp "$WORK/bug-ledger.json" "$LEDGER"
printf "import { test } from '@playwright/test';\nthrow new Error('load failure on purpose');\ntest('never collected', async () => {});\n" >"$T/tests/contract/broken-load.spec.ts"
pw inventory-load-error ARGUS_RUNNER_MODE=defect-evidence ARGUS_INVENTORY_ONLY=1 "${INVENTORY_CMD[@]}"
rm -f "$T/tests/contract/broken-load.spec.ts"
[ "$PW_CODE" -ne 0 ] || fail "a collection error did not fail the inventory pass"
[ ! -e "$T/reports/test-inventory.tsv" ] && [ ! -e "$T/reports/expected-bugs.txt" ] && [ ! -e "$PLAN" ] || fail "a collection error published inventory artifacts"
expect_status 'error [0-9]+' "collection error"

# --- Executed defect-evidence live pass (SD-5, SD-6) ------------------------------------
# ARGUS_OUTCOME_FILE is unset here: the adapter resolves the default path against the
# template root itself.
pw live ARGUS_RUNNER_MODE=defect-evidence "${LIVE_CMD[@]}"
[ "$PW_CODE" -ne 0 ] || fail "the classification run must fail natively"
EV="$T/reports/outcomes.raw.tsv"
expect_line "$EV" "expected RED" "${ID}regression-reproduces-the-observed-defect" product fail true reproduced BUG-0001 expected-red
expect_line "$EV" "expected RED passed" "${ID}regression-no-longer-reproduces" product pass true automated BUG-0001 expected-red-passed
expect_line "$EV" "repetition above 1 for a deterministic entry" "${ID}intermittent-regression-declares-its-repetition" policy denied false n/a BUG-0001 repetition-invalid
expect_line "$EV" "unresolved regression never claims RED" "${ID}regression-with-unknown-provenance" product pass false n/a - passed
expect_line "$EV" "regression runtime skip" "${ID}regression-skipped-at-runtime" policy denied false n/a BUG-0001 regression-skipped
expect_line "$EV" "TypeError" "${ID}thrown-type-error-is-an-automation-defect" automation fail false n/a - uncaught-error
expect_line "$EV" "fixture setup" "${ID}fixture-setup-failure" automation fail false n/a - fixture-failed
expect_line "$EV" "cleanup teardown" "${ID}cleanup-failure-after-a-passing-body" automation fail false n/a - cleanup-failed
expect_line "$EV" "assertion with cleanup" "${ID}assertion-failure-with-a-cleanup-failure" product fail false n/a - assertion-failed
expect_line "$EV" "secondary cleanup" "${ID}assertion-failure-with-a-cleanup-failure.cleanup" automation fail false n/a - cleanup-failed
expect_line "$EV" "hook" "${ID}hook-group-hook-failure" automation fail false n/a - hook-failed
expect_line "$EV" "test.skip" "${ID}statically-skipped" skip skipped false n/a - test-skipped
expect_line "$EV" "test.fixme" "${ID}fixme-placeholder" skip skipped false n/a - test-skipped
expect_line "$EV" "test.fail" "${ID}expected-failure-is-forbidden" policy denied false n/a - expected-failure-forbidden
expect_line "$EV" "unreachable target" "${ID}unreachable-target" infrastructure fail false n/a - target-unreachable
expect_line "$EV" "requireEnv" "${ID}missing-prerequisite" infrastructure fail false n/a - prerequisite-missing
expect_line "$EV" "timeout" "${ID}test-level-timeout" automation fail false n/a - test-timeout
expect_line "$EV" "non-regression pass" "${ID}Gr-e-suite-title-with-spaces-n-code" product pass false n/a - passed
expect_line "$EV" "collision pass" "${ID}collision-a-b.2" product pass false n/a - passed
executed="$(grep -Fc -- "$SRC" "$INV")"
expect_count "$EV" "$((executed + 1))" "one primary event per executed test plus one secondary cleanup"
expect_status "ok $((executed + 1))" "live pass"
awk -F'\t' 'NR == FNR { known[$1] = 1; next } { id = $1; sub(/\.cleanup$/, "", id); if (!(id in known)) { print "unknown case id: " $1; bad = 1 } } END { exit bad }' \
  "$INV" "$EV" >&2 || fail "executed case ids diverge from the inventory"

# --- Repeat and strict passes ------------------------------------------------------------
pw repeat ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=repeat "ARGUS_OUTCOME_FILE=$WORK/repeat-events.tsv" "${REGRESSION_CMD[@]}"
RP="$WORK/repeat-events.tsv"
expect_line "$RP" "repeat RED" "${ID}regression-reproduces-the-observed-defect.repeat" product fail true reproduced BUG-0001 expected-red-repeat
expect_line "$RP" "flaky RED" "${ID}regression-no-longer-reproduces.repeat" automation fail false n/a BUG-0001 flaky-red
expect_line "$RP" "repeat repetition" "${ID}intermittent-regression-declares-its-repetition.repeat" policy denied false n/a BUG-0001 repetition-invalid
expect_line "$RP" "repeat unresolved" "${ID}regression-with-unknown-provenance.repeat" product pass false n/a - passed
expect_line "$RP" "repeat skip" "${ID}regression-skipped-at-runtime.repeat" policy denied false n/a BUG-0001 regression-skipped
expect_count "$RP" 5 "repeat pass events"
[ ! -e "$T/reports/outcomes.raw.tsv" ] || fail "an absolute ARGUS_OUTCOME_FILE was not honoured"
expect_status 'ok 5' "repeat pass"

pw full ARGUS_RUNNER_MODE=full-suite "${REGRESSION_CMD[@]}"
expect_line "$EV" "regression RED" "${ID}regression-reproduces-the-observed-defect" product fail false automated BUG-0001 regression-red
expect_line "$EV" "regression GREEN" "${ID}regression-no-longer-reproduces" product pass false fixed BUG-0001 regression-green
expect_count "$EV" 5 "full-suite regression events"

# Declared repetition against an intermittent ledger entry: p = 2/4 gives a 95% bound of 5.
jq '.bugs[0].verification = {build: "fixture", disputedOracle: false,
      oracle: {kind: "requirement", sourceRef: "REQ-1", evidenceId: "EVD-0001", applicability: "fixture", exceptions: []},
      reproduction: {initialState: "fixture", steps: ["reproduce"], attempts: 4, occurrences: 2, evidenceIds: ["EVD-0002"]},
      independent: {status: "not-required", executor: null, evidenceIds: [], reason: "fixture"}}' \
  "$WORK/bug-ledger.json" >"$LEDGER"
pw intermittent ARGUS_RUNNER_MODE=defect-evidence "${REGRESSION_CMD[@]}"
expect_line "$EV" "intermittent unreproduced" "${ID}intermittent-regression-declares-its-repetition" product pass false n/a BUG-0001 intermittent-unreproduced
expect_line "$EV" "undeclared repetition below the bound" "${ID}regression-reproduces-the-observed-defect" policy denied false n/a BUG-0001 repetition-invalid
cp "$WORK/bug-ledger.json" "$LEDGER"

# --- Registration, inertness, and adapter failure ---------------------------------------
# Without --reporter the adapter runs from playwright.config.ts; a green run stays green.
pw configured ARGUS_RUNNER_MODE=defect-evidence npx playwright test --project=contract-smoke --grep collision "$SPEC"
[ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/configured.log" >&2; fail "a green run through the configured reporter exited $PW_CODE"; }
expect_count "$EV" 2 "configured reporter events"
expect_status 'ok 2' "configured reporter"

for activation in "" "ARGUS_RUNNER_MODE=not-a-mode"; do
  pw inert ${activation:+"$activation"} "${LIVE_CMD[@]}"
  [ ! -e "$T/reports/outcomes.raw.tsv" ] && [ ! -e "$T/reports/argus-adapter-status.txt" ] \
    || fail "the adapter was not inert with '${activation:-no ARGUS_RUNNER_MODE}'"
done

for activation in "ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=bogus" "ARGUS_RUNNER_MODE=full-suite ARGUS_EVIDENCE_PASS=repeat" \
  "ARGUS_RUNNER_MODE=candidate-regression ARGUS_EVIDENCE_PASS=cf-correct" "ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=cf-tamper-0"; do
  # shellcheck disable=SC2086 # the activation pairs are split on purpose
  pw unsupported-pass $activation npx playwright test --project=contract-smoke "--reporter=$REPORTER" --grep collision "$SPEC"
  [ "$PW_CODE" -ne 0 ] || fail "an unsupported evidence pass did not fail the run ($activation)"
  [ ! -e "$T/reports/outcomes.raw.tsv" ] || fail "an unsupported evidence pass emitted events ($activation)"
  expect_status 'error [0-9]+' "unsupported evidence pass ($activation)"
done

# --- Contract oracle self-tests ----------------------------------------------------------
# Each oracle passes on a correct stub and fails on a faulty one; every negative case
# asserts its own rejection, so a healthy run is `product pass` for every case. The stub
# binds 127.0.0.1 only; no target is contacted.
ORACLE_SPEC=tests/contract/oracles-contract.selftest.spec.ts
pw oracles-list npx playwright test --list --project=contract-smoke "$ORACLE_SPEC"
oracle_cases="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$WORK/oracles-list.log")"
[ -n "$oracle_cases" ] && [ "$oracle_cases" -gt 0 ] || { tail -20 "$WORK/oracles-list.log" >&2; fail "the oracle self-tests were not collected"; }
pw oracles ARGUS_RUNNER_MODE=baseline npx playwright test --project=contract-smoke "--reporter=list,$REPORTER" "$ORACLE_SPEC"
[ "$PW_CODE" -eq 0 ] || { tail -80 "$WORK/oracles.log" >&2; fail "the oracle self-tests exited $PW_CODE"; }
expect_count "$EV" "$oracle_cases" "one event per oracle self-test"
awk -F'\t' -v prefix='contract-smoke:contract-oracles-contract.selftest.spec.ts:' \
  'index($1, prefix) != 1 || $2 != "product" || $3 != "pass" { print "not an oracle product pass: " $0; bad = 1 } END { exit bad }' \
  "$EV" >&2 || fail "an oracle self-test event is not product pass"
expect_status "ok $oracle_cases" "oracle self-tests"

# --- Data oracle self-tests --------------------------------------------------------------
# Invalid partitions, pagination conservation, boundary and exact sums, identity vectors
# with credential consistency, and the i18n round trip: each passes on a correct in-memory
# or 127.0.0.1 stub implementation and fails on a faulty one (a duplicate page, total
# drift, penny drift, byte truncation, one-sided trimming). A healthy run is `product
# pass` for every case.
DATA_ORACLE_SPEC=tests/contract/oracles-data.selftest.spec.ts
pw oracles-data-list npx playwright test --list --project=contract-smoke "$DATA_ORACLE_SPEC"
data_oracle_cases="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$WORK/oracles-data-list.log")"
[ -n "$data_oracle_cases" ] && [ "$data_oracle_cases" -gt 0 ] || { tail -20 "$WORK/oracles-data-list.log" >&2; fail "the data oracle self-tests were not collected"; }
pw oracles-data ARGUS_RUNNER_MODE=baseline npx playwright test --project=contract-smoke "--reporter=list,$REPORTER" "$DATA_ORACLE_SPEC"
[ "$PW_CODE" -eq 0 ] || { tail -80 "$WORK/oracles-data.log" >&2; fail "the data oracle self-tests exited $PW_CODE"; }
expect_count "$EV" "$data_oracle_cases" "one event per data oracle self-test"
awk -F'\t' -v prefix='contract-smoke:contract-oracles-data.selftest.spec.ts:' \
  'index($1, prefix) != 1 || $2 != "product" || $3 != "pass" { print "not a data oracle product pass: " $0; bad = 1 } END { exit bad }' \
  "$EV" >&2 || fail "a data oracle self-test event is not product pass"
expect_status "ok $data_oracle_cases" "data oracle self-tests"

# --- Behaviour oracle self-tests ---------------------------------------------------------
# Soft-delete sweep, double submit, concurrent race, layout bounds, and growth scaling: each
# passes on a correct 127.0.0.1 stub or pure input and fails on a faulty one (a list that
# still serves a deleted id, two orders from one double submit, an overbooked last seat, an
# occluded element, an N+1 fan-out). No browser starts. A healthy run is `product pass` for
# every case.
BEHAVIOR_ORACLE_SPEC=tests/contract/oracles-behavior.selftest.spec.ts
pw oracles-behavior-list npx playwright test --list --project=contract-smoke "$BEHAVIOR_ORACLE_SPEC"
behavior_oracle_cases="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$WORK/oracles-behavior-list.log")"
[ -n "$behavior_oracle_cases" ] && [ "$behavior_oracle_cases" -gt 0 ] || { tail -20 "$WORK/oracles-behavior-list.log" >&2; fail "the behaviour oracle self-tests were not collected"; }
pw oracles-behavior ARGUS_RUNNER_MODE=baseline npx playwright test --project=contract-smoke "--reporter=list,$REPORTER" "$BEHAVIOR_ORACLE_SPEC"
[ "$PW_CODE" -eq 0 ] || { tail -80 "$WORK/oracles-behavior.log" >&2; fail "the behaviour oracle self-tests exited $PW_CODE"; }
expect_count "$EV" "$behavior_oracle_cases" "one event per behaviour oracle self-test"
awk -F'\t' -v prefix='contract-smoke:contract-oracles-behavior.selftest.spec.ts:' \
  'index($1, prefix) != 1 || $2 != "product" || $3 != "pass" { print "not a behaviour oracle product pass: " $0; bad = 1 } END { exit bad }' \
  "$EV" >&2 || fail "a behaviour oracle self-test event is not product pass"
expect_status "ok $behavior_oracle_cases" "behaviour oracle self-tests"

# --- Counterfactual evidence (SD-6, SD-10) -----------------------------------------------
# Each cf pass serves solution/counterfactual/BUG-0001.json from the in-worker 127.0.0.1
# stub. API_URL names a closed port, so a request that escaped the stub would surface as
# target-unreachable instead of reaching anything.
CF_SPEC=tests/contract/counterfactual.spec.ts
CF_ID='contract-smoke:contract-counterfactual.spec.ts:widget-read-returns-the-specified-widget'
CF_FIXTURE="$T/solution/counterfactual/BUG-0001.json"
CF_ENV=(ARGUS_RUNNER_MODE=defect-evidence "OPENAPI_PATH=$T/tests/contract/fixtures/counterfactual-openapi.json" API_URL=http://127.0.0.1:9)
mkdir -p "$T/solution/counterfactual"
cp "$FIXTURES/counterfactual/BUG-0001.json" "$WORK/cf-fixture.json"
cp "$WORK/cf-fixture.json" "$CF_FIXTURE"

# cf_inventory <log> [VAR=value ...] / cf_pass <log> <pass> [VAR=value ...]
cf_inventory() { local log="$1"; shift; pw "$log" "${CF_ENV[@]}" ARGUS_INVENTORY_ONLY=1 "$@" "${INVENTORY_CMD[@]}"; }
cf_pass() {
  local log="$1" pass="$2"
  shift 2
  pw "$log" "${CF_ENV[@]}" "ARGUS_EVIDENCE_PASS=$pass" "$@" npx playwright test --project=contract-smoke "--reporter=$REPORTER" "$CF_SPEC"
}
# expect_plan <label> <status> <tamper-ids> <reason>: the plan is exactly this BUG-0001 row.
expect_plan() {
  printf 'BUG-0001\t%s\t%s\t%s\n' "$2" "$3" "$4" | cmp -s - "$PLAN" || { show "$PLAN"; tail -20 "$WORK/$1.log" >&2; fail "$1: counterfactual plan is not 'BUG-0001 $2 $3 $4'"; }
}
# expect_only_event <label> <field...>: the pass emitted exactly this one event.
expect_only_event() {
  local label="$1"
  shift
  expect_line "$EV" "$label" "$@"
  expect_count "$EV" 1 "$label events"
  expect_status 'ok 1' "$label"
}
expect_no_events() {
  [ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/$1.log" >&2; fail "$1: a run without a counterfactual variant exited $PW_CODE"; }
  [ ! -e "$EV" ] || { show "$EV"; fail "$1: a test without a counterfactual variant emitted an event"; }
  expect_status 'ok 0' "$1"
}

cf_inventory cf-inventory
[ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/cf-inventory.log" >&2; fail "counterfactual inventory pass exited $PW_CODE"; }
expect_plan cf-inventory fixture observed-defect,missing-field -
expect_line "$T/reports/test-inventory.tsv" "counterfactual regression row" "$CF_ID" contract-smoke true false BUG-0001 - - "$CF_SPEC:$(grep -nF "'widget read returns the specified widget'" "$T/$CF_SPEC" | cut -d: -f1)"
expect_status 'ok 0' "counterfactual inventory"

cf_pass cf-correct cf-correct
[ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/cf-correct.log" >&2; fail "cf-correct exited $PW_CODE"; }
expect_only_event "cf-correct" "$CF_ID.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
cf_pass cf-tamper-1 cf-tamper-1
expect_only_event "cf-tamper-1" "$CF_ID.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
cf_pass cf-tamper-2 cf-tamper-2
expect_only_event "cf-tamper-2" "$CF_ID.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red
cf_pass cf-tamper-3 cf-tamper-3
expect_no_events cf-tamper-3

# A weakened copy that asserts only the status lets the missing-field tamper survive.
cp "$T/$CF_SPEC" "$WORK/counterfactual.spec.ts"
grep -v 'argus-smoke: strict body' "$WORK/counterfactual.spec.ts" >"$T/$CF_SPEC"
cf_pass cf-weakened cf-tamper-2
cp "$WORK/counterfactual.spec.ts" "$T/$CF_SPEC"
expect_only_event "weakened regression" "$CF_ID.cf-missing-field" automation fail false n/a BUG-0001 counterfactual-tamper-survived

# An undeclared request fails the pass, and outranks the tamper RED it may have caused.
cf_pass cf-unmatched cf-correct ARGUS_SMOKE_EXTRA_REQUEST=1
expect_only_event "unmatched request" "$CF_ID.cf-correct" automation fail false n/a BUG-0001 counterfactual-unmatched-request
cf_pass cf-unmatched-tamper cf-tamper-1 ARGUS_SMOKE_EXTRA_REQUEST=1
expect_only_event "unmatched request in a tamper pass" "$CF_ID.cf-observed-defect" automation fail false n/a BUG-0001 counterfactual-unmatched-request

# An exemption records one event in cf-correct and nothing in a tamper pass.
jq '{"$schema": ."$schema", schemaVersion, bugId, exemption: {reason: "front-end-logic", justification: "The defect lives in client-side rendering."}}' \
  "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-exempt-inventory
expect_plan cf-exempt-inventory exempt - front-end-logic
cf_pass cf-exempt cf-correct
expect_only_event "exempt fixture" "$CF_ID.cf" policy pass false n/a BUG-0001 counterfactual-exempt.front-end-logic
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
cf_pass cf-missing-correct cf-correct
expect_no_events cf-missing-correct
jq '.tampers[1].id = "correct"' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-reserved-tamper
expect_plan cf-reserved-tamper invalid - schema-invalid
jq '.bugId = "BUG-0002"' "$WORK/cf-fixture.json" >"$CF_FIXTURE"
cf_inventory cf-foreign-bug
expect_plan cf-foreign-bug invalid - schema-invalid

# The example every scaffold ships is never read as a fixture (the first inventory above
# listed BUG-0001 as missing beside it), but it must stay a valid one. Its contract names an
# operation this smoke's OpenAPI document does not define, so only the shape is checked.
CF_EXAMPLE="$T/solution/counterfactual/BUG-0000.example.json"
[ -f "$CF_EXAMPLE" ] || fail "the scaffold omitted solution/counterfactual/BUG-0000.example.json"
jq '.bugId = "BUG-0001" | del(.contract)' "$CF_EXAMPLE" >"$CF_FIXTURE"
cf_inventory cf-shipped-example
expect_plan cf-shipped-example fixture observed-defect,wrong-rejection-status -

# A declared contract without an OpenAPI document is a missing prerequisite: the plan is
# never published with a guessed status.
cp "$WORK/cf-fixture.json" "$CF_FIXTURE"
cf_inventory cf-no-openapi "OPENAPI_PATH=$WORK/absent-openapi.json"
[ "$PW_CODE" -ne 0 ] || fail "an unverifiable contract did not fail the inventory pass"
[ ! -e "$PLAN" ] && [ ! -e "$T/reports/test-inventory.tsv" ] || fail "an unverifiable contract published inventory artifacts"
expect_status 'error [0-9]+' "unverifiable contract"

# --- Provenance through the collection (SD-3, SD-4, SD-11) -------------------------------
# Playwright's own --list collection is the only provenance source: an aliased Playwright
# import, an aliased custom-fixture import, and details built in a variable are wired, while
# local look-alike helpers never reach the inventory. The portable gates then refuse disabled
# regressions, focused tests, and quarantined regressions.
rm -f "$CF_FIXTURE"
PROVENANCE="$T/tests/api/provenance"
PROVENANCE_SRC=tests/api/provenance
mkdir -p "$PROVENANCE"
cp "$FIXTURES/provenance/"*.ts "$PROVENANCE/"
cp "$FIXTURES/provenance/bug-ledger.json" "$LEDGER"
pw provenance-inventory ARGUS_RUNNER_MODE=candidate-regression ARGUS_INVENTORY_ONLY=1 npx playwright test --list --project=api "--reporter=$REPORTER"
[ "$PW_CODE" -eq 0 ] || { tail -40 "$WORK/provenance-inventory.log" >&2; fail "the provenance inventory pass exited $PW_CODE (a focused test must not abort the collect-only pass)"; }
PINV="$WORK/provenance-inventory.tsv"
cp "$T/reports/test-inventory.tsv" "$PINV"
expect_status 'ok 0' "provenance inventory"

# provenance_row <spec> <title fragment> <regression> <quarantine> <bug_ids> <unresolved> <disabled>
# The inventory holds exactly this api row for the test declared on the fragment's line.
provenance_row() {
  local spec="$1" fragment="$2" line source
  shift 2
  line="$(grep -nF -- "$fragment" "$PROVENANCE/$spec" | head -1 | cut -d: -f1)"
  [ -n "$line" ] || fail "provenance fixture title not found: $fragment"
  source="$PROVENANCE_SRC/$spec:$line"
  awk -F'\t' -v source="$source" -v want="api	$1	$2	$3	$4	$5" \
    '$8 == source && ($2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7) == want { found = 1 } END { exit !found }' "$PINV" ||
    { show "$PINV"; fail "provenance: no inventory row 'api $*' for $source"; }
}
provenance_row positive.spec.ts "'@regression @bug:BUG-0001 title" true false BUG-0001 - -
provenance_row positive.spec.ts "'details provenance is recognized'" true false BUG-0002 - -
provenance_row positive.spec.ts "'details from a variable are recognized'" true false BUG-0005 - -
provenance_row positive-alias.spec.ts "aliased Playwright provenance" true false BUG-0003 - -
provenance_row positive-custom-fixture.spec.ts "'aliased custom fixture provenance" true false BUG-0004 - -
provenance_row disabled.spec.ts "skipped coverage must not count" true false BUG-9101 - skip
provenance_row disabled.spec.ts "'fixme coverage must not count'" true false BUG-9102 - fixme
provenance_row disabled.spec.ts "'expected-failure coverage must not count'" true false BUG-9103 - expected-failure
provenance_row quarantined-regression.spec.ts "'quarantined regression is refused'" true true BUG-0006 - -
provenance_row only.spec.ts "'a focused test is forbidden'" false false - - -
provenance_row only.spec.ts "'a sibling of the focused test'" false false - - -
negative_rows="$(awk -F'\t' -v prefix="$PROVENANCE_SRC/negative.spec.ts:" 'index($8, prefix) == 1' "$PINV")"
[ "$(printf '%s\n' "$negative_rows" | grep -c .)" -eq 4 ] || { show "$PINV"; fail "provenance: the negative fixture must collect exactly its 4 tests"; }
printf '%s\n' "$negative_rows" | awk -F'\t' '$3 != "false" || $5 != "-" || $6 != "-" { bad = 1 } END { exit bad }' ||
  { show "$PINV"; fail "provenance: comments, strings, nested and unrelated metadata became provenance"; }
if awk -F'\t' -v prefix="$PROVENANCE_SRC/shadowed.spec.ts:" 'index($8, prefix) == 1 { found = 1 } END { exit !found }' "$PINV"; then
  show "$PINV"
  fail "provenance: a local test helper reached the inventory"
fi

PEV="$WORK/provenance-events.tsv"
(cd "$T" && bash scripts/inventory-gate.sh static --inventory "$PINV" --expected-bugs reports/expected-bugs.txt \
  --lanes api --events "$PEV" --mode candidate-regression --test-root tests) >"$WORK/provenance-gate.log" 2>&1 ||
  { cat "$WORK/provenance-gate.log" >&2; fail "the inventory gate rejected a usable provenance inventory"; }
if (cd "$T" && bash scripts/quarantine-contract.sh --events "$PEV" --ledger solution/quarantine.tsv --inventory "$PINV") >/dev/null 2>&1; then
  fail "a quarantined regression passed the quarantine contract"
fi
# has_bug_event <label> <category> <status> <bug> <reason>: some event carries these fields.
has_bug_event() {
  awk -F'\t' -v want="$2	$3	$4	$5" '($2 "\t" $3 "\t" $6 "\t" $7) == want { found = 1 } END { exit !found }' "$PEV" ||
    { show "$PEV"; fail "provenance: $1: no '$2 $3 $4 $5' event"; }
}
for bug in BUG-0001 BUG-0002 BUG-0003 BUG-0004 BUG-0005; do
  if grep -Fq -- "bug-coverage.$bug" "$PEV"; then show "$PEV"; fail "provenance: wired $bug was reported uncovered"; fi
done
for bug in BUG-0006 BUG-9101 BUG-9102 BUG-9103 BUG-9201 BUG-9202 BUG-9203 BUG-9204; do
  expect_line "$PEV" "uncovered $bug" "bug-coverage.$bug" policy denied false n/a "$bug" bug-uncovered
done
has_bug_event "skip" policy denied BUG-9101 regression-disabled.skip
has_bug_event "fixme" policy denied BUG-9102 regression-disabled.fixme
has_bug_event "test.fail" policy denied BUG-9103 regression-disabled.expected-failure
has_bug_event "quarantined regression" policy denied BUG-0006 regression-quarantine-forbidden
expect_line "$PEV" "focused test" focus-scan policy denied false n/a - focused-test-forbidden
awk -F'\t' -v prefix="$PROVENANCE_SRC/negative.spec.ts:" \
  'NR == FNR { if (index($8, prefix) == 1) negative[$1] = 1; next } ($1 in negative) { print "negative row event: " $0; bad = 1 } END { exit bad }' \
  "$PINV" "$PEV" >&2 || fail "provenance: a test without provenance drew a provenance event"
# forbidOnly still refuses every executed run.
pw provenance-focused-run ARGUS_RUNNER_MODE=candidate-regression npx playwright test --project=api "--reporter=list,$REPORTER" "$PROVENANCE_SRC/only.spec.ts"
[ "$PW_CODE" -ne 0 ] && grep -Fq forbidOnly "$WORK/provenance-focused-run.log" ||
  { tail -20 "$WORK/provenance-focused-run.log" >&2; fail "an executed run accepted a focused test"; }
rm -rf "$PROVENANCE"

# --- End-to-end runner against a local faulty target -------------------------------------
# A scaffold from `template select` + `template scaffold` (non-default layout) runs
# ./run-tests.sh end to end: runner-lib.sh, the lane plan, readiness, the environment
# baseline, the inventory, the quarantine, inventory, and evidence gates, and every evidence
# pass. scripts/fixtures/argus-runtime/faulty-target.mjs answers GET /widgets/1 with 500
# (buggy) or the specified widget (fixed).
E="$WORK/e2e"
E2E="$FIXTURES/e2e"
E2E_ID='api:api-widget.regression.spec.ts:widget-read-returns-the-specified-widget'
E2E_HEALTH_ID='api:api-widget.regression.spec.ts:health-endpoint-reports-ok'
E2E_EV="$E/reports/outcomes.raw.tsv"
mkdir -p "$WORK/e2e-target"
"$CLI" template select --target "$WORK/e2e-target" --runtime typescript --package-manager npm \
  --test-root quality/specs --harness-root quality/support --output "$WORK/e2e-selection.json" >/dev/null
"$CLI" template scaffold --selection "$WORK/e2e-selection.json" --destination "$E" >/dev/null
# Same package-lock.json: the scaffold reuses the installed dependencies instead of a second npm ci.
mv "$T/node_modules" "$E/node_modules"
for lane in api ui perf security db resilience; do rm -f "$E/quality/specs/$lane/"*.spec.ts; done
[ -z "$(find "$E/quality/specs" -name '*.spec.ts' ! -path '*/contract/*' -print -quit)" ] || fail "e2e: an ADAPT-ME example spec survived"
cp "$E2E/widget.regression.spec.ts" "$E/quality/specs/api/widget.regression.spec.ts"
cp "$E2E/bug-ledger.json" "$E/solution/bug-ledger.json"
cp "$E2E/BUG-0001.json" "$E/solution/counterfactual/BUG-0001.json"
cp "$E2E/test-lanes.tsv" "$E2E/environment.tsv" "$E/solution/"
cp "$E2E/verify-baseline.sh" "$E/scripts/verify-baseline.sh"
# full-suite runs the surface-coverage gate, which needs a target-derived denominator plus the
# registered evidence its observations cite, rebound to this engagement's ledger.
for input in surface-inventory coverage-observations evidence-reference; do
  jq '.engagementId = "typescript-runner-e2e"' "$ROOT/scripts/fixtures/argus-coverage/$input.json" >"$E/solution/$input.json"
done
mkdir -p "$E/reports/evidence"
cp "$ROOT/scripts/fixtures/argus-coverage/reports/evidence/"* "$E/reports/evidence/"

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
  (cd "$E" && env "API_URL=$TARGET_URL" "ARGUS_READINESS_URLS=$TARGET_URL/health" "ARGUS_ASSETS=$CLI" PLAYWRIGHT_INSTALL=0 \
    ${environment[@]+"${environment[@]}"} ./run-tests.sh --mode "$mode" ${passthrough[@]+"${passthrough[@]}"}) >"$WORK/e2e-$log.log" 2>&1
  code=$?
  set -e
  if [ "$code" -ne "$expected" ]; then
    tail -60 "$WORK/e2e-$log.log" >&2
    show "$E2E_EV"
    fail "e2e $log exited $code instead of $expected"
  fi
  jq -e --arg mode "$mode" --argjson code "$expected" '.mode == $mode and .exitCode == $code' "$E/reports/argus-runner-result.json" >/dev/null ||
    fail "e2e $log: the result does not record mode $mode and exit $expected"
}

start_target buggy
e2e defect-evidence 0 defect-evidence
expect_line "$E2E_EV" "e2e live RED" "$E2E_ID" product fail true reproduced BUG-0001 expected-red
expect_line "$E2E_EV" "e2e repeat RED" "$E2E_ID.repeat" product fail true reproduced BUG-0001 expected-red-repeat
expect_line "$E2E_EV" "e2e cf-correct" "$E2E_ID.cf-correct" product pass false reproduced BUG-0001 counterfactual-correct-pass
expect_line "$E2E_EV" "e2e observed-defect tamper" "$E2E_ID.cf-observed-defect" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_line "$E2E_EV" "e2e missing-field tamper" "$E2E_ID.cf-missing-field" product fail true reproduced BUG-0001 counterfactual-tamper-red
expect_line "$E2E_EV" "e2e verified baseline" environment infrastructure pass false n/a - environment-baseline-verified
# Each pass keeps its own native evidence: the RED passes and the green cf-correct pass.
for pass in live repeat cf-correct cf-tamper-1 cf-tamper-2; do
  [ -d "$E/reports/evidence/passes/$pass/html" ] && [ -f "$E/reports/evidence/passes/$pass/results.json" ] ||
    fail "e2e: pass $pass kept no native evidence"
done
for pass in live repeat cf-tamper-1 cf-tamper-2; do
  jq -e '.stats.unexpected == 1 and .stats.expected == 0' "$E/reports/evidence/passes/$pass/results.json" >/dev/null ||
    fail "e2e: pass $pass evidence is not its own RED run"
done
jq -e '.stats.expected == 1 and .stats.unexpected == 0' "$E/reports/evidence/passes/cf-correct/results.json" >/dev/null ||
  fail "e2e: cf-correct evidence is not its own green run"

# A regression that checks only the status lets the missing-field tamper survive.
cp "$E/quality/specs/api/widget.regression.spec.ts" "$WORK/widget.regression.spec.ts"
grep -v 'argus-smoke: strict body' "$WORK/widget.regression.spec.ts" >"$E/quality/specs/api/widget.regression.spec.ts"
e2e weakened 11 defect-evidence
cp "$WORK/widget.regression.spec.ts" "$E/quality/specs/api/widget.regression.spec.ts"
expect_line "$E2E_EV" "e2e weakened regression" "$E2E_ID.cf-missing-field" automation fail false n/a BUG-0001 counterfactual-tamper-survived

# baseline stays strict green while the known bug is RED: it never selects @regression.
e2e baseline 0 baseline
expect_line "$E2E_EV" "e2e baseline test" "$E2E_HEALTH_ID" product pass false n/a - passed
expect_line "$E2E_EV" "e2e baseline api lane executed" lane.api policy pass false n/a - lane-executed
if grep -Fq -- "$E2E_ID" "$E2E_EV"; then show "$E2E_EV"; fail "e2e: baseline selected the regression"; fi

start_target fixed
e2e candidate 0 candidate-regression
expect_line "$E2E_EV" "e2e regression green" "$E2E_ID" product pass false fixed BUG-0001 regression-green
if grep -Fq -- "$E2E_HEALTH_ID" "$E2E_EV"; then show "$E2E_EV"; fail "e2e: candidate-regression selected a non-regression test"; fi
e2e full 0 full-suite
jq -e '.deliveryGate == true' "$E/reports/argus-runner-result.json" >/dev/null || fail "e2e: full-suite is not the delivery gate"
expect_line "$E2E_EV" "e2e full-suite regression" "$E2E_ID" product pass false fixed BUG-0001 regression-green
expect_line "$E2E_EV" "e2e full-suite neighbour" "$E2E_HEALTH_ID" product pass false n/a - passed
expect_line "$E2E_EV" "e2e api lane executed" lane.api policy pass false n/a - lane-executed
for lane in ui perf security db resilience; do
  expect_line "$E2E_EV" "e2e $lane lane disabled" "lane.$lane" policy pass false n/a - lane-disabled.residual.not-in-fixture
done
e2e full-narrowed 13 full-suite -- --grep x
expect_line "$E2E_EV" "e2e narrowed full-suite" runner-selection policy denied false n/a - full-suite-narrowing-forbidden

# Lane and environment decisions are enforced before any test runs.
cp "$E/solution/test-lanes.tsv" "$WORK/test-lanes.tsv"
awk 'BEGIN { FS = OFS = "\t" } $1 == "ui" { $2 = "enabled"; $5 = "-" } { print }' "$WORK/test-lanes.tsv" >"$E/solution/test-lanes.tsv"
e2e ui-without-url 13 full-suite
expect_line "$E2E_EV" "e2e ui prerequisite" lane.ui policy denied false n/a - lane-prerequisite-missing
awk 'BEGIN { FS = OFS = "\t" } $1 == "perf" { $5 = "not-yet-planned" } { print }' "$WORK/test-lanes.tsv" >"$E/solution/test-lanes.tsv"
e2e undecided-lane 13 full-suite
expect_line "$E2E_EV" "e2e undecided lane" lane.perf policy denied false n/a - lane-decision-missing
cp "$WORK/test-lanes.tsv" "$E/solution/test-lanes.tsv"
cp "$E/scripts/verify-baseline.sh" "$WORK/verify-baseline.sh"
printf '#!/usr/bin/env bash\nexit 1\n' >"$E/scripts/verify-baseline.sh"
e2e not-at-baseline 12 full-suite
cp "$WORK/verify-baseline.sh" "$E/scripts/verify-baseline.sh"
expect_line "$E2E_EV" "e2e failing verify" environment infrastructure fail false n/a - environment-not-at-baseline
stop_target

printf 'PASS  Argus TypeScript runtime: full-collection inventory, v1/v2 ledger join, ledger policy events, SD-5 classification, SD-6 live/repeat/strict/intermittent/counterfactual mapping, SD-10 counterfactual plan, adapter status, inert default, contract, data, and behaviour oracle self-tests, collection-based provenance through the inventory and quarantine gates, and an end-to-end runner against a faulty target\n'
