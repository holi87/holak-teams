#!/usr/bin/env bash
# Clean-room validation of the TypeScript outcome adapter (RUNNER-CONTRACT.md SD-1 to SD-7):
# collection inventory, ledger join for ledger v1 and v2, expected bugs, SD-4 ledger events,
# SD-5 classification, SD-6 pass mapping including declared repetition, the adapter status,
# and inertness without ARGUS_RUNNER_MODE. Nothing contacts a real target; no browser is
# needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-runtime/typescript"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

T="$WORK/typescript"
REPORTER=./scripts/argus-playwright-reporter.mjs
SPEC=tests/contract/classification.spec.ts
LEDGER="$T/solution/bug-ledger.json"
ID='contract-smoke:contract-classification.spec.ts:'
SRC="$SPEC:"

# The adapter reads its activation from the environment; a caller's values must not leak in.
unset ARGUS_RUNNER_MODE ARGUS_EVIDENCE_PASS ARGUS_INVENTORY_ONLY ARGUS_OUTCOME_FILE \
  ARGUS_CONTRACT_SMOKE ARGUS_SMOKE_UNSET_PREREQUISITE

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
cp "$FIXTURES/bug-ledger.json" "$LEDGER"
cp "$LEDGER" "$WORK/bug-ledger.json"
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
[ ! -e "$T/reports/test-inventory.tsv" ] && [ ! -e "$T/reports/expected-bugs.txt" ] || fail "a collection error published inventory artifacts"
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

for activation in "ARGUS_RUNNER_MODE=defect-evidence ARGUS_EVIDENCE_PASS=bogus" "ARGUS_RUNNER_MODE=full-suite ARGUS_EVIDENCE_PASS=repeat"; do
  # shellcheck disable=SC2086 # the activation pairs are split on purpose
  pw unsupported-pass $activation npx playwright test --project=contract-smoke "--reporter=$REPORTER" --grep collision "$SPEC"
  [ "$PW_CODE" -ne 0 ] || fail "an unsupported evidence pass did not fail the run ($activation)"
  [ ! -e "$T/reports/outcomes.raw.tsv" ] || fail "an unsupported evidence pass emitted events ($activation)"
  expect_status 'error [0-9]+' "unsupported evidence pass ($activation)"
done

printf 'PASS  Argus TypeScript runtime adapter: full-collection inventory, v1/v2 ledger join, ledger policy events, SD-5 classification, SD-6 live/repeat/strict/intermittent mapping, adapter status, and inert default\n'
