#!/usr/bin/env bash
# Portable Argus runner library shared by every runtime template (template-contract@2).
#
# A runtime run-tests.sh sets ARGUS_RUNTIME, ARGUS_PACKAGE_MANAGER and TEST_ROOT, defines
# the native hooks below, sources this file, and calls `argus_main "$@"`:
#
#   argus_native_prepare                    install and compile; emits its own event on failure
#   argus_native_inventory                  collect-only pass (ARGUS_INVENTORY_ONLY=1) that writes
#                                           reports/test-inventory.tsv and reports/expected-bugs.txt
#   argus_native_run <baseline|full|regression> <lanes-csv> <pass> [passthrough...]
#                                           one native run; its status is the native exit code
#   argus_native_collect <pass>             copies native reports and traces into
#                                           reports/evidence/passes/<pass>/
#   argus_native_post <mode>                optional post-run gates
#
# Hooks run in this shell with errexit suspended: they check their own commands, report
# failures through scripts/outcome-event.sh, and `return` a status. They never `exit`; an
# exit, an unbound variable, or any other unexpected stop is recorded as a wrapper failure.
# Exit codes follow RUNNER-CONTRACT.md (0, 10-15), never framework-native codes.

ARGUS_RESULT="reports/argus-runner-result.json"
ARGUS_INVENTORY="reports/test-inventory.tsv"
ARGUS_EXPECTED_BUGS="reports/expected-bugs.txt"
ARGUS_COUNTERFACTUAL_PLAN="reports/counterfactual-plan.tsv"
ARGUS_ADAPTER_STATUS="reports/argus-adapter-status.txt"
ARGUS_PASS_ARTIFACTS="reports/evidence/passes"
ARGUS_LANE_PLAN="solution/test-lanes.tsv"
ARGUS_ENVIRONMENT_PLAN="solution/environment.tsv"
ARGUS_QUARANTINE_LEDGER="solution/quarantine.tsv"
ARGUS_ROOT="" ARGUS_MODE="" ARGUS_EVENTS="" ARGUS_LANES=""
ARGUS_NATIVE_MAX=0 ARGUS_CALL_STATUS=0 ARGUS_FINISHING=0
ARGUS_PASSTHROUGH=()

argus_emit() {
  bash "$ARGUS_ROOT/scripts/outcome-event.sh" "$@"
}

# Runs one command or function in this shell with errexit suspended and stores its status
# in ARGUS_CALL_STATUS. Every step that may fail by design goes through here, so a gate
# denial is a recorded outcome rather than an errexit.
argus_call() {
  set +e
  "$@"
  ARGUS_CALL_STATUS=$?
  set -e
  cd "$ARGUS_ROOT"
}

argus_finish() {
  local runner_exit="$1" code
  local args=()
  ARGUS_FINISHING=1
  trap - ERR EXIT
  set +e
  args=(--mode "$ARGUS_MODE" --events "$ARGUS_EVENTS" --output "$ARGUS_RESULT" --runner-exit "$runner_exit")
  if [ -f "$ARGUS_QUARANTINE_LEDGER" ]; then args+=(--quarantine "$ARGUS_QUARANTINE_LEDGER"); fi
  if [ -f "$ARGUS_EXPECTED_BUGS" ]; then args+=(--expected-bugs "$ARGUS_EXPECTED_BUGS"); fi
  if [ "${ARGUS_CONTRACT_SMOKE:-0}" = 1 ]; then args+=(--contract-smoke); fi
  bash "$ARGUS_ROOT/scripts/runner-contract.sh" "${args[@]}"
  code=$?
  echo "Argus contract: mode=$ARGUS_MODE result=$ARGUS_RESULT exit=$code"
  exit "$code"
}

