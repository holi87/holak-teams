#!/usr/bin/env bash
# Prove that a small per-agent prompt increase cannot hide below the broad budget.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$ROOT/argus" "$WORK/argus"
approved="$(jq -r '.approvedCorpus.agents.aegis' "$WORK/argus/prompt-budgets.json")"
current="$(wc -w <"$WORK/argus/claude/agents/aegis.md" | tr -d ' ')"
extra=$((approved - current + 1))
((extra > 0)) || extra=1
printf '\n' >>"$WORK/argus/claude/agents/aegis.md"
for ((index = 0; index < extra; index += 1)); do printf 'unapproved-regression ' >>"$WORK/argus/claude/agents/aegis.md"; done
printf '\n' >>"$WORK/argus/claude/agents/aegis.md"
if node "$ROOT/scripts/check-argus-prompts.mjs" --root "$WORK" >"$WORK/output.log" 2>&1; then
  printf 'FAIL  unapproved prompt regression unexpectedly passed\n' >&2
  exit 1
fi
# Either rejection proves the point: with no approval on file the growth is unapproved, and
# with one on file the mutated corpus no longer matches the hash that was approved. Both are
# the gate refusing to accept prompt growth nobody signed for.
grep -Eq 'prompt regression requires explicit regressionApproval|regressionApproval does not match current prompt corpus' "$WORK/output.log" || {
  printf 'FAIL  prompt regression failed for an unexpected reason\n' >&2
  cat "$WORK/output.log" >&2
  exit 1
}

# A rewrite that keeps every word count identical changes no budget number at all, so the
# recorded corpus digest is the only thing standing between it and a silent edit. Prove the
# digest is read rather than merely stored.
SILENT="$(mktemp -d)"
trap 'rm -rf "$WORK" "$SILENT"' EXIT
cp -R "$ROOT/argus" "$SILENT/argus"
before="$(wc -w <"$SILENT/argus/claude/agents/aegis.md" | tr -d ' ')"
perl -0pi -e 's/Mission/Missjon/' "$SILENT/argus/claude/agents/aegis.md"
after="$(wc -w <"$SILENT/argus/claude/agents/aegis.md" | tr -d ' ')"
[ "$before" -eq "$after" ] || { printf 'FAIL  silent-edit fixture changed the word count, so it proves nothing\n' >&2; exit 1; }
if node "$ROOT/scripts/check-argus-prompts.mjs" --root "$SILENT" >"$SILENT/output.log" 2>&1; then
  printf 'FAIL  a same-length prompt rewrite passed unnoticed\n' >&2
  exit 1
fi
grep -Fq 'approvedCorpus.sha256 does not match the current corpus' "$SILENT/output.log" || {
  printf 'FAIL  same-length rewrite was rejected for an unexpected reason\n' >&2
  cat "$SILENT/output.log" >&2
  exit 1
}

printf 'PASS  Unapproved per-agent prompt regression and same-length silent rewrite both rejected\n'
