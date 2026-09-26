#!/usr/bin/env bash
# Prove the prompt corpus approval gate: any agent or doctrine-profile edit breaks the approved
# digest, a pending approval expires with the release it names, benchmark evidence must bind the
# approved corpus and show no regression, and the release gate never skips the approval check.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/check-argus-prompts.mjs"
APPROVE="$ROOT/scripts/approve-argus-prompts.mjs"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

repeat() { local out='' index; for ((index = 0; index < $2; index += 1)); do out+="$1"; done; printf '%s' "$out"; }

restamp_pending() {
  node "$APPROVE" --root "$1" --write --benchmark-pending x --approved-for smoke "${@:2}" >/dev/null 2>&1 \
    || fail "approve-argus-prompts.mjs could not re-stamp $1"
}

# Every fixture starts from a freshly approved, passing copy, so each rejection below is caused
# by its own mutation and not by the approval state committed in the repository.
fresh_copy() {
  local work="$SCRATCH/$1"
  mkdir -p "$work"
  cp -R "$ROOT/argus" "$work/argus"
  restamp_pending "$work"
  node "$CHECK" --root "$work" >"$work/control.log" 2>&1 || { cat "$work/control.log" >&2; fail "$1: re-approved control copy does not pass"; }
  printf '%s\n' "$work"
}

word_count() { wc -w <"$1" | tr -d ' '; }

expect_rejection() {
  local work="$1" label="$2" message="$3"
  if node "$CHECK" --root "$work" >"$work/output.log" 2>&1; then
    fail "$label unexpectedly passed"
  fi
  grep -Fq -- "$message" "$work/output.log" || { cat "$work/output.log" >&2; fail "$label was rejected for an unexpected reason"; }
}

expect_pass() {
  local work="$1" label="$2" message="$3"
  node "$CHECK" --root "$work" >"$work/output.log" 2>&1 || { cat "$work/output.log" >&2; fail "$label was rejected"; }
  grep -Fq -- "$message" "$work/output.log" || { cat "$work/output.log" >&2; fail "$label passed without: $message"; }
}

# Replace approvedCorpus.benchmark with valid non-regressed evidence for the corpus in <work>,
# then apply the jq update <filter> to that benchmark object.
stamp_benchmark() {
  local work="$1" filter="$2" sha
  sha="$(node "$CHECK" --root "$work" --print-corpus | jq -r .sha256)"
  jq --arg sha "$sha" --arg comparison "$(repeat a 64)" --arg baseRevision "$(repeat b 40)" \
    --arg candidateRevision "$(repeat c 40)" --arg baseSha "$(repeat d 64)" '
    .approvedCorpus.benchmark = {
      status: "non-regressed",
      comparisonSha256: $comparison,
      adjudicatedAt: "2026-09-01",
      baseline: {revision: $baseRevision, corpusSha256: $baseSha, runs: 3, meanRecall: 0.8, meanCriticalRecall: 1, meanPrecision: 0.9},
      candidate: {revision: $candidateRevision, corpusSha256: $sha, runs: 3, meanRecall: 0.8, meanCriticalRecall: 1, meanPrecision: 0.86}
    }' "$work/argus/prompt-budgets.json" | jq "$filter" >"$work/prompt-budgets.next.json"
  mv "$work/prompt-budgets.next.json" "$work/argus/prompt-budgets.json"
}

CORPUS_SHA="$(node "$CHECK" --print-corpus | jq -r .sha256)"
[[ "$CORPUS_SHA" =~ ^[0-9a-f]{64}$ ]] || fail '--print-corpus did not print the corpus JSON'

# (1) Appended words in one agent change the digest; re-stamping is the only way back to green.
WORK="$(fresh_copy appended)"
printf '\nunapproved-regression unapproved-regression\n' >>"$WORK/argus/claude/agents/aegis.md"
expect_rejection "$WORK" 'appended aegis words' 'approvedCorpus.sha256 does not match the current corpus'
grep -Fq 're-approve with scripts/approve-argus-prompts.mjs or restore it' "$WORK/output.log" || fail 'sha mismatch does not name the approval tool'
restamp_pending "$WORK"
expect_pass "$WORK" 're-stamped appended corpus' 'WARN  prompt corpus approved for'

