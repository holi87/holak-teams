#!/usr/bin/env bash
# Validate that all prompt-required Argus assets survive marketplace packaging.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/argus/claude"
MODE="${1:---static}"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

"$ROOT/scripts/sync-argus-runtime-assets.mjs" --check
"$PLUGIN/bin/argus-assets" verify
node "$PLUGIN/templates/typescript/scripts/hunt-driver.mjs" --help >/dev/null

if command -v claude >/dev/null 2>&1; then
  claude plugin validate --strict "$PLUGIN" >/dev/null
else
  [ "$MODE" != "--installed" ] || fail "claude CLI is required for --installed"
fi

printf 'PASS  Argus runtime assets static contract\n'

case "$MODE" in
  --static)
    exit 0
    ;;
  --installed)
    ;;
  *)
    fail "usage: $0 [--static|--installed]"
    ;;
esac

command -v claude >/dev/null 2>&1 || fail "claude CLI is required for --installed"

CONFIG_DIR="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$CONFIG_DIR" "$WORK_DIR"' EXIT

CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin marketplace add "$ROOT" >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin install argus@holak-teams --scope user >/dev/null

INSTALLED_PLUGIN="$(find "$CONFIG_DIR/plugins/cache/holak-teams/argus" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$INSTALLED_PLUGIN" ] && [ -d "$INSTALLED_PLUGIN" ] || fail "clean marketplace install did not create an Argus plugin cache"

if find "$INSTALLED_PLUGIN" -type l -print -quit | grep -q .; then
  fail "installed plugin contains a symlink instead of self-contained assets"
fi

(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" verify)
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template typescript "$WORK_DIR/typescript")
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template java "$WORK_DIR/java")
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template python "$WORK_DIR/python")
mkdir "$WORK_DIR/driver-target"
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-browser-driver "$WORK_DIR/driver-target")

(
  cd "$WORK_DIR"
  node typescript/scripts/hunt-driver.mjs --help >/dev/null
  node driver-target/scripts/hunt-driver.mjs --help >/dev/null
  printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/typescript","tool_input":{"file_path":"tests/smoke.spec.ts"}}' | node typescript/scripts/app-source-guard.mjs
  if printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/typescript","tool_input":{"file_path":"app/source.ts"}}' | node typescript/scripts/app-source-guard.mjs >/dev/null 2>&1; then
    fail "packaged app-source guard allowed an application-source write"
  fi
  SMOKE=1 node typescript/scripts/bug-coverage.mjs >/dev/null 2>&1
  SMOKE=1 node typescript/scripts/baseline-coverage.mjs >/dev/null 2>&1
  bash -n typescript/run-tests.sh java/run-tests.sh python/run-tests.sh
  test -f driver-target/scripts/driver-config.schema.json
  test -f typescript/solution/bug-ledger.example.json
)

printf 'PASS  clean marketplace install runs packaged assets outside repository\n'
