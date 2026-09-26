#!/usr/bin/env bash
# Portable Argus lane-plan gate shared by every runtime template (SD-8).
#   validate  prints the enabled product lanes as CSV in canonical order and exits 0, or
#             appends denial events and exits 1. A disabled lane is removed from native
#             selection and recorded, never skipped at runtime.
#   verify    after a baseline or full-suite run, proves that every enabled lane executed
#             at least one inventoried test.
set -euo pipefail

usage() {
  printf 'usage: lane-plan.sh validate --plan <file> --events <file> --mode <mode>\n' >&2
  printf '       lane-plan.sh verify --plan <file> --inventory <file> --events <file> --mode <mode>\n' >&2
  exit 14
}

action="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
plan="" events="" inventory="" mode=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --plan) plan="$2" ;;
    --events) events="$2" ;;
    --inventory) inventory="$2" ;;
    --mode) mode="$2" ;;
    *) printf 'lane-plan: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
  shift 2
done
case "$action" in validate|verify) ;; *) usage ;; esac
case "$mode" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) usage ;; esac
[ -n "$plan" ] && [ -n "$events" ] || usage

LANES=(api ui perf security db resilience)
UNDECIDED=not-yet-planned
SAFE_TOKEN='^[A-Za-z0-9_.:-]+$'
OWNER_TOKEN='^[a-z][a-z0-9-]*$'
PREREQUISITE_LIST='^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$'
TAB=$'\t'
STATE=() OWNER=() PREREQUISITES=() REASON=()

emit() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$events"; }

lane_index() {
  case "$1" in
    api) index=0 ;;
    ui) index=1 ;;
    perf) index=2 ;;
    security) index=3 ;;
    db) index=4 ;;
    resilience) index=5 ;;
    *) return 1 ;;
  esac
}

# Loads the plan into the per-lane arrays. Any malformed row, duplicate, unknown or missing
# lane, invalid token, or disabled lane without a reason makes the whole plan invalid.
parse_plan() {
  local line tabs lane state owner prerequisites reason seen=0
  [ -f "$plan" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    tabs="${line//[!$TAB]/}"
    [ "${#tabs}" -eq 4 ] || return 1
    IFS="$TAB" read -r lane state owner prerequisites reason <<<"$line"
    [ -n "$lane" ] && [ -n "$state" ] && [ -n "$owner" ] && [ -n "$prerequisites" ] && [ -n "$reason" ] || return 1
    lane_index "$lane" || return 1
    [ -z "${STATE[$index]:-}" ] || return 1
    case "$state" in enabled|disabled) ;; *) return 1 ;; esac
    [[ "$owner" =~ $OWNER_TOKEN ]] || return 1
    [ "$prerequisites" = - ] || [[ "$prerequisites" =~ $PREREQUISITE_LIST ]] || return 1
    [[ "$reason" =~ $SAFE_TOKEN ]] || return 1
    if [ "$state" = disabled ] && [ "$reason" = - ]; then return 1; fi
    STATE[$index]="$state"
    OWNER[$index]="$owner"
    PREREQUISITES[$index]="$prerequisites"
    REASON[$index]="$reason"
    seen=$((seen + 1))
  done <"$plan"
  [ "$seen" -eq "${#LANES[@]}" ]
}

prerequisites_present() {
  local name
  local IFS=,
  [ "$1" != - ] || return 0
  for name in $1; do
    [ -n "${!name:-}" ] || return 1
  done
  return 0
}

if ! parse_plan; then
  printf 'lane-plan: %s is missing or invalid (SD-8)\n' "$plan" >&2
  emit lane-plan policy denied false n/a - lane-plan-invalid
  exit 1
fi

if [ "$action" = validate ]; then
  denied=0 enabled=""
  for index in 0 1 2 3 4 5; do
    lane="${LANES[$index]}"
    if [ "$mode" = full-suite ] && [ "${REASON[$index]}" = "$UNDECIDED" ]; then
      emit "lane.$lane" policy denied false n/a - lane-decision-missing
      denied=1
    elif [ "${STATE[$index]}" = disabled ]; then
      emit "lane.$lane" policy pass false n/a - "lane-disabled.${REASON[$index]}"
    elif ! prerequisites_present "${PREREQUISITES[$index]}"; then
      printf 'lane-plan: lane %s is enabled but a prerequisite in %s is unset or empty\n' "$lane" "${PREREQUISITES[$index]}" >&2
      emit "lane.$lane" policy denied false n/a - lane-prerequisite-missing
      denied=1
    else
      enabled="${enabled:+$enabled,}$lane"
    fi
  done
  [ "$denied" -eq 0 ] || exit 1
  if [ -z "$enabled" ]; then
    printf 'lane-plan: no product lane is enabled\n' >&2
    emit lane-plan policy denied false n/a - lane-plan-empty
    exit 1
  fi
  printf '%s\n' "$enabled"
  exit 0
fi

# verify: only the delivery modes prove lane execution.
case "$mode" in baseline|full-suite) ;; *) exit 0 ;; esac
[ -n "$inventory" ] && [ -f "$inventory" ] || usage
touch "$events"
# An event counts for an inventory row when its case id equals the row id or extends it
# with '.<suffix>' (evidence passes, cleanup). Only executed outcomes count, never skips or
# policy records.
executed="$(awk -F '\t' -v inventory="$inventory" '
  FILENAME == inventory { if ($1 != "" && $2 != "") lane[$1] = $2; next }
  $2 == "product" || $2 == "automation" || $2 == "infrastructure" {
    key = $1
    while (key != "") {
      if (key in lane) hit[lane[key]] = 1
      cut = match(key, /[.][^.]*$/)
      if (cut == 0) break
      key = substr(key, 1, cut - 1)
    }
  }
  END { for (name in hit) print name }
' "$inventory" "$events")"
for index in 0 1 2 3 4 5; do
  [ "${STATE[$index]}" = enabled ] || continue
  lane="${LANES[$index]}"
  if printf '%s\n' "$executed" | grep -Fxq "$lane"; then
    emit "lane.$lane" policy pass false n/a - lane-executed
  else
    printf 'lane-plan: enabled lane %s executed no inventoried test\n' "$lane" >&2
    emit "lane.$lane" skip skipped false n/a - lane-not-executed
  fi
done
exit 0
