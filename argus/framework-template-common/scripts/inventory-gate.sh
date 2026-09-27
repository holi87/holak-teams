#!/usr/bin/env bash
# Portable Argus inventory gate shared by every runtime template (SD-3, SD-4, SD-11). Every
# runtime's collect-only pass writes the same reports/test-inventory.tsv, so provenance,
# lane, disabled-regression, confirmed-bug coverage, and execution rules are enforced here
# once instead of by a framework-specific source parser.
#   static    after the quarantine join and before any native run. It appends one event per
#             violation and exits 0; it exits 1 only for an unusable inventory, which leaves
#             nothing trustworthy to select from.
#   executed  after the last evidence pass. Every test the mode selected must have produced
#             an event under its own case id or that id extended with '.<suffix>'.
set -euo pipefail

usage() {
  printf 'usage: inventory-gate.sh static --inventory <file> --expected-bugs <file> --lanes <csv> --events <file> --mode <mode> --test-root <dir> [--contract-smoke]\n' >&2
  printf '       inventory-gate.sh executed --inventory <file> --lanes <csv> --events <file> --mode <mode> [--contract-smoke]\n' >&2
  exit 14
}

action="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
inventory="" expected_bugs="" lanes="" events="" mode="" test_root="" contract_smoke=0
while [ "$#" -gt 0 ]; do
  if [ "$1" = --contract-smoke ]; then contract_smoke=1; shift; continue; fi
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --inventory) inventory="$2" ;;
    --expected-bugs) expected_bugs="$2" ;;
    --lanes) lanes="$2" ;;
    --events) events="$2" ;;
    --mode) mode="$2" ;;
    --test-root) test_root="$2" ;;
    *) printf 'inventory-gate: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
  shift 2
done

LANE_CSV='^[a-z][a-z-]*(,[a-z][a-z-]*)*$'
case "$action" in static|executed) ;; *) usage ;; esac
case "$mode" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) usage ;; esac
[ -n "$inventory" ] && [ -n "$events" ] && [[ "$lanes" =~ $LANE_CSV ]] || usage
if [ "$action" = static ]; then
  [ -n "$expected_bugs" ] && [ -n "$test_root" ] || usage
fi

PRODUCT_LANES=,api,ui,perf,security,db,resilience,
KNOWN_LANES=,api,ui,perf,security,db,resilience,contract-smoke,setup,
SAFE_TOKEN='^[A-Za-z0-9_.:-]+$'
TOKEN_LIST='^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$'
BUG_ID='^BUG-[0-9]{4}$'
BUG_LIST='^BUG-[0-9]{4}(,BUG-[0-9]{4})*$'
SOURCE_TOKEN='^[A-Za-z0-9_./:-]+$'
# A collect-only pass never trips forbidOnly, so focused tests are found in the source. The
# prefix class keeps property accesses such as `suite.test.only(` and `contest.only(` out.
FOCUS_PATTERN='(^|[^A-Za-z0-9_$.])(test|describe|it)[.]only[[:space:]]*[(]'
TAB=$'\t'
case_id="" lane="" regression="" quarantine="" bug_ids="" unresolved="" disabled="" source_ref="" bug=""
scratch=""
trap '[ -z "$scratch" ] || rm -f "$scratch"' EXIT

emit() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$events"; }
listed() { case "$2" in *",$1,"*) return 0 ;; esac; return 1; }

# Splits one inventory row into the field variables and sets `bug` to its single canonical
# bug id, or '-'. A row fails unless it has exactly 8 non-empty tab-separated fields holding
# valid tokens. An empty field shifts the others under IFS whitespace splitting, so the last
# field then comes up empty and the row still fails.
parse_row() {
  local line="$1" tabs
  tabs="${line//[!$TAB]/}"
  [ "${#tabs}" -eq 7 ] || return 1
  IFS="$TAB" read -r case_id lane regression quarantine bug_ids unresolved disabled source_ref <<<"$line"
  [ -n "$source_ref" ] || return 1
  [[ "$case_id" =~ $SAFE_TOKEN ]] && [[ "$lane" =~ $SAFE_TOKEN ]] || return 1
  case "$regression" in true|false) ;; *) return 1 ;; esac
  case "$quarantine" in true|false) ;; *) return 1 ;; esac
  [ "$bug_ids" = - ] || [[ "$bug_ids" =~ $BUG_LIST ]] || return 1
  [ "$unresolved" = - ] || [[ "$unresolved" =~ $TOKEN_LIST ]] || return 1
  case "$disabled" in -|skip|fixme|expected-failure|conditional) ;; *) return 1 ;; esac
  [[ "$source_ref" =~ $SOURCE_TOKEN ]] || return 1
  bug=-
  if [[ "$bug_ids" =~ $BUG_ID ]]; then bug="$bug_ids"; fi
  return 0
}

# A missing, empty, or malformed inventory, or one that lists a case id twice, cannot be
# joined to events or to the ledger.
inventory_usable() {
  local line
  [ -f "$inventory" ] && [ -s "$inventory" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    parse_row "$line" || return 1
  done <"$inventory"
  awk -F '\t' 'seen[$1]++ { duplicate = 1 } END { exit duplicate }' "$inventory"
}

# The rows a mode hands to native selection: enabled product lanes (only the contract-smoke
# lane under a contract smoke), never quarantined rows, and the mode's regression filter.
selected() {
  [ "$quarantine" = false ] || return 1
  if [ "$contract_smoke" -eq 1 ]; then
    [ "$lane" = contract-smoke ] || return 1
  else
    listed "$lane" "$PRODUCT_LANES" && listed "$lane" ",$lanes," || return 1
  fi
  case "$mode" in
    baseline) [ "$regression" = false ] ;;
    defect-evidence|candidate-regression) [ "$regression" = true ] ;;
    full-suite) return 0 ;;
  esac
}

