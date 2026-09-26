#!/usr/bin/env bash
# Portable Argus quarantine evaluator shared by every runtime template.
# --inventory (preferred) joins the ledger to reports/test-inventory.tsv (SD-3): every
# quarantined test needs a ledger row, every ledger row needs a quarantined test, and a
# regression test is never quarantinable. --tagged-count is the legacy tag-count check.
set -euo pipefail

events="" ledger="solution/quarantine.tsv" tagged_count="" inventory=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --events) events="${2:-}"; shift 2 ;;
    --ledger) ledger="${2:-}"; shift 2 ;;
    --tagged-count) tagged_count="${2:-}"; shift 2 ;;
    --inventory) inventory="${2:-}"; shift 2 ;;
    *) printf 'quarantine-contract: unknown option %s\n' "$1" >&2; exit 14 ;;
  esac
done
[ -n "$events" ] || exit 14
if [ -n "$inventory" ]; then
  [ -z "$tagged_count" ] && [ -f "$inventory" ] || exit 14
else
  [[ "$tagged_count" =~ ^[0-9]+$ ]] || exit 14
fi

entries=0 invalid=0 today="${ARGUS_TODAY:-$(date -u +%F)}"
quarantined="" registered="" accepted=""
if [ -n "$inventory" ]; then
  quarantined="$(mktemp)" registered="$(mktemp)" accepted="$(mktemp)"
  trap 'rm -f "$quarantined" "$registered" "$accepted"' EXIT
  # case_id, regression flag, and bug ids of every quarantined inventory row. An empty case
  # id becomes '!' so it fails the case-id check instead of shifting the fields.
  awk -F '\t' '$4 == "true" { print ($1 == "" ? "!" : $1) "\t" ($3 == "" ? "-" : $3) "\t" ($5 == "" ? "-" : $5) }' "$inventory" >"$quarantined"
fi
if [ -f "$ledger" ]; then
  while IFS=$'\t' read -r case_id owner reason expires_on issue extra; do
    [ -z "$case_id" ] && continue
    [[ "$case_id" == \#* ]] && continue
    entries=$((entries + 1))
    [ -z "$registered" ] || printf '%s\n' "$case_id" >>"$registered"
    if [ -n "${extra:-}" ] || [[ ! "$case_id" =~ ^[A-Za-z0-9_.:-]+$ ]] || [[ ! "$owner" =~ ^[a-z][a-z0-9-]*$ ]] || [[ ! "$reason" =~ ^[A-Za-z0-9_.:-]+$ ]] || [[ ! "$expires_on" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || [[ ! "$issue" =~ ^(#[0-9]+|[A-Z][A-Z0-9-]*-[0-9]+)$ ]]; then
      printf 'quarantine-ledger\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-entry-invalid\n' >>"$events"
      invalid=1
      continue
    fi
    if [ -n "$inventory" ]; then
      regression="$(awk -F '\t' -v id="$case_id" '$1 == id { print $2; exit }' "$quarantined")"
      if [ -z "$regression" ]; then
        printf '%s\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-entry-orphaned\n' "$case_id" >>"$events"
        invalid=1
        continue
      fi
      if grep -Fxq -- "$case_id" "$accepted"; then
        printf 'quarantine-ledger\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-entry-invalid\n' >>"$events"
        invalid=1
        continue
      fi
      printf '%s\n' "$case_id" >>"$accepted"
      # A quarantined regression is denied from the inventory side and never becomes an
      # approved skip, even with a ledger row.
      [ "$regression" != true ] || continue
    fi
    if [[ "$expires_on" < "$today" ]]; then
      printf '%s\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-expired\n' "$case_id" >>"$events"
      invalid=1
      continue
    fi
    printf '%s\tskip\tskipped\ttrue\tn/a\t-\tquarantine.%s\n' "$case_id" "$reason" >>"$events"
  done <"$ledger"
fi
if [ -n "$inventory" ]; then
  while IFS=$'\t' read -r case_id regression bug_ids; do
    if [[ ! "$case_id" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
      printf 'quarantine-inventory\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-inventory-invalid\n' >>"$events"
      invalid=1
      continue
    fi
    if [ "$regression" = true ]; then
      bug_id=-
      [[ ! "$bug_ids" =~ ^BUG-[0-9]{4}$ ]] || bug_id="$bug_ids"
      printf '%s\tpolicy\tdenied\tfalse\tn/a\t%s\tregression-quarantine-forbidden\n' "$case_id" "$bug_id" >>"$events"
      invalid=1
    fi
    if ! grep -Fxq -- "$case_id" "$registered"; then
      printf '%s\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-unregistered\n' "$case_id" >>"$events"
      invalid=1
    fi
  done <"$quarantined"
elif [ "$entries" -ne "$tagged_count" ]; then
  printf 'quarantine-ledger\tpolicy\tdenied\tfalse\tn/a\t-\tquarantine-count-mismatch\n' >>"$events"
  invalid=1
fi
[ "$invalid" -eq 0 ]
