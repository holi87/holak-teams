#!/usr/bin/env bash
# Argus QA one-command test runner — Playwright + TS (API + UI).
# Produces framework reports plus reports/argus-runner-result.json. Exit codes follow
# RUNNER-CONTRACT.md (0, 10-15), not framework-native codes.
set -euo pipefail
cd "$(dirname "$0")"

MODE=full-suite
if [ "${1:-}" = --mode ]; then MODE="${2:-}"; shift 2; fi
if [ "${1:-}" = -- ]; then shift; fi
case "$MODE" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) echo "INVALID RUNNER MODE: $MODE" >&2; exit 14 ;; esac
EVENTS="${ARGUS_OUTCOME_FILE:-reports/outcomes.raw.tsv}"
RESULT="reports/argus-runner-result.json"
TEST_ROOT="${ARGUS_TEST_ROOT:-tests}"
mkdir -p reports reports/evidence
rm -f "$EVENTS"

emit_event() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$EVENTS"; }
finish_contract() {
  set +e
  scripts/runner-contract.sh --mode "$MODE" --events "$EVENTS" --output "$RESULT" --runner-exit "$1"
  contract_code=$?
  set -e
  echo "Argus contract: mode=$MODE result=$RESULT exit=$contract_code"
  exit "$contract_code"
}
unexpected_error() {
  trap - ERR
  emit_event wrapper infrastructure fail false n/a - wrapper-command-failed
  finish_contract 1
}
trap unexpected_error ERR

SELECTION="ai_agents_internal/template-selection.json"
if [ ! -f "$SELECTION" ] || ! grep -Fq '"runtime": "typescript"' "$SELECTION" || ! grep -Fq '"packageManager": "npm"' "$SELECTION" || ! grep -Fq '"choiceSource": "explicit-user"' "$SELECTION"; then
  emit_event template-selection policy denied false n/a - template-selection-missing-or-incompatible
  finish_contract 1
fi

MODE_ARGS=()
case "$MODE" in
  baseline) MODE_ARGS=(--grep-invert '@bug:BUG-[0-9]{4}|@quarantine') ;;
  defect-evidence|candidate-regression) MODE_ARGS=(--grep '@bug:BUG-[0-9]{4}' --grep-invert '@quarantine') ;;
  full-suite) MODE_ARGS=(--grep-invert '@quarantine') ;;
esac

tagged_count="$({ grep -Roh '@quarantine' "$TEST_ROOT" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' || true; } | wc -l | tr -d ' ')"
if ! scripts/quarantine-contract.sh --events "$EVENTS" --tagged-count "$tagged_count"; then finish_contract 1; fi

: "${API_URL:=http://localhost:3001}"
: "${UI_URL:=http://localhost:3000}"
export API_URL UI_URL

echo "Argus QA tests → API_URL=$API_URL UI_URL=$UI_URL"

# Install deps once (idempotent). For the newest: npm i -D @playwright/test@latest
# Determinism: `npm ci` installs EXACTLY package-lock.json. We never silently fall back
# to `npm install` (which can mutate the lockfile and drift versions under our feet).
# A drifting install is an explicit, LOGGED decision via ALLOW_NPM_INSTALL=1.
if [ ! -d node_modules ]; then
  if npm ci; then
    :
  elif [ "${ALLOW_NPM_INSTALL:-0}" = "1" ]; then
    echo "WARNING: npm ci failed; ALLOW_NPM_INSTALL=1 set → falling back to 'npm install' (may update package-lock.json — NON-DETERMINISTIC)." >&2
    npm install
  else
    echo "INSTALL FAILED: 'npm ci' did not succeed and node_modules is absent." >&2
    echo "Fix package-lock.json (commit it / run 'npm install' locally and commit the lock), or re-run with ALLOW_NPM_INSTALL=1 to accept a non-deterministic 'npm install'." >&2
    emit_event install infrastructure fail false n/a - npm-ci-failed
    finish_contract 1
  fi
  if [ "${PLAYWRIGHT_INSTALL:-1}" = "1" ]; then npx playwright install --with-deps chromium; fi
fi

# Environment readiness — fail fast with a distinct message instead of a wall of misleading red.
for url in $([ "${ARGUS_CONTRACT_SMOKE:-0}" = "1" ] && printf '' || printf '%s %s' "$API_URL" "$UI_URL"); do
  ok=""
  for _ in $(seq 1 10); do
    if curl -sf --max-time 3 -o /dev/null "$url"; then ok=1; break; fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    echo "ENVIRONMENT NOT READY: $url is not responding — start the stack first (docker compose up -d?)." >&2
    emit_event readiness infrastructure fail false n/a - target-not-ready
    finish_contract 1
  fi
done

# Typecheck gate — Playwright strips types without checking them; a suite that
# doesn't typecheck doesn't run (catches hallucinated/wrong-typed APIs early).
echo "Typecheck (tsc --noEmit)…"
if ! npx tsc --noEmit; then
  emit_event typecheck automation fail false n/a - typescript-compile-failed
  finish_contract 1
fi

# Run all projects (setup + api + regression + ui). Args pass through, e.g. ./run-tests.sh --project=api
set +e
npx playwright test "${MODE_ARGS[@]}" "$@"
pw_code=$?

bug_gate_code=0
if [ "${ARGUS_CONTRACT_SMOKE:-0}" != "1" ] && [ "$MODE" != baseline ]; then
  node scripts/bug-coverage.mjs
  bug_gate_code=$?
  [ "$bug_gate_code" -eq 0 ] || emit_event bug-coverage automation fail false n/a - bug-coverage-gate-failed
fi

baseline_gate_code=0
if [ "${ARGUS_CONTRACT_SMOKE:-0}" != "1" ] && { [ "$MODE" = baseline ] || [ "$MODE" = full-suite ]; }; then
  node scripts/baseline-coverage.mjs
  baseline_gate_code=$?
  [ "$baseline_gate_code" -eq 0 ] || emit_event baseline-coverage automation fail false n/a - baseline-coverage-gate-failed
fi
set -e

echo ""
echo "Reports: reports/html/index.html (npm run report)  |  reports/results.json"
echo "Summary: reports/summary.json"

native_code=0
if [ "$pw_code" -ne 0 ] || [ "$bug_gate_code" -ne 0 ] || [ "$baseline_gate_code" -ne 0 ]; then native_code=1; fi
finish_contract "$native_code"
