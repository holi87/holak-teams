#!/usr/bin/env bash
# Prove that strict marketplace validation rejects representative release drift.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

node "$ROOT/scripts/validate-marketplace-contracts.mjs"

expect_failure() {
  local name="$1" mutation="$2" fixture
  fixture="$WORK/$name"
  mkdir -p "$fixture"
  cp -R "$ROOT/.claude-plugin" "$ROOT/argus" "$ROOT/hephaestus" "$fixture/"
  bash -c "$mutation" _ "$fixture"
  if node "$ROOT/scripts/validate-marketplace-contracts.mjs" --root "$fixture" >"$WORK/$name.log" 2>&1; then
    fail "$name fixture unexpectedly passed"
  fi
}

expect_failure version-mismatch \
  'jq '\''(.plugins[] | select(.name == "argus").version) = "9.9.9"'\'' "$1/.claude-plugin/marketplace.json" >"$1/marketplace.tmp" && mv "$1/marketplace.tmp" "$1/.claude-plugin/marketplace.json"'
expect_failure missing-plugin-source \
  'rm -rf "$1/argus/claude"'
expect_failure bad-plugin-path \
  'jq '\''(.plugins[] | select(.name == "argus").source) = "../outside"'\'' "$1/.claude-plugin/marketplace.json" >"$1/marketplace.tmp" && mv "$1/marketplace.tmp" "$1/.claude-plugin/marketplace.json"'
expect_failure unsupported-tool \
  'sed -i.bak '\''s/^tools: /tools: ImaginaryTool, /'\'' "$1/argus/claude/agents/aegis.md" && rm "$1/argus/claude/agents/aegis.md.bak"'
expect_failure unsupported-frontmatter \
  'perl -0pi -e '\''s/(^color:[^\n]*\n)/$1hooks: forbidden-inline-hook\n/m'\'' "$1/argus/claude/agents/aegis.md"'
expect_failure roster-drift \
  'rm "$1/argus/claude/agents/aegis.md"'
expect_failure duplicate-slug \
  'cp "$1/argus/claude/agents/aegis.md" "$1/argus/claude/agents/duplicate.md"'
expect_failure nested-agent \
  'mkdir "$1/argus/claude/agents/nested" && mv "$1/argus/claude/agents/aegis.md" "$1/argus/claude/agents/nested/aegis.md"'

printf 'PASS  Negative marketplace fixtures: version, asset, path, tool/frontmatter, roster, duplicate, and flat-layout drift rejected\n'
