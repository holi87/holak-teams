#!/usr/bin/env bash
# Prove that a small per-agent prompt increase cannot hide below the broad budget.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$ROOT/argus" "$WORK/argus"
printf '\nUnapproved regression marker.\n' >>"$WORK/argus/claude/agents/aegis.md"
if node "$ROOT/scripts/check-argus-prompts.mjs" --root "$WORK" >"$WORK/output.log" 2>&1; then
  printf 'FAIL  unapproved prompt regression unexpectedly passed\n' >&2
  exit 1
fi
grep -Fq 'prompt regression requires explicit regressionApproval' "$WORK/output.log" || {
  printf 'FAIL  prompt regression failed for an unexpected reason\n' >&2
  cat "$WORK/output.log" >&2
  exit 1
}

printf 'PASS  Unapproved per-agent prompt regression rejected below the broad corpus budget\n'
