#!/usr/bin/env bash
# Replay runtime for scripts/smoke-argus-runner-gates.sh. It implements the runner-lib hook
# interface from recorded scenario files instead of a framework, so every gate in
# scripts/runner-lib.sh runs without a target. ARGUS_FAKE_SCENARIO names the scenario
# directory; every hook call is recorded in reports/fake-calls.log. A pass replays
# events.<selection>.<pass>.tsv and returns exit.<selection>.<pass> (default 0); the
# inventory pass publishes inventory.tsv, expected-bugs.txt, and counterfactual-plan.tsv.
set -euo pipefail
cd "$(dirname "$0")"

ARGUS_RUNTIME=fake
ARGUS_PACKAGE_MANAGER=replay
TEST_ROOT="${ARGUS_TEST_ROOT:-tests}"
SCENARIO="${ARGUS_FAKE_SCENARIO:?ARGUS_FAKE_SCENARIO must name a scenario directory}"
CALLS="$PWD/reports/fake-calls.log"

fake_record() { mkdir -p reports; printf '%s\n' "$*" >>"$CALLS"; }

argus_native_prepare() {
  fake_record "prepare"
  fake_record "env prepare playwright-install=${PLAYWRIGHT_INSTALL-unset}"
  if [ -f "$SCENARIO/prepare-fail" ]; then
    bash scripts/outcome-event.sh prepare automation fail false n/a - fake-prepare-failed
    return 1
  fi
  return 0
}

argus_native_inventory() {
  fake_record "inventory only=${ARGUS_INVENTORY_ONLY:-0}"
  [ "${ARGUS_INVENTORY_ONLY:-0}" = 1 ] || return 1
  [ ! -f "$SCENARIO/inventory-fail" ] || return 1
  if [ -f "$SCENARIO/inventory.tsv" ]; then
    cp "$SCENARIO/inventory.tsv" reports/test-inventory.tsv.tmp || return 1
    mv reports/test-inventory.tsv.tmp reports/test-inventory.tsv || return 1
  fi
  if [ -f "$SCENARIO/expected-bugs.txt" ]; then
    cp "$SCENARIO/expected-bugs.txt" reports/expected-bugs.txt || return 1
  fi
  if [ -f "$SCENARIO/counterfactual-plan.tsv" ]; then
    cp "$SCENARIO/counterfactual-plan.tsv" reports/counterfactual-plan.tsv || return 1
  fi
  return 0
}

argus_native_run() {
  local selection="$1" lanes="$2" pass="$3" replay count=0 code=0
  local case_id category status expected lifecycle bug_id reason
  shift 3
  fake_record "run $selection $pass $lanes${*:+ $*}"
  fake_record "env mode=${ARGUS_RUNNER_MODE:-} pass=${ARGUS_EVIDENCE_PASS:-} outcome=${ARGUS_OUTCOME_FILE:-} fault=${ARGUS_FAULT_INJECTION:-} grant=${ARGUS_FAULT_INJECTION_GRANT:-}"
  # A misbehaving hook that exits instead of returning; the library must still write a result.
  if [ -f "$SCENARIO/run-exit" ]; then exit 0; fi
  replay="$SCENARIO/events.$selection.$pass.tsv"
  if [ -f "$replay" ]; then
    while IFS=$'\t' read -r case_id category status expected lifecycle bug_id reason; do
      [ -n "$case_id" ] || continue
      bash scripts/outcome-event.sh "$case_id" "$category" "$status" "$expected" "$lifecycle" "$bug_id" "$reason" || return 1
      count=$((count + 1))
    done <"$replay"
  fi
  if [ -f "$SCENARIO/status-error" ]; then
    printf 'error 1\n' >reports/argus-adapter-status.txt
  elif [ ! -f "$SCENARIO/no-status" ]; then
    printf 'ok %s\n' "$count" >reports/argus-adapter-status.txt
  fi
  if [ -f "$SCENARIO/exit.$selection.$pass" ]; then code="$(cat "$SCENARIO/exit.$selection.$pass")"; fi
  return "$code"
}

argus_native_collect() {
  local pass="$1"
  fake_record "collect $pass"
  printf 'native report for pass %s\n' "$pass" >"reports/evidence/passes/$pass/native-report.txt"
}

argus_native_post() {
  fake_record "post $1"
  if [ -f "$SCENARIO/post-fail" ]; then
    bash scripts/outcome-event.sh post-gate automation fail false n/a - fake-post-failed
    return 1
  fi
  return 0
}

source scripts/runner-lib.sh
argus_main "$@"