# The ERR trap covers commands in the run-tests.sh body. Inside functions an unexpected
# failure stops the shell through errexit, and the EXIT trap records the same outcome, so no
# path ends without a result file.
argus_unexpected_error() {
  [ "$ARGUS_FINISHING" -eq 0 ] || return 0
  ARGUS_FINISHING=1
  trap - ERR EXIT
  cd "$ARGUS_ROOT" 2>/dev/null || true
  argus_emit wrapper infrastructure fail false n/a - wrapper-command-failed ||
    printf 'wrapper\tinfrastructure\tfail\tfalse\tn/a\t-\twrapper-command-failed\n' >>"$ARGUS_EVENTS"
  argus_finish 1
}

argus_lane_enabled() {
  case ",$ARGUS_LANES," in *",$1,"*) return 0 ;; esac
  return 1
}

argus_selection_matches() {
  local selection="ai_agents_internal/template-selection.json"
  [ -f "$selection" ] &&
    grep -Fq "\"runtime\": \"${ARGUS_RUNTIME:-}\"" "$selection" &&
    grep -Fq "\"packageManager\": \"${ARGUS_PACKAGE_MANAGER:-}\"" "$selection" &&
    grep -Fq '"choiceSource": "explicit-user"' "$selection"
}

argus_runtime_configured() {
  local hook
  [ -n "${ARGUS_RUNTIME:-}" ] && [ -n "${ARGUS_PACKAGE_MANAGER:-}" ] && [ -n "${TEST_ROOT:-}" ] || return 1
  for hook in argus_native_prepare argus_native_inventory argus_native_run argus_native_collect; do
    declare -F "$hook" >/dev/null || return 1
  done
  return 0
}

# Readiness probes ARGUS_READINESS_URLS (space-separated) when it is set; an explicitly
# empty value probes nothing. Otherwise API_URL is probed when an HTTP-facing product lane
# (api, perf, security, resilience) is enabled and UI_URL when the ui lane is enabled.
argus_readiness() {
  local urls="" url ok attempt
  local list=()
  if [ -n "${ARGUS_READINESS_URLS+x}" ]; then
    urls="$ARGUS_READINESS_URLS"
  else
    if argus_lane_enabled api || argus_lane_enabled perf || argus_lane_enabled security || argus_lane_enabled resilience; then
      urls="${API_URL:-}"
    fi
    if argus_lane_enabled ui; then urls="$urls ${UI_URL:-}"; fi
  fi
  read -r -a list <<<"$urls" || true
  for url in ${list[@]+"${list[@]}"}; do
    ok=""
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sf --max-time 3 -o /dev/null "$url"; then ok=1; break; fi
      sleep 1
    done
    if [ -z "$ok" ]; then
      echo "ENVIRONMENT NOT READY: $url is not responding after $attempt attempts; start the stack first." >&2
      argus_emit readiness infrastructure fail false n/a - target-not-ready
      argus_finish 1
    fi
  done
}

