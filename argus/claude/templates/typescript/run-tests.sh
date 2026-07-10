#!/usr/bin/env bash
# Argus QA one-command test runner — Playwright + TS (API + UI).
# Produces reports/html/ (humans) + reports/results.json (tooling). Exit code reflects pass/fail.
set -euo pipefail
cd "$(dirname "$0")"

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
    exit 3
  fi
  npx playwright install --with-deps chromium
fi

# Environment readiness — fail fast with a distinct message instead of a wall of misleading red.
for url in "$API_URL" "$UI_URL"; do
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

# Typecheck gate — Playwright strips types without checking them; a suite that
# doesn't typecheck doesn't run (catches hallucinated/wrong-typed APIs early).
echo "Typecheck (tsc --noEmit)…"
npx tsc --noEmit

# Run all projects (setup + api + regression + ui). Args pass through, e.g. ./run-tests.sh --project=api
set +e
npx playwright test "$@"
pw_code=$?

node scripts/bug-coverage.mjs
bug_gate_code=$?

node scripts/baseline-coverage.mjs
baseline_gate_code=$?
set -e

echo ""
echo "Reports: reports/html/index.html (npm run report)  |  reports/results.json"
echo "Summary: reports/summary.json"

code=0
if [ "$pw_code" -ne 0 ]; then code="$pw_code"; fi
if [ "$code" -eq 0 ] && [ "$bug_gate_code" -ne 0 ]; then code="$bug_gate_code"; fi
if [ "$code" -eq 0 ] && [ "$baseline_gate_code" -ne 0 ]; then code="$baseline_gate_code"; fi
exit $code
