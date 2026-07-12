#!/usr/bin/env bash
# Verify packaged target immutability and deterministic, resumable engagement coordination.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
WORK="$(mktemp -d)"
HOST="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOST"' EXIT

source "$ROOT/scripts/lib/argus-smoke-model-control.sh"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

# Exercise canonical runtime state migration and adversarial filesystem cases
# independently from the packaged CLI wiring checked below.
node "$ROOT/scripts/smoke-argus-engagement-state.mjs"

token_for() {
  jq -r .token "$ALLOCATIONS/$1.json"
}

digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

guard_write() {
  local path="$1" expected_rule="$2" output
  output="$(jq -nc --arg cwd "$TARGET" --arg path "$path" \
    '{tool_name:"Write",cwd:$cwd,tool_input:{file_path:$path,content:"not audited"}}' | "$CLI" guard)"
  if [ "$expected_rule" = allow ]; then
    [ -z "$output" ] || fail "allowed Write was denied: $path: $output"
  else
    grep -Fq "$expected_rule" <<<"$output" || fail "Write $path did not return $expected_rule: $output"
  fi
}

guard_shell() {
  local command="$1" expected_rule="$2" output
  output="$(jq -nc --arg cwd "$TARGET" --arg command "$command" \
    '{tool_name:"Bash",cwd:$cwd,tool_input:{command:$command}}' | "$CLI" guard)"
  if [ "$expected_rule" = allow ]; then
    [ -z "$output" ] || fail "allowed Bash was denied: $command: $output"
  else
    grep -Fq "$expected_rule" <<<"$output" || fail "Bash did not return $expected_rule: $output"
  fi
}

TARGET="$WORK/target"
ALLOCATIONS="$WORK/allocations"
mkdir -p "$TARGET/app" "$TARGET/tests" "$TARGET/reports" "$TARGET/solution" "$ALLOCATIONS"
printf 'application source\n' >"$TARGET/app/source.ts"
ln -s ../app "$TARGET/tests/symlink-app"

"$CLI" engagement init --target "$TARGET" --artifact-root "$TARGET" --mode A --engagement-id phase0-smoke >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
"$CLI" engagement validate --manifest "$MANIFEST" >/dev/null
argus_smoke_prepare_model_control "$CLI" "$MANIFEST" "$TARGET" "$TARGET" A \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST/main"

# Parallel allocation is atomic and every resource coordinate is unique.
lanes=(odysseus kalchas metis minos tyche hermes atlas)
argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST/main" odysseus >"$ALLOCATIONS/odysseus.json"
CONTROLLER_TOKEN="$(token_for odysseus)"
for lane in "${lanes[@]:1}"; do
  argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST/main" "$lane" "$CONTROLLER_TOKEN" >"$ALLOCATIONS/$lane.json" &
done
wait
for field in port accountAlias dataNamespace browserProfile outputDirectory; do
  count="$(jq -r ".$field" "$ALLOCATIONS"/*.json | sort -u | wc -l | tr -d ' ')"
  [ "$count" -eq "${#lanes[@]}" ] || fail "parallel allocations collide on $field"
done

# Heartbeats use a bounded append command; they are progress only, never evidence.
"$CLI" engagement heartbeat --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --phase discovery --completed 0 --total 4 --status started >/dev/null
"$CLI" engagement heartbeat --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --completed 1 --total 4 --status running >/dev/null
grep -Eq $'^[^\t]+\todysseus\tdiscovery\t0/4\tstarted\t[a-f0-9]{24}\t[^\t]+\t1$' "$TARGET/ai_agents_internal/heartbeat/odysseus.log" || fail 'controller heartbeat generation format drifted'
grep -Eq $'^[^\t]+\thermes\thunting\t1/4\trunning\t[a-f0-9]{24}\t[^\t]+\t1$' "$TARGET/ai_agents_internal/heartbeat/hermes.log" || fail 'worker heartbeat generation format drifted'
ln -s "$TARGET/app/source.ts" "$TARGET/ai_agents_internal/heartbeat/atlas.log"
if "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" --phase automation --completed 1 --total 4 --status running >/dev/null 2>&1; then
  fail 'heartbeat followed a symbolic-link log'
fi
grep -Fxq 'application source' "$TARGET/app/source.ts" || fail 'heartbeat modified a symbolic-link target'
rm "$TARGET/ai_agents_internal/heartbeat/atlas.log"
if "$CLI" engagement heartbeat --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --completed 5 --total 4 --status running >/dev/null 2>&1; then
  fail 'heartbeat accepted impossible progress'