# Inside an Argus engagement (ARGUS_ENGAGEMENT_MANIFEST set) an environment reset or a
# server-side fault injection needs both the exclusive engagement window and an explicit
# authorization decision; the opt-in variable alone is never enough. Every missing input
# refuses. Outside an engagement the opt-in of the operator who owns the target stands.
argus_engagement_authorized() {
  local resource="$1" action="$2" label="$3" cli lane target authorization holder state
  local args=()
  if ! cli="$(command -v argus-assets)"; then
    echo "ARGUS AUTHORIZATION: argus-assets is not on PATH; $label refused" >&2
    return 1
  fi
  lane="${ARGUS_ENGAGEMENT_LANE:-}"
  if [[ ! "$lane" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "ARGUS AUTHORIZATION: ARGUS_ENGAGEMENT_LANE must name the calling lane; $label refused" >&2
    return 1
  fi
  target="${ARGUS_AUTHORIZATION_TARGET:-${API_URL:-${UI_URL:-}}}"
  if [ -z "$target" ]; then
    echo "ARGUS AUTHORIZATION: no target (ARGUS_AUTHORIZATION_TARGET, API_URL or UI_URL); $label refused" >&2
    return 1
  fi
  authorization="${ARGUS_AUTHORIZATION_MANIFEST:-$(dirname "$ARGUS_ENGAGEMENT_MANIFEST")/authorization.json}"
  state="$(mktemp)"
  if ! "$cli" engagement status --manifest "$ARGUS_ENGAGEMENT_MANIFEST" >"$state"; then
    rm -f "$state"
    echo "ARGUS AUTHORIZATION: engagement state is unreadable; $label refused" >&2
    return 1
  fi
  holder="$(node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const lock = (JSON.parse(raw).exclusiveLocks || {})[process.argv[1]];
        if (lock && /^[a-z][a-z0-9-]*$/.test(String(lock.lane))) { console.log(lock.lane); return; }
      } catch (error) { /* unreadable state holds no window */ }
      process.exitCode = 1;
    });' "$resource" <"$state")" || holder=""
  rm -f "$state"
  if [ -z "$holder" ]; then
    echo "ARGUS AUTHORIZATION: the exclusive $resource window is not held; $label refused" >&2
    return 1
  fi
  args=(authorization check --manifest "$authorization" --lane "$lane" --action "$action" --target "$target"
    --source-trust "${ARGUS_AUTHORIZATION_SOURCE_TRUST:-manifest}" --resource "$label")
  if [ -n "${ARGUS_AUTHORIZATION_ACCOUNT:-}" ]; then args+=(--account "$ARGUS_AUTHORIZATION_ACCOUNT"); fi
  if [ -n "${ARGUS_AUTHORIZATION_NAMESPACE:-}" ]; then args+=(--namespace "$ARGUS_AUTHORIZATION_NAMESPACE"); fi
  if [ "$resource" = reset ]; then
    args+=(--mutation "${ARGUS_AUTHORIZATION_MUTATION:-environment:reset}")
  elif [ -n "${ARGUS_AUTHORIZATION_MUTATION:-}" ]; then
    args+=(--mutation "$ARGUS_AUTHORIZATION_MUTATION")
  fi
  if [ -n "${ARGUS_AUTHORIZATION_RATE:-}" ]; then args+=(--rate "$ARGUS_AUTHORIZATION_RATE"); fi
  if [ -n "${ARGUS_AUTHORIZATION_CONCURRENCY:-}" ]; then args+=(--concurrency "$ARGUS_AUTHORIZATION_CONCURRENCY"); fi
  if [ -n "${ARGUS_AUTHORIZATION_TOTAL_REQUESTS:-}" ]; then args+=(--total-requests "$ARGUS_AUTHORIZATION_TOTAL_REQUESTS"); fi
  if [ -n "${ARGUS_AUTHORIZATION_DURATION:-}" ]; then args+=(--duration "$ARGUS_AUTHORIZATION_DURATION"); fi
  if ! "$cli" "${args[@]}"; then
    echo "ARGUS AUTHORIZATION: $action denied for $lane; $label refused" >&2
    return 1
  fi
  echo "ARGUS AUTHORIZATION: $action allowed for $lane; exclusive $resource window held by $holder"
  return 0
}

argus_engagement_optin() {
  [ -n "${ARGUS_ENGAGEMENT_MANIFEST:-}" ] || return 0
  case "$1" in
    reset)
      [ "${ARGUS_ENVIRONMENT_RESET:-}" = execute ] || return 0
      argus_call argus_engagement_authorized reset destructive environment-reset
      [ "$ARGUS_CALL_STATUS" -ne 0 ] || return 0
      argus_emit environment policy denied false n/a - environment-reset-unauthorized
      ;;
    fault)
      [ "${ARGUS_FAULT_INJECTION:-}" = authorized ] || return 0
      argus_call argus_engagement_authorized fault chaos fault-injection
      [ "$ARGUS_CALL_STATUS" -ne 0 ] || return 0
      argus_emit fault-injection policy denied false n/a - fault-injection-unauthorized
      ;;
  esac
  argus_finish 1
}

