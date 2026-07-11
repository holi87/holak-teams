#!/usr/bin/env bash
# Argus QA one-command test runner — pytest + Playwright + httpx (API + UI).
# Runs every lane (api + ui + regression, plus the gated perf/security/db lanes which
# self-skip unless their env prerequisite is set) and emits ONE aggregated report set:
#   reports/html/index.html (humans) + reports/report.json + reports/junit.xml (tooling).
# Writes reports/argus-runner-result.json and returns contract exit codes 0, 10-15.
# Extra args pass straight through to pytest after an optional `--`:
#   ./run-tests.sh -m api            # API lane only
#   ./run-tests.sh -k bad_credentials -x
#   PERF_BUDGET_MS=300 ./run-tests.sh -m perf
#   WORKERS=4 ./run-tests.sh         # opt-in parallelism (pytest-xdist)
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
if [ ! -f "$SELECTION" ] || ! grep -Fq '"runtime": "python"' "$SELECTION" || ! grep -Fq '"packageManager": "pip"' "$SELECTION" || ! grep -Fq '"choiceSource": "explicit-user"' "$SELECTION"; then
  emit_event template-selection policy denied false n/a - template-selection-missing-or-incompatible
  finish_contract 1
fi

MODE_ARGS=()
case "$MODE" in
  baseline) MODE_ARGS=(-m 'not regression and not quarantine') ;;
  defect-evidence|candidate-regression) MODE_ARGS=(-m 'regression and not quarantine') ;;
  full-suite) MODE_ARGS=(-m 'not quarantine') ;;
esac

tagged_count="$({ grep -Roh 'pytest.mark.quarantine' "$TEST_ROOT" --include='*.py' || true; } | wc -l | tr -d ' ')"
if ! scripts/quarantine-contract.sh --events "$EVENTS" --tagged-count "$tagged_count"; then finish_contract 1; fi

: "${API_URL:=http://localhost:3001}"
: "${UI_URL:=http://localhost:3000}"
export API_URL UI_URL

PYTHON_BIN="${PYTHON:-python3}"
VENV=".venv"

echo "Argus QA tests → API_URL=$API_URL UI_URL=$UI_URL"

# --- Install deps once (idempotent), into a local venv ----------------------------------
# We install requirements.txt, which pins version FLOORS (lower bounds), not exact versions —
# so this venv is NOT byte-reproducible across time (unlike the TS sibling's `npm ci` vs a
# committed lock). For a reproducible install, lock once and install from it:
#   .venv/bin/python -m pip freeze > requirements.lock   # then: pip install -r requirements.lock
# (or use `uv pip compile` / `uv.lock`). To refresh deps, edit requirements.txt (and
# pyproject.toml) and delete .venv. Browsers are pre-downloaded so tests don't stall.
# (Test-execution determinism — no retries, no rerun plugin — is separate and always holds.)
if [ ! -d "$VENV" ]; then
  echo "Creating venv + installing deps…"
  "$PYTHON_BIN" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
  "$VENV/bin/python" -m pip install -r requirements.txt
  if [ "${PLAYWRIGHT_INSTALL:-1}" = "1" ]; then "$VENV/bin/python" -m playwright install --with-deps chromium; fi
fi
PYTEST=("$VENV/bin/python" -m pytest)

# --- Environment readiness — fail fast with a distinct message --------------------------
# Default checks both the API and the UI app. Override READINESS_URLS for an API-only run,
# e.g.  READINESS_URLS="$API_URL" ./run-tests.sh -m api
: "${READINESS_URLS:=$API_URL $UI_URL}"
for url in $([ "${ARGUS_CONTRACT_SMOKE:-0}" = "1" ] && printf '' || printf '%s' "$READINESS_URLS"); do
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

mkdir -p reports/html

# --- Optional parallelism (off by default = deterministic) ------------------------------
XDIST=()
if [ -n "${WORKERS:-}" ]; then
  XDIST=(-n "$WORKERS")
  echo "Parallelism: pytest-xdist with $WORKERS workers"
fi

# --- Run every lane. Markers gate the perf/security/db lanes via skipif inside the tests.
set +e
"${PYTEST[@]}" ${XDIST[@]+"${XDIST[@]}"} "${MODE_ARGS[@]}" "$@"
code=$?
set -e

echo ""
echo "Reports: reports/html/index.html (humans) | reports/report.json + reports/junit.xml (tooling)"
finish_contract "$([ "$code" -eq 0 ] && printf 0 || printf 1)"