fi

# Persisted allocation paths are derived from the manifest, never trusted from state.
STATE="$TARGET/ai_agents_internal/engagement-state.json"
cp "$STATE" "$WORK/engagement-state.clean.json"
mkdir -p "$WORK/state-poison-victim"
printf 'outside sentinel\n' >"$WORK/state-poison-victim/sentinel.txt"
for field in browserProfile browserArtifactsDirectory authDirectory temporaryDirectory outputDirectory; do
  jq --arg field "$field" --arg victim "$WORK/state-poison-victim" \
    'setpath(["allocations", "atlas", $field]; $victim)' "$WORK/engagement-state.clean.json" >"$STATE"
  if "$CLI" engagement cleanup --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" --outcome failure >/dev/null 2>&1; then
    fail "cleanup trusted poisoned allocation field: $field"
  fi
  test -f "$WORK/state-poison-victim/sentinel.txt" || fail "cleanup followed poisoned allocation field: $field"
done
cp "$WORK/engagement-state.clean.json" "$STATE"

# Discovery cannot advance before its declared participant arrives.
if "$CLI" engagement barrier advance --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" >/dev/null 2>&1; then
  fail "discovery barrier advanced before Kalchas arrived"
fi
"$CLI" engagement barrier arrive --manifest "$MANIFEST" --lane kalchas --token "$(token_for kalchas)" --phase discovery >/dev/null
"$CLI" engagement barrier advance --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" >/dev/null
[ "$("$CLI" engagement status --manifest "$MANIFEST" | jq -r .currentPhase)" = hunting ] || fail "phase did not advance to hunting"

# Reset/fault windows are owner-restricted and exclusive.
"$CLI" engagement claim --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --resource fault >/dev/null
if "$CLI" engagement claim --manifest "$MANIFEST" --lane atlas --token "$(token_for atlas)" --resource fault >/dev/null 2>&1; then
  fail "non-owner acquired the fault window"
fi
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null

# Atomic canonical ID allocation remains unique under parallel callers.
mkdir -p "$WORK/ids"
mkdir "$STATE.lock"
touch -t 202001010000 "$STATE.lock"
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
"$CLI" engagement release --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
mkdir "$STATE.lock"
printf '{' >"$STATE.lock/owner.json"
touch -t 202001010000 "$STATE.lock"
"$CLI" engagement claim --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
"$CLI" engagement release --manifest "$MANIFEST" --lane odysseus --token "$(token_for odysseus)" --resource reset >/dev/null
mkdir "$STATE.lock"
printf '%s\n' '{"pid":2147483647,"acquiredAt":"2026-07-12T00:00:00.000Z"}' >"$STATE.lock/owner.json"
for index in $(seq 1 24); do
  "$CLI" engagement id --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" --kind bug --identity "finding-$index" >"$WORK/ids/$index" &