argus_read_lane_plan() {
  local output csv='^[a-z]+(,[a-z]+)*$'
  output="$(mktemp)"
  argus_call bash "$ARGUS_ROOT/scripts/lane-plan.sh" validate --plan "$ARGUS_LANE_PLAN" --events "$ARGUS_EVENTS" --mode "$ARGUS_MODE" >"$output"
  ARGUS_LANES="$(cat "$output")"
  rm -f "$output"
  if [ "$ARGUS_CALL_STATUS" -ne 0 ] || [[ ! "$ARGUS_LANES" =~ $csv ]]; then argus_finish 1; fi
}

argus_record_native() {
  if [ "$1" -gt "$ARGUS_NATIVE_MAX" ]; then ARGUS_NATIVE_MAX="$1"; fi
}

# One evidence pass. Native artifacts land in reports/evidence/passes/<pass>/ so a later pass
# never overwrites the evidence of an earlier one.
argus_run_pass() {
  local selection="$1" pass="$2" native status_line="" status_ok='^ok [0-9]+$'
  rm -f "$ARGUS_ADAPTER_STATUS"
  export ARGUS_EVIDENCE_PASS="$pass"
  argus_call argus_native_run "$selection" "$ARGUS_LANES" "$pass" ${ARGUS_PASSTHROUGH[@]+"${ARGUS_PASSTHROUGH[@]}"}
  native="$ARGUS_CALL_STATUS"
  argus_record_native "$native"
  rm -rf "${ARGUS_PASS_ARTIFACTS:?}/$pass"
  mkdir -p "$ARGUS_PASS_ARTIFACTS/$pass"
  argus_call argus_native_collect "$pass"
  if [ "$ARGUS_CALL_STATUS" -ne 0 ]; then
    argus_emit "evidence-collect.$pass" infrastructure fail false n/a - evidence-collect-failed
  fi
  # A green native run without an adapter status produced no trustworthy evidence.
  if [ ! -f "$ARGUS_ADAPTER_STATUS" ]; then
    if [ "$native" -eq 0 ]; then argus_emit adapter automation fail false n/a - outcome-adapter-missing; fi
    return 0
  fi
  IFS= read -r status_line <"$ARGUS_ADAPTER_STATUS" || true
  if [[ ! "$status_line" =~ $status_ok ]]; then
    argus_emit adapter automation fail false n/a - outcome-adapter-failed
  fi
  return 0
}

