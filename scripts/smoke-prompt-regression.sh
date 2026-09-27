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

# (9) The approval tool derives benchmark evidence from real revisions and a real adjudicate.mjs
# discovery summary, and refuses bad evidence.
REPO="$(fresh_copy benchmark-repo)"
git_repo() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false "$@"; }
git_repo init -q
git_repo add -A
git_repo commit -qm baseline
BASE_REVISION="$(git_repo rev-parse HEAD)"
perl -0pi -e 's/Mission/Missjon/' "$REPO/argus/claude/agents/aegis.md"
git_repo commit -qam candidate
CANDIDATE_REVISION="$(git_repo rev-parse HEAD)"
# Benchmark evidence comes from the real producer: a synthetic paired comparison of the two
# revisions (modes A and B, three repeats) scored by scripts/eval/discovery/adjudicate.mjs.
# summary <name> <baseline seeds> <candidate seeds> [<extra plan fields>] writes the
# argus-eval/discovery-summary@1 to $SCRATCH/<name>.json and prints adjudicate's exit status;
# each seeds argument is the seeds every faulty run confirms per mode, as {"A":n,"B":n}.
summary() {
  local name="$1" work="$SCRATCH/eval-$1" extra="${4:-}" plan status
  [ -n "$extra" ] || extra='{}'
  mkdir -p "$work"
  plan="$(jq -nc --arg base "$BASE_REVISION" --arg candidate "$CANDIDATE_REVISION" --argjson baseSeeds "$2" \
    --argjson candidateSeeds "$3" --argjson extra "$extra" \
    '{variants: {baseline: {revision: $base, seeds: $baseSeeds}, candidate: {revision: $candidate, seeds: $candidateSeeds}}} + $extra')"
  node "$ROOT/scripts/fixtures/argus-eval/benchmark-comparison.mjs" --work "$work" --plan "$plan" >"$work/inputs.json" \
    || fail "benchmark comparison fixture $name could not be built"
  set +e
  node "$ROOT/scripts/eval/discovery/adjudicate.mjs" --runs "$(jq -r .runs "$work/inputs.json")" \
    --verdicts "$(jq -r .verdicts "$work/inputs.json")" --output "$SCRATCH/$name.json" >"$work/adjudicate.log" 2>&1
  status=$?
  set -e
  printf '%s\n' "$status"
}
approve_benchmark() {
  node "$APPROVE" --root "$REPO" --approved-for smoke --benchmark "$1" \
    --baseline-variant baseline --candidate-variant candidate "${@:2}"
}
expect_refusal() {
  local path="$1" label="$2" message="$3"
  if approve_benchmark "$path" >"$SCRATCH/approve.log" 2>&1; then fail "approval tool accepted $label"; fi
  grep -Fq -- "$message" "$SCRATCH/approve.log" || { cat "$SCRATCH/approve.log" >&2; fail "$label was refused for an unexpected reason"; }
}
[ "$(summary regressed '{"A":3,"B":2}' '{"A":3,"B":1}')" = 0 ] || fail 'adjudicate.mjs did not score the regressed comparison'
if approve_benchmark "$SCRATCH/regressed.json" --write >"$SCRATCH/approve.log" 2>&1; then fail 'approval tool wrote a regressed approval'; fi
grep -Fq 'refusing a regressed approval in mode B: benchmark regression: meanRecall' "$SCRATCH/approve.log" \
  || { cat "$SCRATCH/approve.log" >&2; fail 'a regression in one mode was refused for an unexpected reason'; }
[ "$(summary unscored '{"A":3,"B":2}' '{"A":3,"B":2}' '{"dropVerdict":true}')" = 20 ] || fail 'adjudicate.mjs scored a comparison with a missing verdict'
expect_refusal "$SCRATCH/unscored.json" 'an UNSCORED comparison' 'discovery summary status must be "scored", found "UNSCORED"'
[ "$(summary test-mode '{"A":3,"B":2}' '{"A":3,"B":2}' '{"testMode":true}')" = 0 ] || fail 'adjudicate.mjs did not score the testMode comparison'
expect_refusal "$SCRATCH/test-mode.json" 'a testMode comparison' 'is a testMode comparison; a stub-adapter run cannot approve a corpus'
jq -n --arg base "$BASE_REVISION" --arg candidate "$CANDIDATE_REVISION" '{status: "scored", results: [], comparison: [
  {variant: "baseline", revision: $base, runs: 3, meanRecall: 0.75, meanCriticalRecall: 1, meanPrecision: 0.9},
  {variant: "candidate", revision: $candidate, runs: 3, meanRecall: 0.75, meanCriticalRecall: 1, meanPrecision: 0.9}]}' >"$SCRATCH/legacy.json"
expect_refusal "$SCRATCH/legacy.json" 'a pre-5.0 comparison document' 'the pre-5.0 comparison shape is no longer read'
# The candidate finds more in mode A and as much in mode B: every mode passes, and the recorded
# figures are each side's weakest mode.
[ "$(summary scored '{"A":3,"B":2}' '{"A":4,"B":2}')" = 0 ] || fail 'adjudicate.mjs did not score the comparison'
printf '\nuncommitted\n' >>"$REPO/argus/claude/agents/aegis.md"
expect_refusal "$SCRATCH/scored.json" 'prompts that differ from the candidate revision' "differ from candidate revision $CANDIDATE_REVISION"
git_repo checkout -q -- argus/claude/agents/aegis.md
approve_benchmark "$SCRATCH/scored.json" --write >"$SCRATCH/approve.log" 2>&1 || { cat "$SCRATCH/approve.log" >&2; fail 'approval tool refused valid benchmark evidence'; }
jq -e --arg base "$CORPUS_SHA" --arg comparison "$(shasum -a 256 "$SCRATCH/scored.json" | cut -d' ' -f1)" \
  --arg baseRevision "$BASE_REVISION" --arg candidateRevision "$CANDIDATE_REVISION" --slurpfile summary "$SCRATCH/scored.json" '
  ($summary[0].variants | map({key: .name, value: .perMode}) | from_entries) as $modes
  | .approvedCorpus as $corpus | $corpus.benchmark
  | .status == "non-regressed" and .comparisonSha256 == $comparison and .adjudicatedAt == $summary[0].createdAt[0:10]
    and .baseline.revision == $baseRevision and .baseline.corpusSha256 == $base
    and .candidate.revision == $candidateRevision and .candidate.corpusSha256 == $corpus.sha256
    and $corpus.sha256 != $base
    and .baseline.runs == 3 and .candidate.runs == 3
    and .baseline.meanRecall == $modes.baseline.B.meanRecall and .candidate.meanRecall == $modes.candidate.B.meanRecall
    and .candidate.meanRecall < $modes.candidate.A.meanRecall
    and .baseline.meanPrecision == $modes.baseline.B.pooledPrecision and .candidate.meanPrecision == $modes.candidate.B.pooledPrecision' \
  "$REPO/argus/prompt-budgets.json" >/dev/null \
  || fail 'approval tool recorded evidence that does not match the revisions and the per-mode minima of the discovery summary'
expect_pass "$REPO" 'approved benchmark evidence' 'benchmark non-regressed'

printf 'PASS  Prompt corpus approval: agent and profile rewrites rejected, pending expiry, benchmark binding and non-regression enforced, release gate never skips approval\n'
