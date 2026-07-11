#!/usr/bin/env bash
# Portable Argus quarantine evaluator. Keep byte-identical in all templates.
set -euo pipefail

events="" ledger="solution/quarantine.tsv" tagged_count=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --events) events="${2:-}"; shift 2 ;;
    --ledger) ledger="${2:-}"; shift 2 ;;
    --tagged-count) tagged_count="${2:-}"; shift 2 ;;
    *) printf 'quarantine-contract: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
done
[ -n "$events" ] && [[ "$tagged_count" =~ ^[0-9]+$ ]] || exit 14

entries=0 invalid=0 today="${ARGUS_TODAY:-$(date -u +%F)}"
if [ -f "$ledger" ]; then
  while IFS=$'\t' read -r case_id owner reason expires_on issue extra; do
    [ -z "$case_id" ] && continue
    [[ "$case_id" == \#* ]] && continue
    entries=$((entries + 1))
    if [ -n "${extra:-}" ] || [[ ! "$case_id" =~ ^[A-Za-z0-9_.:-]+$ ]] || [[ ! "$owner" =~ ^[a-z][a-z0-9-]*$ ]] || [[ ! "$reason" =~ ^[A-Za-z0-9_.:-]+$ ]] || [[ ! "$expires_on" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || [[ ! "$issue" =~ ^(#[0-9]+|[A-Z][A-Z0-9-]*-[0-9]+)$ ]]; then
      printf 'quarantine-ledger\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-entry-invalid\n' >>"$events"
      invalid=1
      continue
    fi
    if [[ "$expires_on" < "$today" ]]; then
      printf '%s\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-expired\n' "$case_id" >>"$events"
      invalid=1
      continue
    fi
    printf '%s\tskip\tskipped\ttrue\tn/a\t-\tquarantine.%s\n' "$case_id" "$reason" >>"$events"
  done <"$ledger"
fi
if [ "$entries" -ne "$tagged_count" ]; then
  printf 'quarantine-ledger\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-count-mismatch\n' >>"$events"
  invalid=1
fi
[ "$invalid" -eq 0 ]