# (2) A rewrite that keeps every word count identical changes no budget number at all, so the
# corpus digest is the only thing standing between it and a silent edit.
WORK="$(fresh_copy silent-agent)"
before="$(word_count "$WORK/argus/claude/agents/aegis.md")"
perl -0pi -e 's/Mission/Missjon/' "$WORK/argus/claude/agents/aegis.md"
[ "$before" -eq "$(word_count "$WORK/argus/claude/agents/aegis.md")" ] || fail 'silent agent fixture changed the word count, so it proves nothing'
expect_rejection "$WORK" 'same-length aegis rewrite' 'approvedCorpus.sha256 does not match the current corpus'

# (3) The same silent rewrite inside a preloaded doctrine profile: profiles are part of the digest.
WORK="$(fresh_copy silent-profile)"
before="$(word_count "$WORK/argus/shared-skills/qa-core/SKILL.md")"
for skill in "$WORK/argus/shared-skills/qa-core/SKILL.md" "$WORK/argus/claude/skills/qa-core/SKILL.md"; do
  perl -0pi -e 's/Apply this contract/Apply thiz contract/' "$skill"
done
[ "$before" -eq "$(word_count "$WORK/argus/shared-skills/qa-core/SKILL.md")" ] || fail 'silent profile fixture changed the word count, so it proves nothing'
cmp -s "$ROOT/argus/shared-skills/qa-core/SKILL.md" "$WORK/argus/shared-skills/qa-core/SKILL.md" && fail 'silent profile fixture did not change qa-core'
expect_rejection "$WORK" 'same-length qa-core rewrite' 'approvedCorpus.sha256 does not match the current corpus'

# (4) A pending approval is bound to one Argus release and expires when the version moves.
WORK="$(fresh_copy expired)"
restamp_pending "$WORK" --release 0.0.1
expect_rejection "$WORK" 'expired pending approval' 'pending benchmark approval expired: approved for 0.0.1, Argus is'

# (5) Benchmark evidence whose candidate recall fell below the baseline.
WORK="$(fresh_copy regressed)"
stamp_benchmark "$WORK" '.approvedCorpus.benchmark.candidate.meanRecall = 0.7'
expect_rejection "$WORK" 'regressed benchmark evidence' 'benchmark regression: meanRecall 0.7 < 0.8 - 0'

# (6) Benchmark evidence measured on a different corpus than the one approved.
WORK="$(fresh_copy foreign-evidence)"
stamp_benchmark "$WORK" ".approvedCorpus.benchmark.candidate.corpusSha256 = \"$(repeat e 64)\""
expect_rejection "$WORK" 'benchmark evidence for another corpus' 'benchmark evidence does not match the approved corpus'

# Evidence integrity beyond the headline metrics.
WORK="$(fresh_copy too-few-runs)"
stamp_benchmark "$WORK" '.approvedCorpus.benchmark.baseline.runs = 2'
expect_rejection "$WORK" 'benchmark with too few repeats' 'benchmark baseline has 2 runs; nonRegression.minRepeats is 3'
WORK="$(fresh_copy same-corpus)"
stamp_benchmark "$WORK" '.approvedCorpus.benchmark.baseline.corpusSha256 = .approvedCorpus.benchmark.candidate.corpusSha256'
expect_rejection "$WORK" 'benchmark comparing a corpus with itself' 'benchmark baseline and candidate share one corpus sha256'

# (7) Valid evidence: precision within tolerance, recall held, critical recall compared.
WORK="$(fresh_copy non-regressed)"
stamp_benchmark "$WORK" '.'
expect_pass "$WORK" 'valid benchmark evidence' "PASS  Prompt corpus approval: ${CORPUS_SHA:0:12}, benchmark non-regressed"
grep -Fq 'WARN' "$WORK/output.log" && fail 'non-regressed approval still printed a pending warning'
stamp_benchmark "$WORK" '.approvedCorpus.benchmark.baseline.meanCriticalRecall = null | .approvedCorpus.benchmark.candidate.meanCriticalRecall = 0'
expect_pass "$WORK" 'benchmark without a baseline critical recall' 'benchmark non-regressed'

