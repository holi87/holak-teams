#!/usr/bin/env bash
# Validate generated alignment and native configuration loading for all 49 roles.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v claude >/dev/null 2>&1 || { printf 'FAIL  Claude Code CLI is required\n' >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { printf 'FAIL  Codex CLI is required\n' >&2; exit 1; }

node "$ROOT/scripts/verify-agent-runtime-parity.mjs"
claude plugin validate --strict "$ROOT/hephaestus/claude" >/dev/null
claude plugin validate --strict "$ROOT/argus/claude" >/dev/null

mkdir "$WORK/agents"
cp "$ROOT"/hephaestus/codex/*.toml "$ROOT"/argus/codex/*.toml "$WORK/agents/"
CODEX_HOME="$WORK" codex doctor --json >"$WORK/doctor.json" || true
jq -e '.checks["config.load"].status == "ok" and ((.checks["config.load"].details["startup warnings"] // "0") == "0")' "$WORK/doctor.json" >/dev/null || {
  jq '.checks["config.load"]' "$WORK/doctor.json" >&2
  printf 'FAIL  Codex native config loader rejected the 49-agent roster\n' >&2
  exit 1
}

printf 'PASS  Native configuration load: two Claude plugins + 49 Codex TOML agents loaded without warnings; behavioral equivalence not claimed\n'
