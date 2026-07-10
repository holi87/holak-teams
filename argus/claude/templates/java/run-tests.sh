#!/usr/bin/env bash
# Argus QA one-command test runner — Java (REST Assured API + Playwright UI).
# One `mvn test` runs every @Tag lane (api/ui/perf/security/db/regression); gated lanes
# self-skip unless their env prerequisite is set. Produces target/surefire-reports/*.xml
# (per-class) + reports/summary.{json,html} (aggregated). Exit code reflects pass/fail.
# Any extra args pass straight through to Maven, e.g.:
#   ./run-tests.sh -Dgroups=api          # one lane by @Tag
#   ./run-tests.sh -Papi                 # same, via profile
#   ./run-tests.sh -Dtest=ExampleApiTest # one class
set -euo pipefail
cd "$(dirname "$0")"

: "${API_URL:=http://localhost:3001}"
: "${UI_URL:=http://localhost:3000}"
export API_URL UI_URL

echo "Argus QA tests (Java) → API_URL=$API_URL UI_URL=$UI_URL"

# Gated-lane status — informational. Unset prerequisite = the lane self-skips (exit stays 0).
echo "Gated lanes:"
[ -n "${PERF_BUDGET_MS:-}" ] && echo "  perf     : ENABLED (PERF_BUDGET_MS=$PERF_BUDGET_MS)" || echo "  perf     : skip (set PERF_BUDGET_MS to enable)"
[ "${SECURITY_ENABLED:-}" = "1" ] && echo "  security : ENABLED (SECURITY_ENABLED=1)"        || echo "  security : skip (set SECURITY_ENABLED=1 to enable)"
[ -n "${DB_URL:-}" ] && echo "  db       : ENABLED (DB_URL set)"                              || echo "  db       : skip (set DB_URL to enable)"

MVN=(mvn -B -ntp)

# Compile gate — a suite that doesn't compile doesn't run (the Java analog of the TS
# typecheck gate; catches hallucinated/wrong-typed APIs before we hit the live app).
echo "Compile gate (mvn test-compile)…"
"${MVN[@]}" -DskipTests test-compile

# Playwright browser install (idempotent). Auto-download also happens on first
# Playwright.create(); this makes it explicit. Skip with PLAYWRIGHT_INSTALL=0.
if [ "${PLAYWRIGHT_INSTALL:-1}" = "1" ]; then
  echo "Ensuring Playwright Chromium is installed…"
  "${MVN[@]}" -q org.codehaus.mojo:exec-maven-plugin:3.1.1:java \
    -Dexec.mainClass=com.microsoft.playwright.CLI \
    -Dexec.classpathScope=test \
    -Dexec.args="install chromium" \
    || echo "  (browser install skipped/failed — runtime auto-download will retry)"
fi

# Environment readiness — fail fast with a distinct message instead of a wall of red.
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

# Run every lane in ONE invocation → ONE aggregated report. Gated lanes self-skip.
set +e
"${MVN[@]}" test "$@"
code=$?
set -e

echo ""
echo "Reports: target/surefire-reports/ (XML per class)  |  reports/summary.html  |  reports/summary.json"
exit $code