# (8) The development-only skip flag never reaches the release gate.
for gate in "$ROOT/scripts/validate-release.sh" "$ROOT/scripts/verify-agents.sh" "$ROOT"/.github/workflows/*.yml; do
  [ -f "$gate" ] || continue
  if grep -Fq -- '--skip-corpus-approval' "$gate"; then fail "${gate#"$ROOT"/} passes --skip-corpus-approval"; fi
done
WORK="$(fresh_copy skip-flag)"
printf '\nunapproved-regression\n' >>"$WORK/argus/claude/agents/aegis.md"
node "$CHECK" --root "$WORK" --skip-corpus-approval >"$WORK/output.log" 2>&1 || { cat "$WORK/output.log" >&2; fail '--skip-corpus-approval still ran the approval check'; }
grep -Fq 'SKIP  corpus approval (development only; the release gate never passes this flag)' "$WORK/output.log" || fail '--skip-corpus-approval did not announce the skip'

# (9) The approval tool derives benchmark evidence from real revisions and refuses bad evidence.
REPO="$(fresh_copy benchmark-repo)"
git_repo() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false "$@"; }
git_repo init -q
git_repo add -A
git_repo commit -qm baseline
BASE_REVISION="$(git_repo rev-parse HEAD)"
perl -0pi -e 's/Mission/Missjon/' "$REPO/argus/claude/agents/aegis.md"
git_repo commit -qam candidate
CANDIDATE_REVISION="$(git_repo rev-parse HEAD)"
adjudication() {
  jq -n --arg base "$BASE_REVISION" --arg candidate "$CANDIDATE_REVISION" --arg status "$1" --argjson recall "$2" '{
    status: $status, results: [],
    comparison: [
      {variant: "baseline", revision: $base, runs: 3, meanRecall: 0.75, meanCriticalRecall: 1, meanPrecision: 0.9, totalCost: 1, totalTokens: 10},
      {variant: "candidate", revision: $candidate, runs: 3, meanRecall: $recall, meanCriticalRecall: 1, meanPrecision: 0.9, totalCost: 1, totalTokens: 10}
    ]}'
}
approve_benchmark() {
  node "$APPROVE" --root "$REPO" --approved-for smoke --benchmark "$1" \
    --baseline-variant baseline --candidate-variant candidate --adjudicated-at 2026-09-01 "${@:2}"
}
adjudication scored 0.5 >"$SCRATCH/regressed.json"
if approve_benchmark "$SCRATCH/regressed.json" --write >"$SCRATCH/approve.log" 2>&1; then fail 'approval tool wrote a regressed approval'; fi
grep -Fq 'refusing a regressed approval: benchmark regression: meanRecall 0.5 < 0.75 - 0' "$SCRATCH/approve.log" || { cat "$SCRATCH/approve.log" >&2; fail 'regressed approval refused for an unexpected reason'; }
adjudication UNSCORED 0.75 >"$SCRATCH/unscored.json"
if approve_benchmark "$SCRATCH/unscored.json" >"$SCRATCH/approve.log" 2>&1; then fail 'approval tool accepted an unscored comparison'; fi
grep -Fq 'adjudication status must be "scored"' "$SCRATCH/approve.log" || { cat "$SCRATCH/approve.log" >&2; fail 'unscored comparison refused for an unexpected reason'; }
adjudication scored 0.75 >"$SCRATCH/scored.json"
printf '\nuncommitted\n' >>"$REPO/argus/claude/agents/aegis.md"
if approve_benchmark "$SCRATCH/scored.json" >"$SCRATCH/approve.log" 2>&1; then fail 'approval tool accepted prompts that differ from the candidate revision'; fi
grep -Fq "differ from candidate revision $CANDIDATE_REVISION" "$SCRATCH/approve.log" || { cat "$SCRATCH/approve.log" >&2; fail 'dirty candidate refused for an unexpected reason'; }
git_repo checkout -q -- argus/claude/agents/aegis.md
approve_benchmark "$SCRATCH/scored.json" --write >"$SCRATCH/approve.log" 2>&1 || { cat "$SCRATCH/approve.log" >&2; fail 'approval tool refused valid benchmark evidence'; }
jq -e --arg base "$CORPUS_SHA" --arg comparison "$(shasum -a 256 "$SCRATCH/scored.json" | cut -d' ' -f1)" \
  --arg baseRevision "$BASE_REVISION" --arg candidateRevision "$CANDIDATE_REVISION" '
  .approvedCorpus as $corpus | $corpus.benchmark
  | .status == "non-regressed" and .comparisonSha256 == $comparison and .adjudicatedAt == "2026-09-01"
    and .baseline.revision == $baseRevision and .baseline.corpusSha256 == $base
    and .candidate.revision == $candidateRevision and .candidate.corpusSha256 == $corpus.sha256
    and $corpus.sha256 != $base' "$REPO/argus/prompt-budgets.json" >/dev/null \
  || fail 'approval tool recorded evidence that does not match the revisions and adjudication'
expect_pass "$REPO" 'approved benchmark evidence' 'benchmark non-regressed'

printf 'PASS  Prompt corpus approval: agent and profile rewrites rejected, pending expiry, benchmark binding and non-regression enforced, release gate never skips approval\n'
