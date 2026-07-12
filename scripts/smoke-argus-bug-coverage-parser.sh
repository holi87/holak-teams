#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/scripts/fixtures/argus-templates/bug-coverage"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

canonical="$ROOT/argus/framework-template/scripts/bug-coverage.mjs"
packaged="$ROOT/argus/claude/templates/typescript/scripts/bug-coverage.mjs"
cmp "$canonical" "$packaged" >/dev/null || fail 'packaged parser drifted from the canonical TypeScript template'

for variant in canonical packaged; do
  case "$variant" in
    canonical) parser="$canonical" ;;
    packaged) parser="$packaged" ;;
  esac
  target="$WORK/$variant"
  mkdir -p "$target/scripts" "$target/tests/contract" "$target/solution"
  cp "$parser" "$target/scripts/bug-coverage.mjs"
  cp "$FIXTURES/positive.spec.ts" "$target/tests/contract/positive.spec.ts"
  cp "$FIXTURES/positive-alias.spec.ts" "$target/tests/contract/positive-alias.spec.ts"
  cp "$FIXTURES/positive-custom-fixture.spec.ts" "$target/tests/contract/positive-custom-fixture.spec.ts"
  cp "$FIXTURES/negative.spec.ts" "$target/tests/contract/negative.spec.ts"
  cp "$FIXTURES/ledger.json" "$target/solution/bug-ledger.json"
  (cd "$target" && node scripts/bug-coverage.mjs >/dev/null)
  jq -e '
    .bug_coverage.status == "pass" and
    .bug_coverage.total_confirmed == 4 and
    .bug_coverage.wired_confirmed == 4 and
    .bug_coverage.uncovered == [] and
    .bug_coverage.errors == []
  ' "$target/reports/summary.json" >/dev/null || fail "$variant parser produced the wrong coverage result"

  disabled_target="$WORK/$variant-disabled"
  mkdir -p "$disabled_target/scripts" "$disabled_target/tests/contract" "$disabled_target/solution"
  cp "$parser" "$disabled_target/scripts/bug-coverage.mjs"
  cp "$FIXTURES/disabled.spec.ts" "$disabled_target/tests/contract/disabled.spec.ts"
  cp "$FIXTURES/disabled-ledger.json" "$disabled_target/solution/bug-ledger.json"
  if (cd "$disabled_target" && node scripts/bug-coverage.mjs >/dev/null 2>&1); then
    fail "$variant parser counted disabled or expected-failure tests as confirmed coverage"
  fi
  jq -e '
    .bug_coverage.status == "fail" and
    .bug_coverage.total_confirmed == 3 and
    .bug_coverage.wired_confirmed == 0 and
    .bug_coverage.uncovered == ["BUG-9101", "BUG-9102", "BUG-9103"] and
    (.bug_coverage.errors | any(contains("uncovered confirmed bugs")))
  ' "$disabled_target/reports/summary.json" >/dev/null || fail "$variant parser did not leave disabled coverage explicitly uncovered"

  shadowed_target="$WORK/$variant-shadowed"
  mkdir -p "$shadowed_target/scripts" "$shadowed_target/tests/contract" "$shadowed_target/solution"
  cp "$parser" "$shadowed_target/scripts/bug-coverage.mjs"
  cp "$FIXTURES/shadowed.spec.ts" "$shadowed_target/tests/contract/shadowed.spec.ts"
  cp "$FIXTURES/shadowed-fixtures.ts" "$shadowed_target/tests/contract/fixtures.ts"
  cp "$FIXTURES/shadowed-ledger.json" "$shadowed_target/solution/bug-ledger.json"
  if (cd "$shadowed_target" && node scripts/bug-coverage.mjs >/dev/null 2>&1); then
    fail "$variant parser counted a local helper or unapproved import as Playwright coverage"
  fi
  jq -e '
    .bug_coverage.status == "fail" and
    .bug_coverage.total_confirmed == 4 and
    .bug_coverage.wired_confirmed == 0 and
    .bug_coverage.uncovered == ["BUG-9201", "BUG-9202", "BUG-9203", "BUG-9204"] and
    (.bug_coverage.errors | any(contains("uncovered confirmed bugs")))
  ' "$shadowed_target/reports/summary.json" >/dev/null || fail "$variant parser did not reject local or unapproved test bindings"
done

printf 'PASS  Argus TypeScript bug coverage: Playwright and approved custom-fixture imports (including aliases) accepted; local/unapproved bindings, disabled tests, and non-executable metadata ignored\n'