done
wait
test ! -e "$STATE.lock" || fail 'parallel callers did not safely reclaim the abandoned state lock'
[ "$(sort -u "$WORK"/ids/* | wc -l | tr -d ' ')" -eq 24 ] || fail "parallel bug IDs are not unique"
stable_id="$("$CLI" engagement id --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" --kind bug --identity finding-1)"
[ "$stable_id" = "$(cat "$WORK/ids/1")" ] || fail "stable identity did not deduplicate across resume"
grep -Fxq 'BUG-0001' "$WORK"/ids/* || fail "bug ID sequence did not start at BUG-0001"
grep -Fxq 'BUG-0024' "$WORK"/ids/* || fail "bug ID sequence did not reach BUG-0024"

# Checkpoints are resumable and idempotent, but sequence/content conflicts fail closed.
printf '%s\n' '{"completed":["surface-a"],"next":"surface-b"}' >"$WORK/checkpoint-1.json"
printf '%s\n' '{"completed":["surface-a","surface-b"],"next":"surface-c"}' >"$WORK/checkpoint-2.json"
hermes_dispatch_id="$("$CLI" engagement status --manifest "$MANIFEST" | jq -r .allocations.hermes.dispatchId)"
"$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 1 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-1.json" >/dev/null
"$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 1 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-1.json" >/dev/null
if "$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 1 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-2.json" >/dev/null 2>&1; then
  fail "checkpoint sequence accepted conflicting content"
fi
"$CLI" engagement checkpoint --manifest "$MANIFEST" --lane hermes --token "$(token_for hermes)" --phase hunting --sequence 2 --dispatch-id "$hermes_dispatch_id" --attempt 1 --input "$WORK/checkpoint-2.json" >/dev/null
resumed="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST/main" hermes "$CONTROLLER_TOKEN" "$(token_for hermes)")"
[ "$(jq -r .resumed <<<"$resumed")" = true ] || fail "interrupted worker allocation did not resume"
[ "$(jq -r .token <<<"$resumed")" = "$(token_for hermes)" ] || fail "resumed worker lease changed"

# Workers create immutable fragments; only the canonical owner performs deterministic merge.
printf '# Strategy\n\nSecond fragment.\n' >"$WORK/fragment-20.md"
printf '# Strategy\n\nFirst fragment.\n' >"$WORK/fragment-10.md"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane kalchas --token "$(token_for kalchas)" \
  --canonical solution/TEST-STRATEGY.md --id 020-recon --input "$WORK/fragment-20.md" >/dev/null
"$CLI" engagement fragment --manifest "$MANIFEST" --lane metis --token "$(token_for metis)" \
  --canonical solution/TEST-STRATEGY.md --id 010-plan --input "$WORK/fragment-10.md" >/dev/null
if "$CLI" engagement merge --manifest "$MANIFEST" --owner kalchas --token "$(token_for kalchas)" \
  --canonical solution/TEST-STRATEGY.md >/dev/null 2>&1; then
  fail "non-owner merged a canonical artifact"
fi
"$CLI" engagement merge --manifest "$MANIFEST" --owner metis --token "$(token_for metis)" \
  --canonical solution/TEST-STRATEGY.md >/dev/null
first_digest="$(digest_file "$TARGET/solution/TEST-STRATEGY.md")"
"$CLI" engagement merge --manifest "$MANIFEST" --owner metis --token "$(token_for metis)" \
  --canonical solution/TEST-STRATEGY.md >/dev/null
second_digest="$(digest_file "$TARGET/solution/TEST-STRATEGY.md")"
[ "$first_digest" = "$second_digest" ] || fail "repeated canonical merge is not byte-stable"
[ "$(grep -n 'First fragment' "$TARGET/solution/TEST-STRATEGY.md" | cut -d: -f1)" -lt \
  "$(grep -n 'Second fragment' "$TARGET/solution/TEST-STRATEGY.md" | cut -d: -f1)" ] || fail "fragment merge order is not deterministic"
printf '%s\n' '{"$schema":"argus/bug-ledger@1","schemaVersion":1,"engagementId":"phase0-smoke","bugs":[]}' >"$WORK/ledger.json"
"$CLI" engagement fragment --manifest "$MANIFEST" --lane minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json --id complete-ledger --input "$WORK/ledger.json" >/dev/null
"$CLI" engagement merge --manifest "$MANIFEST" --owner minos --token "$(token_for minos)" \
  --canonical solution/bug-ledger.json >/dev/null
jq -e '."$schema" == "argus/bug-ledger@1" and .schemaVersion == 1 and .bugs == []' "$TARGET/solution/bug-ledger.json" >/dev/null || fail "canonical JSON document merge is invalid"

parallel_merge_digest() {
  local run="$1" target="$WORK/repeat-$1" manifest controller allocation controller_token token index host="$HOST/repeat-$1"
  mkdir -p "$target" "$WORK/repeat-fragments-$run"
  "$CLI" engagement init --target "$target" --artifact-root "$target" --mode A --engagement-id "repeat-$run" >/dev/null
  manifest="$target/ai_agents_internal/engagement.json"
  argus_smoke_prepare_model_control "$CLI" "$manifest" "$target" "$target" A \
    "$ROOT/scripts/fixtures/argus-preflight/full.json" "$host"
  controller="$(argus_smoke_allocate "$CLI" "$manifest" "$host" odysseus)"
  controller_token="$(jq -r .token <<<"$controller")"
  allocation="$(argus_smoke_allocate "$CLI" "$manifest" "$host" metis "$controller_token")"
  token="$(jq -r .token <<<"$allocation")"
  for index in $(seq -w 1 16); do
    printf 'Stable section %s.\n' "$index" >"$WORK/repeat-fragments-$run/$index.md"
    "$CLI" engagement fragment --manifest "$manifest" --lane metis --token "$token" \
      --canonical solution/TEST-STRATEGY.md --id "$index" --input "$WORK/repeat-fragments-$run/$index.md" >/dev/null &
  done
  wait
  "$CLI" engagement merge --manifest "$manifest" --owner metis --token "$token" \
    --canonical solution/TEST-STRATEGY.md >/dev/null
  digest_file "$target/solution/TEST-STRATEGY.md"
}

repeat_one="$(parallel_merge_digest 1)"
repeat_two="$(parallel_merge_digest 2)"
repeat_three="$(parallel_merge_digest 3)"
[ "$repeat_one" = "$repeat_two" ] && [ "$repeat_two" = "$repeat_three" ] || fail "repeated parallel merges produced different artifacts"

# The packaged guard covers direct tools, traversal, symlinks, shell writes, and subprocesses.
guard_write tests/generated.spec.ts allow
guard_write scripts/hunt-driver.mjs allow
guard_write scripts/generated-helper.mjs GUARD-TARGET-IMMUTABLE
guard_write src/application.ts GUARD-TARGET-IMMUTABLE
guard_write package.json GUARD-TARGET-IMMUTABLE
guard_write reports/result.json allow
guard_write app/source.ts GUARD-TARGET-IMMUTABLE
guard_write "$TARGET/app/source.ts" GUARD-TARGET-IMMUTABLE
guard_write tests/../app/source.ts GUARD-TARGET-IMMUTABLE
guard_write tests/symlink-app/source.ts GUARD-TARGET-IMMUTABLE
guard_write solution/TEST-STRATEGY.md GUARD-CANONICAL-SINGLE-WRITER
guard_write ai_agents_internal/operator-decisions/forged.json GUARD-TARGET-IMMUTABLE
ln "$TARGET/app/source.ts" "$TARGET/reports/source-hardlink.txt"
guard_write reports/source-hardlink.txt GUARD-HARDLINK-ALIAS
guard_shell 'printf compromised > reports/source-hardlink.txt' GUARD-HARDLINK-ALIAS
printf '{"password":"hardlink-guard-sentinel"}\n' >"$TARGET/reports/hardlink-input.json"
if (cd "$TARGET" && "$CLI" redact --input reports/hardlink-input.json --output reports/source-hardlink.txt >/dev/null 2>&1); then
  fail 'packaged redactor wrote through an allowed-path hard link to target source'
fi
grep -Fxq 'application source' "$TARGET/app/source.ts" || fail 'allowed-path hard link modified target source'
rm "$TARGET/reports/source-hardlink.txt"
guard_shell 'printf x > reports/result.txt' allow
guard_shell 'printf x > app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'rm app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'mv tests/generated.spec.ts app/generated.spec.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'chmod 777 app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell 'patch app/source.ts' GUARD-TARGET-IMMUTABLE
guard_shell "node -e \"require('fs').writeFileSync('app/subprocess.ts','supersecret')\"" GUARD-TARGET-IMMUTABLE
guard_shell "python3 -c \"open('app/python-write.txt','w').write('supersecret')\"" GUARD-TARGET-IMMUTABLE
guard_shell "bash -c 'printf x > app/nested-shell.txt'" GUARD-TARGET-IMMUTABLE
guard_shell "node -e \"require('fs').writeFileSync(process.env.P,'supersecret')\"" GUARD-SHELL-AMBIGUOUS
guard_shell "node -e \"import('./runtime/engagement.mjs').then(m => m.allocateWorker({}, 'odysseus', {}))\"" GUARD-SHELL-AMBIGUOUS
guard_shell "node -e \"require('fs').rmSync('app/source.ts')\"" GUARD-TARGET-IMMUTABLE
guard_shell "python3 -c \"import shutil; shutil.rmtree('app')\"" GUARD-TARGET-IMMUTABLE
guard_shell 'argus-assets verify & rm -rf app' GUARD-SHELL-AMBIGUOUS
guard_shell 'rm -rf app argus-assets verify' GUARD-SHELL-AMBIGUOUS
guard_shell $'argus-assets verify\n# harmless comment' GUARD-SHELL-AMBIGUOUS
guard_shell 'cd . && argus-assets verify' GUARD-SHELL-AMBIGUOUS
guard_shell 'ARGUS_TEST=1 argus-assets verify' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets verify | true' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets verify > reports/verify.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus\-assets redact --input reports/result.txt --output reports/redacted-escaped-command.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-as\sets redact --input reports/result.txt --output reports/redacted-escaped-fragment.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-"assets" redact --input reports/result.txt --output reports/redacted-quoted-fragment.txt' GUARD-SHELL-AMBIGUOUS
guard_shell 'A=argus-assets; $A redact --input reports/result.txt --output reports/redacted-variable-command.txt' GUARD-SHELL-AMBIGUOUS
printf '{"password":"guard-sentinel"}\n' >"$TARGET/reports/result.txt"
if (cd "$TARGET" && A="$CLI" && "$A" redact --input reports/result.txt --output app/self-guarded.txt >/dev/null 2>&1); then
  fail 'packaged redactor bypassed its active-engagement write guard through a shell variable'
fi
test ! -e "$TARGET/app/self-guarded.txt" || fail 'self-guarded redactor created a target-source file'
if (cd "$TARGET" && ARGUS_ENGAGEMENT_MANIFEST="$WORK/missing-engagement.json" \
  "$CLI" redact --input reports/result.txt --output app/env-bypassed.txt >/dev/null 2>&1); then
  fail 'invalid ARGUS_ENGAGEMENT_MANIFEST bypassed the packaged write guard'
fi
test ! -e "$TARGET/app/env-bypassed.txt" || fail 'invalid manifest override created a target-source file'
(cd "$TARGET" && "$CLI" redact --input reports/result.txt --output reports/self-guard-allowed.json >/dev/null)
test -f "$TARGET/reports/self-guard-allowed.json" || fail 'self-guard denied an allowed report output'
guard_shell "argus-assets engagement init --target app --artifact-root app --mode A" GUARD-SHELL-AMBIGUOUS
cp "$MANIFEST" "$WORK/alternate-engagement.json"
guard_shell "argus-assets engagement validate --manifest $WORK/alternate-engagement.json" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets engagement heartbeat --manifest $MANIFEST --lane odysseus --token $(token_for odysseus) --phase hunting --completed 1 --total 4 --status running" allow
guard_shell "argus-assets redact --input reports/result.txt --output app/redacted.txt" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets redact --input reports/result.txt --output ai_agents_internal/operator-decisions/forged.json" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets preflight --target app --artifact-root app --mode A" GUARD-TARGET-IMMUTABLE
guard_shell "argus-assets copy-browser-driver $TARGET" allow
guard_shell "argus-assets copy-browser-driver $WORK/outside-target" GUARD-TARGET-IMMUTABLE
atlas_tmp="$(jq -r .temporaryDirectory "$ALLOCATIONS/atlas.json")"
guard_shell "argus-assets copy-template typescript $atlas_tmp/template" allow
guard_shell "argus-assets template detect --target $TARGET" allow
guard_shell "argus-assets template select --target $TARGET --runtime typescript --package-manager npm --test-root tests --harness-root qa-support --output ai_agents_internal/reports/template-selection.json" allow
guard_shell "argus-assets template scaffold --selection ai_agents_internal/reports/template-selection.json --destination $atlas_tmp/scaffold" allow
guard_shell "argus-assets template scaffold --selection ai_agents_internal/reports/template-selection.json --destination $WORK/outside-target" GUARD-TARGET-IMMUTABLE
guard_shell 'argus-assets orchestration plan --mode A' allow
guard_shell 'argus-assets orchestration plan --mode A --output ai_agents_internal/orchestration-plan.json' allow
guard_shell "argus-assets orchestration plan --mode A --artifact-root $TARGET --output ai_agents_internal/orchestration-plan.json" allow
guard_shell 'argus-assets orchestration plan --mode A --output reports/orchestration-plan.json' GUARD-SHELL-AMBIGUOUS
guard_shell 'argus-assets model benchmark' allow
guard_shell "argus-assets model payload --document $TARGET/ai_agents_internal/operator-decisions/unsigned.json" allow
guard_shell "argus-assets model trust --manifest $MANIFEST --runtime-key-id runtime --operator-key-id operator" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model trust --manifest $MANIFEST --manifest $WORK/alternate-engagement.json --runtime-key-id runtime --operator-key-id operator" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model trust --manifest $WORK/alternate-engagement.json --runtime-key-id runtime --operator-key-id operator" GUARD-SHELL-AMBIGUOUS
guard_shell "argus-assets model request --manifest $MANIFEST --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 --checkpoint-ref ai_agents_internal/checkpoints/aegis/00000001.json" allow
guard_shell "argus-assets model route --manifest $MANIFEST --manifest $WORK/alternate-engagement.json --agent aegis --runtime claude --signal normal --dispatch-id duplicate-manifest --attempt 1" GUARD-SHELL-AMBIGUOUS
if "$CLI" model route --manifest "$MANIFEST" --manifest "$MANIFEST" --agent aegis --runtime claude --signal normal --dispatch-id duplicate-manifest --attempt 1 >/dev/null 2>&1; then
  fail 'model route accepted duplicate --manifest options'
fi
"$CLI" orchestration plan --mode A --artifact-root "$TARGET" --output ai_agents_internal/orchestration-plan.json >/dev/null
plan_digest="$(digest_file "$TARGET/ai_agents_internal/orchestration-plan.json")"
"$CLI" orchestration plan --mode A --artifact-root "$TARGET" --output ai_agents_internal/orchestration-plan.json >/dev/null
[ "$plan_digest" = "$(digest_file "$TARGET/ai_agents_internal/orchestration-plan.json")" ] || fail 'orchestration plan replay changed the persisted projection'
if "$CLI" orchestration plan --mode B --artifact-root "$TARGET" --output ai_agents_internal/orchestration-plan.json >/dev/null 2>&1; then
  fail 'orchestration plan replay replaced an existing projection with a different mode'
fi

# An exact operator bypass works only with its secret token and is audited without raw commands.
BYPASS_TOKEN='operator-approved-phase0-bypass'
node - "$MANIFEST" "$BYPASS_TOKEN" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const [path, token] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.writePolicy.bypass = {
  enabled: true,
  approvedBy: 'phase0-smoke-operator',
  reason: 'Verify exact-path bypass enforcement',
  expiresAt: '2099-01-01T00:00:00.000Z',
  allowedPaths: ['app/approved-output.txt'],
  tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
};
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
output="$(jq -nc --arg cwd "$TARGET" '{tool_name:"Write",cwd:$cwd,tool_input:{file_path:"app/approved-output.txt",content:"safe"}}' | \
  ARGUS_IMMUTABILITY_BYPASS_TOKEN="$BYPASS_TOKEN" "$CLI" guard)"
[ -z "$output" ] || fail "exact bypass was denied: $output"
guard_write app/not-approved.txt GUARD-TARGET-IMMUTABLE
AUDIT="$TARGET/ai_agents_internal/immutability-audit.jsonl"
grep -Fq 'GUARD-EXPLICIT-BYPASS' "$AUDIT" || fail "bypass was not audited"
grep -Fq 'GUARD-SHELL-AMBIGUOUS' "$AUDIT" || fail "ambiguous subprocess denial was not audited"
if grep -Fq 'supersecret' "$AUDIT"; then fail "immutability audit leaked raw command content"; fi
node - "$AUDIT" <<'NODE'
const fs = require('fs');
for (const [index, line] of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').entries()) {
  const event = JSON.parse(line);
  for (const key of ['$schema', 'schemaVersion', 'timestamp', 'engagementId', 'tool', 'decision', 'ruleId', 'reason', 'paths', 'commandSha256']) {
    if (!(key in event)) throw new Error(`audit event ${index + 1} missing ${key}`);
  }
  if (event.command) throw new Error(`audit event ${index + 1} contains raw command`);
}
NODE

# Cleanup removes sensitive/temporary state and held locks on both success and failure.
touch "$TARGET/ai_agents_internal/workers/tyche/browser-profile/session" \
  "$TARGET/ai_agents_internal/workers/tyche/auth/token" \
  "$TARGET/ai_agents_internal/workers/tyche/tmp/transient"
mkdir -p "$TARGET/ai_agents_internal/workers/tyche/locks"
touch "$TARGET/ai_agents_internal/workers/tyche/locks/fault"
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --outcome failure >/dev/null
"$CLI" engagement cleanup --manifest "$MANIFEST" --lane tyche --token "$(token_for tyche)" --outcome failure >/dev/null
for path in browser-profile auth tmp locks .lease; do
  [ ! -e "$TARGET/ai_agents_internal/workers/tyche/$path" ] || fail "cleanup left tyche/$path"
done
[ -d "$TARGET/ai_agents_internal/workers/tyche/output" ] || fail "cleanup removed durable worker output"
[ "$("$CLI" engagement status --manifest "$MANIFEST" | jq -r '.exclusiveLocks.fault // "released"')" = released ] || fail "cleanup left fault lock"

printf 'PASS  Argus engagement: packaged guard, deterministic ownership, barriers, leases, IDs, resume, and cleanup\n'
