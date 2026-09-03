#!/usr/bin/env bash
# Portable Argus runner-mode contract evaluator shared by every runtime template.
set -euo pipefail

mode="" events="" output="" runner_exit="0" quarantine="" expected_bugs=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --events) events="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --runner-exit) runner_exit="${2:-}"; shift 2 ;;
    --quarantine) quarantine="${2:-}"; shift 2 ;;
    --expected-bugs) expected_bugs="${2:-}"; shift 2 ;;
    *) printf 'runner-contract: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
done

case "$mode" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) exit 14 ;; esac
[[ "$runner_exit" =~ ^[0-9]+$ ]] || exit 14
[ -n "$events" ] && [ -n "$output" ] || exit 14
mkdir -p "$(dirname "$output")"

contract_error=0
temporary=""
# An empty event file is a broken adapter, never a green suite. Synthesising `suite-passed`
# here once let a run with no evidence at all report status pass and exit 0, which is the
# exact shape of the failure this contract exists to prevent. A missing event stream now
# fails closed in every mode; only an already-failing native runner may be summarised, and
# only as an unclassified infrastructure failure.
empty_selection=0
if [ ! -s "$events" ]; then
  if [ "$runner_exit" -ne 0 ]; then
    temporary="$(mktemp)"
    events="$temporary"
    printf 'runner\tinfrastructure\tfail\tfalse\tn/a\t-\tunclassified-runner-failure\n' >"$events"
  elif [ "$mode" = candidate-regression ]; then
    # Nothing was selected to prove. That is not a pass: it is required coverage that did
    # not execute, and it exits 15 like any other unexecuted-coverage outcome.
    empty_selection=1
  else
    contract_error=1
  fi
fi

product=0 automation=0 infrastructure=0 skip=0 policy=0 expected_red=0
product_violation=0 automation_violation=0 infrastructure_violation=0 skip_violation=0 policy_violation=0
event_count=0 missing_expected=0
seen_bugs="$(mktemp)"
trap 'rm -f "$seen_bugs"' EXIT

if [ "$contract_error" -eq 0 ]; then
  while IFS=$'\t' read -r case_id category status expected lifecycle bug_id reason extra; do
    [ -z "${extra:-}" ] || { contract_error=1; break; }
    [[ "$case_id" =~ ^[A-Za-z0-9_.:-]+$ ]] || { contract_error=1; break; }
    [[ "$reason" =~ ^[A-Za-z0-9_.:-]+$ ]] || { contract_error=1; break; }
    case "$category" in product|automation|infrastructure|skip|policy) ;; *) contract_error=1; break ;; esac
    case "$status" in pass|fail|skipped|denied) ;; *) contract_error=1; break ;; esac
    case "$expected" in true|false) ;; *) contract_error=1; break ;; esac
    case "$lifecycle" in discovered|reproduced|automated|fixed|closed|n/a) ;; *) contract_error=1; break ;; esac
    if [ "$bug_id" != - ] && [[ ! "$bug_id" =~ ^BUG-[0-9]{4}$ ]]; then contract_error=1; break; fi
    event_count=$((event_count + 1))
    case "$category" in
      product) product=$((product + 1)) ;;
      automation) automation=$((automation + 1)) ;;
      infrastructure) infrastructure=$((infrastructure + 1)) ;;
      skip) skip=$((skip + 1)) ;;
      policy) policy=$((policy + 1)) ;;
    esac

    if [ "$category" = policy ] && [ "$status" = denied ]; then policy_violation=1; fi
    if [ "$category" = infrastructure ] && [ "$status" = fail ]; then infrastructure_violation=1; fi
    if [ "$category" = automation ] && [ "$status" = fail ]; then automation_violation=1; fi
    # `expected=true` is a flag the adapter writes about itself, so it cannot also be the
    # proof that the skip was approved. An approved skip must carry a quarantine row whose
    # case id matches; anything else is an unapproved skip and breaks the gate.
    if [ "$category" = skip ] && [ "$status" = skipped ]; then
      if [ "$expected" = false ]; then
        skip_violation=1
      elif [ -n "$quarantine" ] && [ -f "$quarantine" ]; then
        cut -f1 "$quarantine" | grep -Fxq "$case_id" || skip_violation=1
      else
        skip_violation=1
      fi
    fi
    [ "$bug_id" = - ] || printf '%s\n' "$bug_id" >>"$seen_bugs"
    if [ "$category" = product ]; then
      if [ "$mode" = defect-evidence ]; then
        if [ "$status" = fail ] && [ "$expected" = true ] && [ "$bug_id" != - ] && { [ "$lifecycle" = reproduced ] || [ "$lifecycle" = automated ]; }; then
          expected_red=$((expected_red + 1))
        elif [ "$status" = fail ] || { [ "$status" = pass ] && [ "$expected" = true ]; }; then
          product_violation=1
        fi
      elif [ "$status" = fail ]; then
        product_violation=1
      fi
    fi
  done <"$events"
