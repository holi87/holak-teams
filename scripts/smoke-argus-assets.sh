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
test -f "$PLUGIN/hooks/hooks.json" || fail "plugin does not package hooks/hooks.json"
jq -e '.hooks.PreToolUse[] | select(.matcher == "Write|Edit|MultiEdit|Bash")' "$PLUGIN/hooks/hooks.json" >/dev/null || fail "plugin hook does not cover direct and shell writes"

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
test -f "$INSTALLED_PLUGIN/hooks/hooks.json" || fail "clean marketplace install omitted the PreToolUse hook"

if find "$INSTALLED_PLUGIN" -type l -print -quit | grep -q .; then
  fail "installed plugin contains a symlink instead of self-contained assets"
fi

(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" verify)
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template typescript "$WORK_DIR/typescript")
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template java "$WORK_DIR/java")
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template python "$WORK_DIR/python")
mkdir "$WORK_DIR/driver-target"
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-browser-driver "$WORK_DIR/driver-target")
mkdir "$WORK_DIR/preflight-target"
mkdir "$WORK_DIR/preflight-target/ai_agents_internal"
cp "$ROOT/scripts/fixtures/argus-authorization/full.json" "$WORK_DIR/preflight-target/ai_agents_internal/authorization.json"
(
  cd "$WORK_DIR"
  "$INSTALLED_PLUGIN/bin/argus-assets" preflight \
    --target "$WORK_DIR/preflight-target" \
    --mode A \
    --authorization "$WORK_DIR/preflight-target/ai_agents_internal/authorization.json" \
    --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" authorization check \
    --manifest "$WORK_DIR/preflight-target/ai_agents_internal/authorization.json" \
    --lane hermes --action load --target "$WORK_DIR/preflight-target" \
    --source-trust user --rate 1 --concurrency 1 --total-requests 10 --duration 10 \
    --at 2026-07-10T12:00:00.000Z \
    >/dev/null
  printf '%s\n' '{"password":"installed-secret","email":"installed@example.com"}' | \
    "$INSTALLED_PLUGIN/bin/argus-assets" redact --input - --output "$WORK_DIR/preflight-target/redacted.json" \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" engagement validate \
    --manifest "$WORK_DIR/preflight-target/ai_agents_internal/engagement.json" \
    >/dev/null
  allocation="$("$INSTALLED_PLUGIN/bin/argus-assets" engagement allocate \
    --manifest "$WORK_DIR/preflight-target/ai_agents_internal/engagement.json" --lane kleio)"
  lease="$(jq -r .token <<<"$allocation")"
  "$INSTALLED_PLUGIN/bin/argus-assets" engagement cleanup \
    --manifest "$WORK_DIR/preflight-target/ai_agents_internal/engagement.json" \
    --lane kleio --token "$lease" --outcome success \
    >/dev/null
)

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
  node - <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('preflight-target/ai_agents_internal/preflight.json', 'utf8'));
if (report.status !== 'ready' || report.summary.ready !== 27) throw new Error('installed preflight did not evaluate all 27 agents as ready');
if (!report.engagement?.hookPackaged || !report.engagement?.sha256 || report.engagement?.phase !== 'discovery') throw new Error('installed preflight did not create guarded engagement state');
NODE
  if grep -Fq 'installed-secret' preflight-target/redacted.json; then
    fail "installed redactor leaked a secret"
  fi
  test -f preflight-target/ai_agents_internal/authorization-audit.jsonl
  test -f preflight-target/ai_agents_internal/engagement.json
  test -f preflight-target/ai_agents_internal/engagement-state.json
  denied="$(printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/preflight-target","tool_input":{"file_path":"app/source.ts","content":"installed-secret"}}' | \
    "$INSTALLED_PLUGIN/bin/argus-assets" guard)"
  grep -Fq 'GUARD-TARGET-IMMUTABLE' <<<"$denied" || fail "installed guard allowed target-source mutation"
  allowed="$(printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/preflight-target","tool_input":{"file_path":"tests/installed.spec.ts","content":"safe"}}' | \
    "$INSTALLED_PLUGIN/bin/argus-assets" guard)"
  test -z "$allowed" || fail "installed guard denied generated-test output"
  if grep -Fq 'installed-secret' preflight-target/ai_agents_internal/immutability-audit.jsonl; then
    fail "installed guard audit leaked tool content"
  fi
)

printf 'PASS  clean marketplace install runs packaged assets outside repository\n'
