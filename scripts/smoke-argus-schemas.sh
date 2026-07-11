#!/usr/bin/env bash
# Validate every canonical Argus contract with valid and invalid fixtures, then prove
# engagement fragments reject malformed documents and render a human-facing summary.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
FIXTURES="$ROOT/scripts/fixtures/argus-schemas"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

node "$ROOT/scripts/validate-argus-schemas.mjs"

for kind in bug-ledger lane-plan evidence-reference automation-status surface-inventory coverage-observations coverage-result final-summary; do
  "$CLI" schema validate --kind "$kind" --input "$FIXTURES/valid/$kind.json" >/dev/null
  if "$CLI" schema validate --kind "$kind" --input "$FIXTURES/invalid/$kind.json" >/dev/null 2>&1; then
    fail "invalid $kind fixture unexpectedly passed"
  fi
done

TARGET="$WORK/target"
mkdir -p "$TARGET"
"$CLI" engagement init --target "$TARGET" --artifact-root "$TARGET" --mode A --engagement-id schema-fixture >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
KLEIO="$("$CLI" engagement allocate --manifest "$MANIFEST" --lane kleio | jq -r .token)"
MINOS="$("$CLI" engagement allocate --manifest "$MANIFEST" --lane minos | jq -r .token)"

if "$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$MINOS" --canonical solution/bug-ledger.json --id invalid --input "$FIXTURES/invalid/bug-ledger.json" >/dev/null 2>&1; then
  fail "invalid canonical fragment unexpectedly passed"
fi
if "$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/final-summary.json --id foreign --input "$FIXTURES/valid/final-summary.json" >/dev/null 2>&1; then
  fail "cross-engagement canonical fragment unexpectedly passed"
fi
jq '.engagementId = "schema-fixture"' "$FIXTURES/valid/final-summary.json" >"$WORK/final-summary.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kleio --token "$KLEIO" --canonical solution/final-summary.json --id summary --input "$WORK/final-summary.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner kleio --token "$KLEIO" --canonical solution/final-summary.json >/dev/null
grep -Fq 'Source schema: argus/final-summary@1' "$TARGET/solution/FINAL-SUMMARY.md" || fail "rendered summary has no source schema"
grep -Fq 'Execution coverage: 80%' "$TARGET/solution/FINAL-SUMMARY.md" || fail "rendered summary has no surface-derived coverage"

printf 'PASS  Argus schemas: fixtures, fragment rejection, stable IDs, and source-versioned summary\n'
