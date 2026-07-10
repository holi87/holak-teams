#!/usr/bin/env bash
# Argus QA one-command test runner — pytest + Playwright + httpx (API + UI).
# Runs every lane (api + ui + regression, plus the gated perf/security/db lanes which
# self-skip unless their env prerequisite is set) and emits ONE aggregated report set:
#   reports/html/index.html (humans) + reports/report.json + reports/junit.xml (tooling).
# Exit code reflects pass/fail. Extra args pass straight through to pytest:
#   ./run-tests.sh -m api            # API lane only
#   ./run-tests.sh -k bad_credentials -x
#   PERF_BUDGET_MS=300 ./run-tests.sh -m perf
#   WORKERS=4 ./run-tests.sh         # opt-in parallelism (pytest-xdist)
set -euo pipefail
cd "$(dirname "$0")"

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
  "$VENV/bin/python" -m playwright install --with-deps chromium
fi
PYTEST=("$VENV/bin/python" -m pytest)

# --- Environment readiness — fail fast with a distinct message --------------------------
# Default checks both the API and the UI app. Override READINESS_URLS for an API-only run,
# e.g.  READINESS_URLS="$API_URL" ./run-tests.sh -m api
: "${READINESS_URLS:=$API_URL $UI_URL}"
for url in $READINESS_URLS; do
  ok=""
  for _ in $(seq 1 10); do
    if curl -sf --max-time 3 -o /dev/null "$url"; then ok=1; break; fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    echo "ENVIRONMENT NOT READY: $url is not responding — start the stack first (docker compose up -d?)." >&2
    exit 2
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
"${PYTEST[@]}" ${XDIST[@]+"${XDIST[@]}"} "$@"
code=$?
set -e

echo ""
echo "Reports: reports/html/index.html (humans) | reports/report.json + reports/junit.xml (tooling)"
exit $code
