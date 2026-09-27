#!/usr/bin/env bash
# Argus QA one-command test runner — Playwright + TS (API + UI).
# scripts/runner-lib.sh owns the run (RUNNER-CONTRACT.md "Runner library and gates"): mode
# parsing, template selection, the lane plan (solution/test-lanes.tsv), readiness, the
# environment baseline (solution/environment.tsv), the collect-only inventory, quarantine,
# the inventory and evidence gates, the evidence passes, and reports/argus-runner-result.json.
# This file supplies only the Playwright hooks. Exit codes follow RUNNER-CONTRACT.md
# (0, 10-15), never Playwright's own.
#   ./run-tests.sh --mode baseline|defect-evidence|candidate-regression|full-suite [-- <playwright args>]
set -euo pipefail
cd "$(dirname "$0")"

ARGUS_RUNTIME=typescript
ARGUS_PACKAGE_MANAGER=npm
TEST_ROOT="${ARGUS_TEST_ROOT:-tests}"

# Install once, then typecheck. Determinism: `npm ci` installs EXACTLY package-lock.json. We
# never silently fall back to `npm install` (which can mutate the lockfile and drift versions
# under our feet). A drifting install is an explicit, LOGGED decision via ALLOW_NPM_INSTALL=1.
argus_native_prepare() {
  echo "Argus QA tests → API_URL=${API_URL:-<unset>} UI_URL=${UI_URL:-<unset>}"
  if [ ! -d node_modules ]; then
    if npm ci; then
      :
    elif [ "${ALLOW_NPM_INSTALL:-0}" = "1" ]; then
      echo "WARNING: npm ci failed; ALLOW_NPM_INSTALL=1 set → falling back to 'npm install' (may update package-lock.json — NON-DETERMINISTIC)." >&2
      if ! npm install; then
        argus_emit install infrastructure fail false n/a - npm-install-failed
        return 1
      fi
    else
      echo "INSTALL FAILED: 'npm ci' did not succeed and node_modules is absent." >&2
      echo "Fix package-lock.json (commit it / run 'npm install' locally and commit the lock), or re-run with ALLOW_NPM_INSTALL=1 to accept a non-deterministic 'npm install'." >&2
      argus_emit install infrastructure fail false n/a - npm-ci-failed
      return 1
    fi
    if [ "${PLAYWRIGHT_INSTALL:-1}" = "1" ] && ! npx playwright install --with-deps chromium; then
      argus_emit install infrastructure fail false n/a - playwright-install-failed
      return 1
    fi
  fi
  # Typecheck gate — Playwright strips types without checking them; a suite that doesn't
  # typecheck doesn't run (catches hallucinated/wrong-typed APIs early).
  echo "Typecheck (tsc --noEmit)…"
  if ! npx tsc --noEmit; then
    argus_emit typecheck automation fail false n/a - typescript-compile-failed
    return 1
  fi
  return 0
}

# Collect-only pass over every project: the outcome adapter writes reports/test-inventory.tsv,
# reports/expected-bugs.txt, and reports/counterfactual-plan.tsv.
argus_native_inventory() {
  npx playwright test --list --reporter=./scripts/argus-playwright-reporter.mjs
}

# argus_native_run <baseline|full|regression> <lanes-csv> <pass> [passthrough...]
# One Playwright project per enabled lane (the ui lane pulls in `setup` through its
# dependencies). Quarantined tests are never selected; framework arguments come last.
argus_native_run() {
  local selection="$1" lanes="$2" lane
  local lane_list=() args=()
  shift 3
  IFS=, read -r -a lane_list <<<"$lanes"
  for lane in ${lane_list[@]+"${lane_list[@]}"}; do args+=("--project=$lane"); done
  case "$selection" in
    baseline) args+=(--grep-invert '@regression|@quarantine') ;;
    regression) args+=(--grep '@regression' --grep-invert '@quarantine') ;;
    full) args+=(--grep-invert '@quarantine') ;;
    *) echo "argus_native_run: unknown selection $selection" >&2; return 2 ;;
  esac
  # A stale report must never be collected as this pass's evidence. Playwright empties its
  # outputDir itself; the managed browser-artifact directory is never removed here.
  rm -rf reports/html reports/results.json
  if [ -z "${ARGUS_BROWSER_ARTIFACTS:-}" ]; then rm -rf test-results; fi
  npx playwright test "${args[@]}" "$@"
}

# Native reports and Playwright's outputDir (traces, screenshots, videos) for one pass.
argus_native_collect() {
  local destination="reports/evidence/passes/$1" output="${ARGUS_BROWSER_ARTIFACTS:-test-results}"
  if [ -d reports/html ]; then cp -R reports/html "$destination/html" || return 1; fi
  if [ -f reports/results.json ]; then cp reports/results.json "$destination/results.json" || return 1; fi
  if [ -d "$output" ]; then cp -R "$output" "$destination/test-results" || return 1; fi
  return 0
}

# Surface coverage of the delivery modes; a contract smoke proves the scaffold, not a target.
argus_native_post() {
  case "$1" in baseline|full-suite) ;; *) return 0 ;; esac
  [ "${ARGUS_CONTRACT_SMOKE:-0}" != 1 ] || return 0
  if ! node scripts/baseline-coverage.mjs; then
    argus_emit baseline-coverage automation fail false n/a - baseline-coverage-gate-failed
    return 1
  fi
  return 0
}

source scripts/runner-lib.sh
argus_main "$@"
