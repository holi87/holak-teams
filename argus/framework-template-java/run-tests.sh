#!/usr/bin/env bash
# Argus QA one-command test runner — Java (REST Assured API + Playwright UI).
# scripts/runner-lib.sh owns the run (RUNNER-CONTRACT.md "Runner library and gates"): mode
# parsing, template selection, the lane plan (solution/test-lanes.tsv), readiness, the
# environment baseline (solution/environment.tsv), the collect-only inventory, quarantine,
# the inventory and evidence gates, the evidence passes, and reports/argus-runner-result.json.
# This file supplies only the Maven/JUnit hooks. Exit codes follow RUNNER-CONTRACT.md
# (0, 10-15), never Maven's own.
#   ./run-tests.sh --mode baseline|defect-evidence|candidate-regression|full-suite [-- <maven args>]
set -euo pipefail
cd "$(dirname "$0")"

ARGUS_RUNTIME=java
ARGUS_PACKAGE_MANAGER=maven
TEST_ROOT="${ARGUS_TEST_ROOT:-src/test/java}"

# Compile gate — a suite that doesn't compile doesn't run (the Java analog of the TS
# typecheck gate; catches hallucinated/wrong-typed APIs before we hit the live app). Then the
# optional Playwright browser install for the browser lanes.
argus_native_prepare() {
  echo "Argus QA tests (Java) → API_URL=${API_URL:-<unset>} UI_URL=${UI_URL:-<unset>}"
  echo "Compile gate (mvn test-compile)…"
  if ! mvn -B -ntp -DskipTests test-compile; then
    argus_emit compile automation fail false n/a - java-compile-failed
    return 1
  fi
  # Idempotent; Playwright.create() also downloads on first use, this makes it explicit.
  # Skip with PLAYWRIGHT_INSTALL=0. Only the ui and resilience lanes drive a browser.
  if [ "${PLAYWRIGHT_INSTALL:-1}" = 1 ] && { argus_lane_enabled ui || argus_lane_enabled resilience; }; then
    echo "Ensuring Playwright Chromium is installed…"
    mvn -B -ntp -q org.codehaus.mojo:exec-maven-plugin:3.1.1:java \
      -Dexec.mainClass=com.microsoft.playwright.CLI \
      -Dexec.classpathScope=test \
      -Dexec.args="install chromium" ||
      echo "  (browser install skipped/failed — runtime auto-download will retry)"
  fi
  return 0
}

# Collect-only pass: JUnit Platform Launcher discovery over target/test-classes. The outcome
# adapter writes reports/test-inventory.tsv, reports/expected-bugs.txt, and
# reports/counterfactual-plan.tsv without executing a test.
argus_native_inventory() {
  mvn -q -B -ntp org.codehaus.mojo:exec-maven-plugin:3.1.1:java -Dexec.mainClass=qa.support.argus.ArgusInventory -Dexec.classpathScope=test
}

# argus_native_run <baseline|full|regression> <lanes-csv> <pass> [passthrough...]
# One Surefire run over a JUnit tag expression: the enabled lanes joined with ' | '.
# Quarantined tests are never selected, and contract-smoke tests run only when the contract
# smoke is the lane (ARGUS_CONTRACT_SMOKE=1). Maven arguments come last.
argus_native_run() {
  local selection="$1" lanes="$2" groups excluded
  shift 3
  groups="${lanes//,/ | }"
  case "$selection" in
    baseline) excluded=regression,quarantine,contract-smoke ;;
    regression) groups="($groups) & regression"; excluded=quarantine ;;
    full) excluded=quarantine,contract-smoke ;;
    *) echo "argus_native_run: unknown selection $selection" >&2; return 2 ;;
  esac
  case ",$lanes," in *,contract-smoke,*) excluded="${excluded%,contract-smoke}" ;; esac
  # A stale report must never be collected as this pass's evidence.
  rm -rf target/surefire-reports reports/summary.json reports/summary.html
  mvn -B -ntp test "-Dgroups=$groups" "-DexcludedGroups=$excluded" "$@"
}

# Surefire's per-class XML and the aggregated summary for one pass.
argus_native_collect() {
  local destination="reports/evidence/passes/$1" summary
  if [ -d target/surefire-reports ]; then cp -R target/surefire-reports "$destination/surefire-reports" || return 1; fi
  for summary in reports/summary.json reports/summary.html; do
    if [ -f "$summary" ]; then cp "$summary" "$destination/" || return 1; fi
  done
  return 0
}

source scripts/runner-lib.sh
argus_main "$@"