if ! inventory_usable; then
  printf 'inventory-gate: %s is missing, empty, or malformed (SD-3)\n' "$inventory" >&2
  emit test-inventory automation fail false n/a - test-inventory-invalid
  exit 1
fi
scratch="$(mktemp)"

if [ "$action" = executed ]; then
  touch "$events"
  # Each event counts for the longest inventory id that equals its case id or that the case
  # id extends with '.<suffix>' (evidence passes, counterfactual variants, cleanup), so a
  # collision id such as '<id>.2' never stands in for '<id>'.
  awk -F '\t' -v inventory="$inventory" '
    FILENAME == inventory { row[$1] = 1; next }
    {
      key = $1
      while (key != "") {
        if (key in row) { print key; break }
        cut = match(key, /[.][^.]*$/)
        if (cut == 0) break
        key = substr(key, 1, cut - 1)
      }
    }
  ' "$inventory" "$events" | sort -u >"$scratch"
  while IFS= read -r line || [ -n "$line" ]; do
    parse_row "$line"
    selected || continue
    if ! grep -Fxq -- "$case_id" "$scratch"; then
      printf 'inventory-gate: selected test %s produced no outcome\n' "$case_id" >&2
      emit "$case_id" skip skipped false n/a "$bug" selected-test-not-executed
    fi
  done <"$inventory"
  exit 0
fi

# static. The confirmed-bug list (SD-4) holds one canonical id per line.
expected_list=, expected_invalid=0
if [ -f "$expected_bugs" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    if [[ "$line" =~ $BUG_ID ]]; then expected_list="$expected_list$line,"; else expected_invalid=1; fi
  done <"$expected_bugs"
elif [ "$mode" != baseline ]; then
  printf 'inventory-gate: %s is missing; the confirmed defects cannot be proven\n' "$expected_bugs" >&2
  emit expected-bugs policy denied false n/a - expected-bugs-missing
fi
if [ "$expected_invalid" -ne 0 ]; then
  printf 'inventory-gate: %s holds a line that is not a canonical BUG-NNNN id\n' "$expected_bugs" >&2
  emit expected-bugs policy denied false n/a - expected-bugs-invalid
fi

# Row rules. The scratch file collects every bug a runnable regression covers.
while IFS= read -r line || [ -n "$line" ]; do
  parse_row "$line"
  case "$lane" in
    -) emit "$case_id" automation fail false n/a - lane-undeclared ;;
    ambiguous) emit "$case_id" automation fail false n/a - lane-ambiguous ;;
    *) listed "$lane" "$KNOWN_LANES" || emit "$case_id" automation fail false n/a - lane-undeclared ;;
  esac
  if [ "$bug_ids" != - ] && [ "$bug" = - ]; then emit "$case_id" automation fail false n/a - multiple-bug-provenance; fi
  if [ "$unresolved" != - ]; then emit "$case_id" policy denied false n/a - bug-provenance-unresolved; fi
  if [ "$regression" = false ]; then
    if [ "$bug_ids" != - ]; then emit "$case_id" automation fail false n/a "$bug" bug-provenance-without-regression; fi
    continue
  fi
  if [ "$bug_ids" = - ] && [ "$unresolved" = - ]; then emit "$case_id" automation fail false n/a - regression-without-provenance; fi
  if [ "$disabled" != - ]; then emit "$case_id" policy denied false n/a "$bug" "regression-disabled.$disabled"; fi
  # A contract smoke selects only its own lane, so product-lane state says nothing there.
  if [ "$contract_smoke" -eq 0 ] && listed "$lane" "$PRODUCT_LANES" && ! listed "$lane" ",$lanes,"; then
    emit "$case_id" policy denied false n/a "$bug" regression-in-disabled-lane
  fi
  if [ "$bug" != - ] && ! listed "$bug" "$expected_list"; then
    emit "$case_id" policy denied false n/a "$bug" regression-for-unconfirmed-bug
  fi
  if [ "$bug" != - ] && [ "$quarantine" = false ] && [ "$disabled" = - ] && listed "$lane" ",$lanes,"; then
    printf '%s\n' "$bug" >>"$scratch"
  fi
done <"$inventory"

# Outside baseline every confirmed defect needs a runnable regression bound to it alone.
if [ "$mode" != baseline ] && [ -f "$expected_bugs" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ $BUG_ID ]] || continue
    if ! grep -Fxq -- "$line" "$scratch"; then
      printf 'inventory-gate: confirmed defect %s has no runnable regression\n' "$line" >&2
      emit "bug-coverage.$line" policy denied false n/a "$line" bug-uncovered
    fi
  done <"$expected_bugs"
fi

# Static focus scan over the JavaScript and TypeScript sources below the test root. grep
# exits 1 when nothing matches; any other failure is a scan that proved nothing.
if [ -d "$test_root" ]; then
  : >"$scratch"
  set +e
  grep -RIlE --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.cjs' \
    --exclude-dir=node_modules -e "$FOCUS_PATTERN" -- "$test_root" >"$scratch"
  status=$?
  set -e
  case "$status" in
    0)
      sed 's/^/inventory-gate: focused test in /' "$scratch" >&2
      emit focus-scan policy denied false n/a - focused-test-forbidden
      ;;
    1) ;;
    *)
      printf 'inventory-gate: the focused-test scan of %s failed\n' "$test_root" >&2
      emit focus-scan automation fail false n/a - focus-scan-failed
      ;;
  esac
fi
exit 0