fi

if [ "$event_count" -eq 0 ] && [ "$empty_selection" -eq 0 ]; then contract_error=1; fi
if [ "$empty_selection" -ne 0 ]; then skip_violation=1; fi

# A selector that quietly drops half the regression suite used to look identical to a suite
# that ran it. When the caller names the confirmed defects, every one of them must appear as
# an event: absence is a gate failure, not a smaller run.
if [ -n "$expected_bugs" ] && [ "$mode" != baseline ]; then
  if [ ! -f "$expected_bugs" ]; then
    contract_error=1
  else
    while IFS= read -r wanted; do
      [ -n "$wanted" ] || continue
      grep -Fxq "$wanted" "$seen_bugs" || missing_expected=$((missing_expected + 1))
    done <"$expected_bugs"
  fi
fi

if [ "$mode" = defect-evidence ]; then
  if [ "$expected_red" -eq 0 ] || [ "$runner_exit" -eq 0 ]; then contract_error=1; fi
elif [ "$runner_exit" -ne 0 ] && [ "$product_violation" -eq 0 ] && [ "$automation_violation" -eq 0 ] && [ "$infrastructure_violation" -eq 0 ] && [ "$policy_violation" -eq 0 ]; then
  infrastructure_violation=1
fi

if [ "$missing_expected" -ne 0 ]; then policy_violation=1; fi

exit_code=0
if [ "$contract_error" -ne 0 ]; then exit_code=14
elif [ "$policy_violation" -ne 0 ]; then exit_code=13
elif [ "$infrastructure_violation" -ne 0 ]; then exit_code=12
elif [ "$automation_violation" -ne 0 ]; then exit_code=11
elif [ "$product_violation" -ne 0 ]; then exit_code=10
elif [ "$skip_violation" -ne 0 ]; then exit_code=15
fi

tmp_output="${output}.$$.$RANDOM.tmp"
{
  printf '{\n  "$schema": "argus/runner-result@1",\n  "schemaVersion": 1,\n'
  printf '  "mode": "%s",\n  "status": "%s",\n  "exitCode": %s,\n' "$mode" "$([ "$exit_code" -eq 0 ] && printf pass || printf fail)" "$exit_code"
  # Provenance so a reader holding only this file can tell what it is evidence of. Without
  # it, a defect-evidence result overwriting a delivery gate result is indistinguishable
  # from the delivery gate passing.
  printf '  "generatedAt": "%s",\n  "deliveryGate": %s,\n  "missingExpectedBugs": %s,\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$([ "$mode" = full-suite ] && printf true || printf false)" "$missing_expected"
  printf '  "categories": {"product": %s, "automation": %s, "infrastructure": %s, "skip": %s, "policy": %s},\n' "$product" "$automation" "$infrastructure" "$skip" "$policy"
  printf '  "events": ['
  comma=""
  if [ -s "$events" ]; then
    while IFS=$'\t' read -r case_id category status expected lifecycle bug_id reason extra; do
      [ -z "${extra:-}" ] || continue
      printf '%s\n    {"caseId":"%s","category":"%s","status":"%s","expected":%s,"lifecycle":"%s","bugId":%s,"reason":"%s"}' \
        "$comma" "$case_id" "$category" "$status" "$expected" "$lifecycle" "$([ "$bug_id" = - ] && printf null || printf '"%s"' "$bug_id")" "$reason"
      comma=,
    done <"$events"
  fi
  [ -z "$comma" ] || printf '\n  '
  printf ']\n}\n'
} >"$tmp_output"
mv "$tmp_output" "$output"
[ -z "$temporary" ] || rm -f "$temporary"
exit "$exit_code"
