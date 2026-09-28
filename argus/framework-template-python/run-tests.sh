#!/usr/bin/env bash
# Argus QA one-command test runner — pytest + Playwright + httpx (API + UI).
# scripts/runner-lib.sh owns the run (RUNNER-CONTRACT.md "Runner library and gates"): mode
# parsing, template selection, the lane plan (solution/test-lanes.tsv), readiness, the
# environment baseline (solution/environment.tsv), the collect-only inventory, quarantine,
# the inventory and evidence gates, the evidence passes, and reports/argus-runner-result.json.
# This file supplies only the pytest hooks. Exit codes follow RUNNER-CONTRACT.md
# (0, 10-15), never pytest's own.
#   ./run-tests.sh --mode baseline|defect-evidence|candidate-regression|full-suite [-- <pytest args>]
#   WORKERS=4 ./run-tests.sh --mode full-suite   # opt-in parallelism (pytest-xdist)
set -euo pipefail
cd "$(dirname "$0")"

ARGUS_RUNTIME=python
ARGUS_PACKAGE_MANAGER=pip
TEST_ROOT="${ARGUS_TEST_ROOT:-tests}"

PYTHON_BIN="${PYTHON:-python3}"
VENV=".venv"
PYTEST=("$VENV/bin/python" -m pytest)

# Install deps once (idempotent) into a local venv, then compile. requirements.txt pins
# version FLOORS (lower bounds), not exact versions, so this venv is NOT byte-reproducible
# across time (unlike the TS sibling's `npm ci` against a committed lock). For a reproducible
# install, lock once and install from it:
#   .venv/bin/python -m pip freeze > requirements.lock   # then: pip install -r requirements.lock
# (or use `uv pip compile` / `uv.lock`). To refresh deps, edit requirements.txt (and
# pyproject.toml) and delete .venv. Browsers are pre-downloaded so tests don't stall; skip
# that with PLAYWRIGHT_INSTALL=0. A failed install removes the half-built venv, so the next run
# starts clean. (Test-execution determinism — no retries, no rerun plugin — is separate and
# always holds.)
argus_native_prepare() {
  local harness root
  local roots=()
  echo "Argus QA tests (Python) → API_URL=${API_URL:-<unset>} UI_URL=${UI_URL:-<unset>}"
  if [ ! -d "$VENV" ]; then
    echo "Creating venv + installing deps…"
    if ! "$PYTHON_BIN" -m venv "$VENV" ||
      ! "$VENV/bin/python" -m pip install --upgrade pip >/dev/null ||
      ! "$VENV/bin/python" -m pip install -r requirements.txt; then
      rm -rf "$VENV"
      argus_emit install infrastructure fail false n/a - pip-install-failed
      return 1
    fi
    if [ "${PLAYWRIGHT_INSTALL:-1}" = 1 ] && ! "$VENV/bin/python" -m playwright install --with-deps chromium; then
      rm -rf "$VENV"
      argus_emit install infrastructure fail false n/a - playwright-install-failed
      return 1
    fi
  fi
  # Compile gate — a suite that doesn't compile doesn't run (the Python analog of the TS
  # typecheck and the Java test-compile gates): the test root, the root conftest, and the
  # harness roots that pytest puts on sys.path (pyproject.toml `pythonpath`, which the
  # scaffold relocates together with TEST_ROOT). A root that does not exist is a failure too,
  # because compileall would only print "Can't list" and pass.
  echo "Compile gate (python -m compileall)…"
  if ! harness="$("$VENV/bin/python" -c '
import tomllib
with open("pyproject.toml", "rb") as handle:
    paths = tomllib.load(handle).get("tool", {}).get("pytest", {}).get("ini_options", {}).get("pythonpath", [])
print("\n".join([paths] if isinstance(paths, str) else paths))')"; then
    echo "COMPILE GATE: pyproject.toml has no readable [tool.pytest.ini_options] pythonpath" >&2
    argus_emit compile automation fail false n/a - python-compile-failed
    return 1
  fi
  while IFS= read -r root; do
    if [ -n "$root" ]; then roots+=("$root"); fi
  done <<<"$harness"
  for root in "$TEST_ROOT" ${roots[@]+"${roots[@]}"}; do
    if [ ! -d "$root" ]; then
      echo "COMPILE GATE: $root is not a directory" >&2
      argus_emit compile automation fail false n/a - python-compile-failed
      return 1
    fi
  done
  if ! "$VENV/bin/python" -m compileall -q "$TEST_ROOT" conftest.py ${roots[@]+"${roots[@]}"}; then
    argus_emit compile automation fail false n/a - python-compile-failed
    return 1
  fi
  return 0
}

# Collect-only pass over the whole collection (pyproject.toml `testpaths`): the outcome
# adapter (qa.argus_plugin) writes reports/test-inventory.tsv, reports/expected-bugs.txt, and
# reports/counterfactual-plan.tsv without running a test body. addopts is cleared so no report
# of a run is written.
argus_native_inventory() {
  "${PYTEST[@]}" --collect-only -q -o addopts= --strict-markers -p no:cacheprovider
}

# argus_native_run <baseline|full|regression> <lanes-csv> <pass> [passthrough...]
# One pytest run over a marker expression: the enabled lanes joined with ' or ' (the
# contract-smoke lane is the contract_smoke marker). Quarantined tests are never selected, and
# contract-smoke tests run only when the contract smoke is the lane (ARGUS_CONTRACT_SMOKE=1).
# The aggregated reports of the pass go straight to reports/evidence/passes/<pass>/; pytest
# arguments come last.
argus_native_run() {
  local selection="$1" lanes="$2" pass="$3" markers expression smoke_excluded=" and not contract_smoke"
  local args=()
  local destination="reports/evidence/passes/$pass"
  shift 3
  markers="${lanes//contract-smoke/contract_smoke}"
  markers="${markers//,/ or }"
  case ",$lanes," in *,contract-smoke,*) smoke_excluded="" ;; esac
  case "$selection" in
    baseline) expression="($markers) and not regression and not quarantine$smoke_excluded" ;;
    regression) expression="($markers) and regression and not quarantine" ;;
    full) expression="($markers) and not quarantine$smoke_excluded" ;;
    *) echo "argus_native_run: unknown selection $selection" >&2; return 2 ;;
  esac
  args=(-m "$expression"
    "--html=$destination/html/index.html"
    "--json-report-file=$destination/report.json"
    "--junitxml=$destination/junit.xml")
  # Opt-in parallelism (off by default = deterministic).
  if [ -n "${WORKERS:-}" ]; then
    echo "Parallelism: pytest-xdist with $WORKERS workers"
    args+=(-n "$WORKERS")
  fi
  # pytest-playwright empties its --output directory itself; the managed browser-artifact
  # directory is used as is, and a stale default one is never collected as this pass's evidence.
  if [ -n "${ARGUS_BROWSER_ARTIFACTS:-}" ]; then
    args+=(--output "$ARGUS_BROWSER_ARTIFACTS")
  else
    rm -rf test-results
  fi
  mkdir -p "$destination"
  "${PYTEST[@]}" "${args[@]}" "$@"
}

# The reports already sit in the pass directory; the browser artifacts (traces, screenshots,
# videos) of the pass are copied next to them.
argus_native_collect() {
  local destination="reports/evidence/passes/$1" output="${ARGUS_BROWSER_ARTIFACTS:-test-results}"
  if [ -d "$output" ]; then cp -R "$output" "$destination/test-results" || return 1; fi
  return 0
}

source scripts/runner-lib.sh
argus_main "$@"
