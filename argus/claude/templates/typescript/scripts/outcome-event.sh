#!/usr/bin/env bash
# Append one validated Argus runner outcome event. Safe for parallel test processes.
set -euo pipefail
[ "$#" -eq 7 ] || { echo "usage: outcome-event.sh <case> <category> <status> <expected> <lifecycle> <bug-id|-> <reason>" >&2; exit 14; }
case_id="$1" category="$2" status="$3" expected="$4" lifecycle="$5" bug_id="$6" reason="$7"
[[ "$case_id" =~ ^[A-Za-z0-9_.:-]+$ ]] && [[ "$reason" =~ ^[A-Za-z0-9_.:-]+$ ]] || exit 14
case "$category" in product|automation|infrastructure|skip|policy) ;; *) exit 14 ;; esac
case "$status" in pass|fail|skipped|denied) ;; *) exit 14 ;; esac
case "$expected" in true|false) ;; *) exit 14 ;; esac
case "$lifecycle" in discovered|reproduced|automated|fixed|closed|n/a) ;; *) exit 14 ;; esac
if [ "$bug_id" != - ] && [[ ! "$bug_id" =~ ^BUG-[0-9]{4}$ ]]; then exit 14; fi

events="${ARGUS_OUTCOME_FILE:-reports/outcomes.raw.tsv}"
mkdir -p "$(dirname "$events")"
lock="${events}.lock"
acquired=0
for _ in $(seq 1 500); do
  if mkdir "$lock" 2>/dev/null; then acquired=1; break; fi
  sleep 0.01
done
[ "$acquired" -eq 1 ] || { echo "outcome-event: lock timeout" >&2; exit 12; }
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$case_id" "$category" "$status" "$expected" "$lifecycle" "$bug_id" "$reason" >>"$events"
