#!/usr/bin/env bash
# Portable Argus defect-evidence gate shared by every runtime template (SD-6, SD-10). After
# the defect-evidence passes it proves, for every confirmed bug in reports/expected-bugs.txt,
# that the regression reproduced in the live and repeat passes and that the bug's
# counterfactual plan was carried out. Adapters only write reports/counterfactual-plan.tsv;
# this gate is the only emitter of plan-derived events.
#
# A missing proof is a policy denial unless the same pass already gave the bug a failing
# verdict (flaky-red, counterfactual-correct-red, counterfactual-tamper-survived, a timeout,
# ...). runner-contract.sh fails that verdict under its own category, and a second denial
# would only hide it behind exit 13, so a denial is never withheld without another event
# that already fails the run.
#
#   evidence-gate.sh --expected-bugs <file> --plan <file> --events <file>
#       appends one event per unproven check and exits 0
#   evidence-gate.sh --plan <file> --list-passes
#       prints the counterfactual passes the plan needs, one per line: cf-correct when any
#       row is a fixture or an exemption, then cf-tamper-1..N for the largest tamper count
set -euo pipefail

usage() {
  printf 'usage: evidence-gate.sh --expected-bugs <file> --plan <file> --events <file>\n' >&2
  printf '       evidence-gate.sh --plan <file> --list-passes\n' >&2
  exit 14
}

expected_bugs="" plan="" events="" list_passes=0
while [ "$#" -gt 0 ]; do
  if [ "$1" = --list-passes ]; then list_passes=1; shift; continue; fi
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --expected-bugs) expected_bugs="$2" ;;
    --plan) plan="$2" ;;
    --events) events="$2" ;;
    *) printf 'evidence-gate: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
  shift 2
done
[ -n "$plan" ] || usage
if [ "$list_passes" -eq 0 ]; then
  [ -n "$expected_bugs" ] && [ -n "$events" ] || usage
fi

BUG_ID='^BUG-[0-9]{4}$'
TAMPER_LIST='^[a-z0-9-]{1,40}(,[a-z0-9-]{1,40})*$'
EXEMPTIONS=,front-end-logic,timing-or-load,data-layer,fault-injection,non-http-protocol,
INVALID_REASONS=,schema-invalid,missing-observed-defect,correct-violates-contract,
TAB=$'\t'
plan_bug="" plan_status="" plan_tampers="" plan_reason="" facts=""
trap '[ -z "$facts" ] || rm -f "$facts"' EXIT

emit() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$events"; }
listed() { case "$2" in *",$1,"*) return 0 ;; esac; return 1; }

# Splits one SD-10 plan row into the plan_* variables. The row fails unless its 4 fields
# agree: a fixture names unique tamper ids and no reason, an exemption or an invalid fixture
# names a known reason, and a missing fixture names none.
parse_plan_row() {
  local line="$1" tabs
  tabs="${line//[!$TAB]/}"
  [ "${#tabs}" -eq 3 ] || return 1
  IFS="$TAB" read -r plan_bug plan_status plan_tampers plan_reason <<<"$line"
  [ -n "$plan_reason" ] && [[ "$plan_bug" =~ $BUG_ID ]] || return 1
  [ "$plan_tampers" = - ] || [[ "$plan_tampers" =~ $TAMPER_LIST ]] || return 1
  case "$plan_status" in
    fixture)
      [ "$plan_tampers" != - ] && [ "$plan_reason" = - ] || return 1
      [ -z "$(tr ',' '\n' <<<"$plan_tampers" | sort | uniq -d)" ]
      ;;
    exempt) listed "$plan_reason" "$EXEMPTIONS" ;;
    invalid) listed "$plan_reason" "$INVALID_REASONS" ;;
    missing) [ "$plan_reason" = - ] ;;
    *) return 1 ;;
  esac
}

# A damaged plan (an unparseable row, or two rows for one bug) is treated as no plan at all,
# so it can never stand in for a weaker proof.
plan_usable() {
  local line
  [ -f "$plan" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    parse_plan_row "$line" || return 1
  done <"$plan"
  awk -F '\t' 'NF && seen[$1]++ { duplicate = 1 } END { exit duplicate }' "$plan"
}

# Loads the plan row of bug $1 into the plan_* variables; fails when the bug has none.
plan_row_for() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    parse_plan_row "$line" || return 1
    if [ "$plan_bug" = "$1" ]; then return 0; fi
  done <"$plan"
  return 1
}

tamper_count() {
  local ids=()
  IFS=, read -r -a ids <<<"$plan_tampers"
  printf '%s\n' "${#ids[@]}"
}

if [ "$list_passes" -eq 1 ]; then
  correct=0 tampers=0
  if plan_usable; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      parse_plan_row "$line"
      case "$plan_status" in
        fixture)
          correct=1
          count="$(tamper_count)"
          if [ "$count" -gt "$tampers" ]; then tampers="$count"; fi
          ;;
        exempt) correct=1 ;;
      esac
    done <"$plan"
  fi
  if [ "$correct" -eq 1 ]; then printf 'cf-correct\n'; fi
  pass=1
  while [ "$pass" -le "$tampers" ]; do
    printf 'cf-tamper-%s\n' "$pass"
    pass=$((pass + 1))
  done
  exit 0
fi

