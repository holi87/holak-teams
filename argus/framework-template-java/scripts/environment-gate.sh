#!/usr/bin/env bash
# Portable Argus environment gate shared by every runtime template (SD-9). Tests start only
# from a proven baseline: an opted-in reset, a read-only verify, or both. Declared commands
# are fixed scripts under scripts/, run without arguments under a portable timeout, and
# never eval'd. Exit 0 lets the runner continue; exit 1 aborts it after the events below.
set -euo pipefail

usage() {
  printf 'usage: environment-gate.sh --plan <file> --events <file> --mode <mode>\n' >&2
  exit 14
}

plan="" events="" mode=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --plan) plan="$2" ;;
    --events) events="$2" ;;
    --mode) mode="$2" ;;
    *) printf 'environment-gate: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
  shift 2
done
case "$mode" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) usage ;; esac
[ -n "$plan" ] && [ -n "$events" ] || usage

UNDECIDED=not-yet-planned
SAFE_TOKEN='^[A-Za-z0-9_.:-]+$'
SCRIPT_PATH='^scripts/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*[.]sh$'
TIMEOUT_SECONDS='^[1-9][0-9]{0,5}$'
TAB=$'\t'
reset_script="" reset_note="" verify_script="" verify_note=""

emit() { printf 'environment\t%s\t%s\tfalse\tn/a\t-\t%s\n' "$1" "$2" "$3" >>"$events"; }

parse_plan() {
  local line tabs kind script note
  [ -f "$plan" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    tabs="${line//[!$TAB]/}"
    [ "${#tabs}" -eq 2 ] || return 1
    IFS="$TAB" read -r kind script note <<<"$line"
    [ -n "$kind" ] && [ -n "$script" ] && [ -n "$note" ] || return 1
    [[ "$note" =~ $SAFE_TOKEN ]] || return 1
    if [ "$script" != - ]; then
      # An undecided row cannot also declare a command.
      [ "$note" != "$UNDECIDED" ] || return 1
      [[ "$script" =~ $SCRIPT_PATH ]] || return 1
      [ -f "$script" ] && [ ! -L "$script" ] && [ -x "$script" ] || return 1
    fi
    case "$kind" in
      reset) [ -z "$reset_note" ] || return 1; reset_script="$script"; reset_note="$note" ;;
      verify) [ -z "$verify_note" ] || return 1; verify_script="$script"; verify_note="$note" ;;
      *) return 1 ;;
    esac
  done <"$plan"
  [ -n "$reset_note" ] && [ -n "$verify_note" ]
}

# Signals a process and its descendants, deepest first, so a script's children do not
# outlive it.
signal_tree() {
  local pid="$1" signal="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do signal_tree "$child" "$signal"; done
  kill "-$signal" "$pid" 2>/dev/null || true
}

# Portable timeout (no GNU timeout): background the script and poll it. Returns its status,
# or 124 when it had to be stopped.
run_bounded() {
  local limit="$1" script="$2" pid ticks=0
  "./$script" </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge $((limit * 10)) ]; then
      printf 'environment-gate: %s exceeded %ss and was stopped\n' "$script" "$limit" >&2
      signal_tree "$pid" TERM
      sleep 1
      signal_tree "$pid" KILL
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  if wait "$pid"; then return 0; else return $?; fi
}

if ! parse_plan; then
  printf 'environment-gate: %s is missing or invalid (SD-9)\n' "$plan" >&2
  emit policy denied environment-plan-invalid
  exit 1
fi
reset_timeout="${ARGUS_RESET_TIMEOUT_SECONDS:-300}"
verify_timeout="${ARGUS_VERIFY_TIMEOUT_SECONDS:-120}"
if [[ ! "$reset_timeout" =~ $TIMEOUT_SECONDS ]] || [[ ! "$verify_timeout" =~ $TIMEOUT_SECONDS ]]; then
  printf 'environment-gate: ARGUS_RESET_TIMEOUT_SECONDS and ARGUS_VERIFY_TIMEOUT_SECONDS must be positive integers\n' >&2
  emit policy denied environment-timeout-invalid
  exit 1
fi
if [ "$mode" = full-suite ] && { [ "$reset_note" = "$UNDECIDED" ] || [ "$verify_note" = "$UNDECIDED" ]; }; then
  printf 'environment-gate: full-suite needs a decided reset and verify row in %s\n' "$plan" >&2
  emit policy denied environment-decision-missing
  exit 1
fi

reset_executed=0 verify_passed=0
if [ "$reset_script" != - ]; then
  # A reset is a destructive target action: it runs only on the explicit opt-in, and the
  # caller holds the destructive grant and the exclusive reset window.
  if [ "${ARGUS_ENVIRONMENT_RESET:-}" = execute ]; then
    if run_bounded "$reset_timeout" "$reset_script"; then
      emit infrastructure pass environment-reset-executed
      reset_executed=1
    else
      printf 'environment-gate: reset %s failed\n' "$reset_script" >&2
      emit infrastructure fail environment-reset-failed
      exit 1
    fi
  else
    emit policy pass environment-reset-not-requested
  fi
fi
if [ "$verify_script" != - ]; then
  if run_bounded "$verify_timeout" "$verify_script"; then
    emit infrastructure pass environment-baseline-verified
    verify_passed=1
  else
    printf 'environment-gate: verify %s reports the target is not at its baseline\n' "$verify_script" >&2
    emit infrastructure fail environment-not-at-baseline
    exit 1
  fi
fi
if [ "$mode" = full-suite ] && [ "$reset_executed" -eq 0 ] && [ "$verify_passed" -eq 0 ]; then
  printf 'environment-gate: full-suite needs an executed reset or a passing verify\n' >&2
  emit policy denied environment-baseline-unproven
  exit 1
fi
exit 0
