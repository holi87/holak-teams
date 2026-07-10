#!/usr/bin/env bash
# Portable Argus runner-mode contract evaluator. Keep byte-identical in all templates.
set -euo pipefail

mode="" events="" output="" runner_exit="0"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --events) events="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --runner-exit) runner_exit="${2:-}"; shift 2 ;;
    *) printf 'runner-contract: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
done

case "$mode" in baseline|defect-evidence|candidate-regression|full-suite) ;; *) exit 14 ;; esac
[[ "$runner_exit" =~ ^[0-9]+$ ]] || exit 14
[ -n "$events" ] && [ -n "$output" ] || exit 14
mkdir -p "$(dirname "$output")"

contract_error=0
temporary=""
if [ ! -s "$events" ]; then
  if [ "$mode" = defect-evidence ]; then
    contract_error=1
  else
    temporary="$(mktemp)"
    events="$temporary"
    if [ "$runner_exit" -eq 0 ]; then
      printf 'suite\tproduct\tpass\tfalse\tn/a\t-\tsuite-passed\n' >"$events"
    else
      printf 'runner\tinfrastructure\tfail\tfalse\tn/a\t-\tunclassified-runner-failure\n' >"$events"
    fi
  fi
fi

product=0 automation=0 infrastructure=0 skip=0 policy=0 expected_red=0 violations=0
product_violation=0 automation_violation=0 infrastructure_violation=0 skip_violation=0 policy_violation=0
event_count=0

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
    if [ "$category" = skip ] && [ "$status" = skipped ] && [ "$expected" = false ]; then skip_violation=1; fi
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

if [ "$event_count" -eq 0 ]; then contract_error=1; fi
if [ "$mode" = defect-evidence ]; then
  if [ "$expected_red" -eq 0 ] || [ "$runner_exit" -eq 0 ]; then contract_error=1; fi
elif [ "$runner_exit" -ne 0 ] && [ "$product_violation" -eq 0 ] && [ "$automation_violation" -eq 0 ] && [ "$infrastructure_violation" -eq 0 ] && [ "$policy_violation" -eq 0 ]; then
  infrastructure_violation=1
fi

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