[ -f "$expected_bugs" ] || exit 0
touch "$events"
facts="$(mktemp)"
# One fact per line, keyed by bug: the proofs SD-6 defines, and `answered <bug> <pass>` for
# an event that already fails the run under runner-contract.sh's defect-evidence rules. The
# pass comes from the SD-2 case-id suffix (.repeat, .cf-correct, .cf, .cf-<tamper>, then an
# optional .cleanup); an id without one belongs to the live pass.
awk -F '\t' '
  NF != 7 || $6 !~ /^BUG-[0-9][0-9][0-9][0-9]$/ { next }
  {
    bug = $6
    id = $1
    red = ($2 == "product" && $3 == "fail" && $4 == "true")
    if (red && $7 == "expected-red") print "live-red\t" bug
    if (red && $7 == "expected-red-repeat") print "repeat-red\t" bug
    if ($7 == "intermittent-unreproduced") print "intermittent\t" bug
    if ($2 == "product" && $3 == "pass" && $7 == "counterfactual-correct-pass") print "correct\t" bug "\t" id
    if ($2 == "policy" && $3 == "pass" && index($7, "counterfactual-exempt.") == 1) {
      print "exempt\t" bug "\t" substr($7, length("counterfactual-exempt.") + 1)
    }
    if (red && $7 == "counterfactual-tamper-red" && match(id, /[.]cf-[a-z0-9-]+$/)) {
      print "tamper\t" bug "\t" substr(id, RSTART + 4)
    }
    failing = ($2 == "policy" && $3 == "denied") ||
      (($2 == "automation" || $2 == "infrastructure") && $3 == "fail") ||
      ($2 == "skip" && $3 == "skipped" && $4 == "false") ||
      ($2 == "product" && $3 == "fail" && !($4 == "true" && ($5 == "reproduced" || $5 == "automated"))) ||
      ($2 == "product" && $3 == "pass" && $4 == "true")
    if (failing) {
      sub(/[.]cleanup$/, "", id)
      pass = "live"
      if (id ~ /[.]repeat$/) pass = "repeat"
      else if (id ~ /[.]cf(-correct)?$/) pass = "cf-correct"
      else if (match(id, /[.]cf-[a-z0-9-]+$/)) pass = substr(id, RSTART + 1)
      print "answered\t" bug "\t" pass
    }
  }
' "$events" >"$facts"

fact() { grep -Fxq -- "$1" "$facts"; }

# A fixture is carried out by a counterfactual-correct pass and a RED under every tamper; each
# proof may instead be answered by a failing verdict of its own pass. Every case of the bug
# reports its own verdict (each invocation of a template or parametrized regression is a case,
# and any failing one fails the run), but one case id passing twice is a damaged record (-1).
fixture_complete() {
  local bug="$1" correct tamper
  local ids=()
  correct="$(awk -F '\t' -v bug="$bug" '$1 == "correct" && $2 == bug { n++; if (seen[$3]++) twice = 1 }
    END { print twice ? -1 : n + 0 }' "$facts")"
  [ "$correct" -ge 0 ] || return 1
  if [ "$correct" -eq 0 ]; then fact "answered$TAB$bug${TAB}cf-correct" || return 1; fi
  IFS=, read -r -a ids <<<"$plan_tampers"
  for tamper in "${ids[@]}"; do
    fact "tamper$TAB$bug$TAB$tamper" || fact "answered$TAB$bug${TAB}cf-$tamper" || return 1
  done
  return 0
}

usable=0
if plan_usable; then usable=1; else printf 'evidence-gate: %s is missing or damaged (SD-10)\n' "$plan" >&2; fi
while IFS= read -r bug || [ -n "$bug" ]; do
  [[ "$bug" =~ $BUG_ID ]] || continue
  live=0 repeat=0
  if fact "live-red$TAB$bug" || fact "answered$TAB$bug${TAB}live"; then live=1; fi
  if fact "repeat-red$TAB$bug" || fact "answered$TAB$bug${TAB}repeat"; then repeat=1; fi
  if fact "intermittent$TAB$bug"; then
    # SD-6: an intermittent defect (n > 1) is RED when any live or repeat invocation shows
    # the violation; a bug whose invocations were all unreproduced has no RED at all.
    if [ "$live" -eq 0 ] && [ "$repeat" -eq 0 ]; then
      emit "evidence.$bug" policy denied false n/a "$bug" evidence-live-red-missing
    fi
  else
    if [ "$live" -eq 0 ]; then emit "evidence.$bug" policy denied false n/a "$bug" evidence-live-red-missing; fi
    if [ "$repeat" -eq 0 ]; then emit "evidence.$bug" policy denied false n/a "$bug" evidence-repeat-red-missing; fi
  fi

  if [ "$usable" -eq 0 ] || ! plan_row_for "$bug"; then
    emit "counterfactual.$bug" policy denied false n/a "$bug" counterfactual-plan-missing
    continue
  fi
  case "$plan_status" in
    missing) emit "counterfactual.$bug" policy denied false n/a "$bug" counterfactual-missing ;;
    invalid) emit "counterfactual.$bug" automation fail false n/a "$bug" "counterfactual-fixture-invalid.$plan_reason" ;;
    fixture)
      if ! fixture_complete "$bug"; then
        emit "counterfactual.$bug" policy denied false n/a "$bug" counterfactual-incomplete
      fi
      ;;
    exempt)
      if ! fact "exempt$TAB$bug$TAB$plan_reason" && ! fact "answered$TAB$bug${TAB}cf-correct"; then
        emit "counterfactual.$bug" policy denied false n/a "$bug" counterfactual-incomplete
      fi
      ;;
  esac
done <"$expected_bugs"
exit 0