argus_main() {
  set -euo pipefail
  ARGUS_ROOT="$PWD"
  ARGUS_MODE=full-suite
  if [ "${1:-}" = --mode ]; then
    ARGUS_MODE="${2:-}"
    if [ "$#" -ge 2 ]; then shift 2; else shift; fi
  fi
  if [ "${1:-}" = -- ]; then shift; fi
  case "$ARGUS_MODE" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) echo "INVALID RUNNER MODE: $ARGUS_MODE" >&2; exit 14 ;; esac
  ARGUS_PASSTHROUGH=("$@")

  export ARGUS_RUNNER_MODE="$ARGUS_MODE"
  ARGUS_EVENTS="${ARGUS_OUTCOME_FILE:-$ARGUS_ROOT/reports/outcomes.raw.tsv}"
  case "$ARGUS_EVENTS" in /*) ;; *) ARGUS_EVENTS="$ARGUS_ROOT/$ARGUS_EVENTS" ;; esac
  export ARGUS_OUTCOME_FILE="$ARGUS_EVENTS"
  mkdir -p reports "$ARGUS_PASS_ARTIFACTS" "$(dirname "$ARGUS_EVENTS")"
  rm -f "$ARGUS_EVENTS" "$ARGUS_INVENTORY" "$ARGUS_EXPECTED_BUGS" "$ARGUS_COUNTERFACTUAL_PLAN" "$ARGUS_ADAPTER_STATUS"
  rmdir "$ARGUS_EVENTS.lock" 2>/dev/null || true
  trap argus_unexpected_error ERR EXIT

  # The template-selection check runs before any other event: an unselected or
  # incompatible scaffold is a policy denial and nothing else is attempted.
  if ! argus_selection_matches; then
    argus_emit template-selection policy denied false n/a - template-selection-missing-or-incompatible
    argus_finish 1
  fi
  if ! argus_runtime_configured; then
    echo "ARGUS RUNNER: run-tests.sh must set ARGUS_RUNTIME, ARGUS_PACKAGE_MANAGER and TEST_ROOT and define the native hooks" >&2
    argus_emit runner-library automation fail false n/a - runner-library-misconfigured
    argus_finish 1
  fi

  # full-suite is the delivery gate; framework selectors would silently narrow it.
  if [ "$ARGUS_MODE" = full-suite ] && [ "${#ARGUS_PASSTHROUGH[@]}" -gt 0 ] && [ "${ARGUS_CONTRACT_SMOKE:-0}" != 1 ]; then
    argus_emit runner-selection policy denied false n/a - full-suite-narrowing-forbidden
    argus_finish 1
  fi

  if [ "${ARGUS_CONTRACT_SMOKE:-0}" = 1 ]; then
    argus_emit contract-smoke policy pass false n/a - contract-smoke-mode
    ARGUS_LANES=contract-smoke
  else
    argus_read_lane_plan
  fi

  argus_engagement_optin fault

  argus_call argus_native_prepare
  if [ "$ARGUS_CALL_STATUS" -ne 0 ]; then argus_finish 1; fi

  if [ "${ARGUS_CONTRACT_SMOKE:-0}" != 1 ]; then
    argus_readiness
    argus_engagement_optin reset
    argus_call bash "$ARGUS_ROOT/scripts/environment-gate.sh" --plan "$ARGUS_ENVIRONMENT_PLAN" --events "$ARGUS_EVENTS" --mode "$ARGUS_MODE"
    if [ "$ARGUS_CALL_STATUS" -ne 0 ]; then argus_finish 1; fi
  fi

  export ARGUS_INVENTORY_ONLY=1
  argus_call argus_native_inventory
  unset ARGUS_INVENTORY_ONLY
  if [ "$ARGUS_CALL_STATUS" -ne 0 ] || [ ! -s "$ARGUS_INVENTORY" ]; then
    argus_emit test-inventory automation fail false n/a - test-inventory-failed
    argus_finish 1
  fi

  argus_call bash "$ARGUS_ROOT/scripts/quarantine-contract.sh" --events "$ARGUS_EVENTS" --ledger "$ARGUS_QUARANTINE_LEDGER" --inventory "$ARGUS_INVENTORY"
  if [ "$ARGUS_CALL_STATUS" -ne 0 ]; then argus_finish 1; fi

  case "$ARGUS_MODE" in
    baseline) argus_run_pass baseline live ;;
    full-suite) argus_run_pass full live ;;
    defect-evidence|candidate-regression) argus_run_pass regression live ;;
  esac

  if declare -F argus_native_post >/dev/null; then
    argus_call argus_native_post "$ARGUS_MODE"
    argus_record_native "$ARGUS_CALL_STATUS"
  fi

  if [ "${ARGUS_CONTRACT_SMOKE:-0}" != 1 ] && { [ "$ARGUS_MODE" = baseline ] || [ "$ARGUS_MODE" = full-suite ]; }; then
    argus_call bash "$ARGUS_ROOT/scripts/lane-plan.sh" verify --plan "$ARGUS_LANE_PLAN" --inventory "$ARGUS_INVENTORY" --events "$ARGUS_EVENTS" --mode "$ARGUS_MODE"
    if [ "$ARGUS_CALL_STATUS" -ne 0 ]; then argus_finish 1; fi
  fi

  if [ "$ARGUS_NATIVE_MAX" -eq 0 ]; then argus_finish 0; fi
  argus_finish 1
}
