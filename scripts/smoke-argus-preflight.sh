#!/usr/bin/env bash
# Exercise Argus preflight against deterministic full, partial, and insufficient
# capability environments. Reports must be persisted before any lane dispatch.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
FIXTURES="$ROOT/scripts/fixtures/argus-preflight"
AUTH_FIXTURES="$ROOT/scripts/fixtures/argus-authorization"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

assert_report() {
  local report="$1" expected_status="$2" scenario="$3"
  node - "$report" "$expected_status" "$scenario" <<'NODE'
const fs = require('fs');
const [path, expectedStatus, scenario] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(report.schemaVersion === 1, `${scenario}: schemaVersion`);
assert(report.status === expectedStatus, `${scenario}: expected ${expectedStatus}, got ${report.status}`);
assert(Array.isArray(report.agents) && report.agents.length === 27, `${scenario}: 27 agent records required`);
assert(report.target.reachable === (scenario !== 'insufficient'), `${scenario}: target reachability mismatch`);
assert(report.artifactRoot.writable && report.artifactRoot.safePaths, `${scenario}: artifact root contract`);
assert(report.authorization?.sha256, `${scenario}: authorization manifest digest required`);
assert(report.engagement?.sha256, `${scenario}: engagement manifest digest required`);
assert(report.engagement?.hookPackaged === true, `${scenario}: packaged immutability hook required`);
assert(report.engagement?.phase === 'discovery', `${scenario}: resumable state must start after preflight`);
assert(report.summary.selected === 27, `${scenario}: Mode A must evaluate all 27 agents`);
assert(report.checks.some((check) => check.id === 'packaged-assets' && check.status === 'pass'), `${scenario}: assets check`);

const bySlug = new Map(report.agents.map((agent) => [agent.slug, agent]));
if (scenario === 'full') {
  assert(report.summary.ready === 27 && report.summary.dispatchable === 27, 'full: every agent must be ready');
  assert(report.authorization.defaultReadOnly === false, 'full: explicit authorization fixture required');
}
if (scenario === 'partial') {
  assert(report.summary.blocked === 0, 'partial: optional gaps must not block the engagement');
  assert(bySlug.get('orion').status === 'deferred' && !bySlug.get('orion').dispatchAllowed, 'partial: browser lane must be deferred');
  assert(bySlug.get('charon').status === 'skipped' && !bySlug.get('charon').dispatchAllowed, 'partial: DB lane must be skipped');
  assert(bySlug.get('aegis').status === 'degraded' && bySlug.get('aegis').dispatchAllowed, 'partial: Context7 fallback must degrade, not block');
  assert(bySlug.get('aegis').actions.some((action) => action.includes('official documentation')), 'partial: fallback action must be explicit');
  assert(report.authorization.defaultReadOnly === true, 'partial: generated manifest must default to read-only');
  assert(bySlug.get('hermes').authorization.find((item) => item.action === 'load')?.ruleId === 'AUTH-PRODUCTION-READ-ONLY', 'partial: load must be denied by default policy');
}
if (scenario === 'insufficient') {
  assert(report.summary.blocked === 27 && report.summary.dispatchable === 0, 'insufficient: no specialist may dispatch');
  assert(report.checks.some((check) => check.id === 'target-reachable' && check.status === 'fail'), 'insufficient: target failure required');
  assert(report.checks.some((check) => check.id === 'tool:Agent' && check.status === 'fail'), 'insufficient: Agent failure required');
}
NODE
}

"$ROOT/scripts/verify-argus-capabilities.mjs"

target="$WORK/auto-target"
mkdir -p "$target"
"$CLI" preflight --target "$target" --mode B >/dev/null
report="$target/ai_agents_internal/preflight.json"
test -f "$report" || fail "automatic environment report was not persisted"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!report.target.reachable || report.status === 'blocked') throw new Error('automatic local-target detection failed');
if (!report.checks.some((check) => check.id === 'artifact-paths-safe' && check.status === 'pass')) throw new Error('automatic artifact-path check failed');
if (!report.checks.some((check) => check.id === 'engagement-manifest' && check.status === 'pass')) throw new Error('automatic engagement manifest check failed');
if (!report.checks.some((check) => check.id === 'path-immutability-hook' && check.status === 'pass')) throw new Error('automatic immutability hook check failed');
NODE

for scenario in full partial; do
  target="$WORK/$scenario-target"
  mkdir -p "$target"
  authorization_args=(--environment unknown)
  if [ "$scenario" = full ]; then
    mkdir -p "$target/ai_agents_internal"
    cp "$AUTH_FIXTURES/full.json" "$target/ai_agents_internal/authorization.json"
    authorization_args=(--authorization "$target/ai_agents_internal/authorization.json")
  fi
  "$CLI" preflight \
    --target "$target" \
    --artifact-root "$target" \
    --mode A \
    --profile "$FIXTURES/$scenario.json" \
    "${authorization_args[@]}" \
    >/dev/null
  report="$target/ai_agents_internal/preflight.json"
  test -f "$report" || fail "$scenario report was not persisted"
  assert_report "$report" "$([ "$scenario" = full ] && printf ready || printf degraded)" "$scenario"
done

target="$WORK/insufficient-target"
mkdir -p "$target"
if "$CLI" preflight \
  --target "$target" \
  --artifact-root "$target" \
  --mode A \
  --profile "$FIXTURES/insufficient.json" \
  >/dev/null 2>&1; then
  fail "insufficient environment unexpectedly passed"
else
  status=$?
  [ "$status" -eq 2 ] || fail "insufficient environment exited $status instead of 2"
fi
report="$target/ai_agents_internal/preflight.json"
test -f "$report" || fail "blocked preflight report was not persisted"
assert_report "$report" blocked insufficient

target="$WORK/malformed-engagement-target"
mkdir -p "$target/ai_agents_internal"
printf '{"mode":42}\n' >"$target/ai_agents_internal/engagement.json"
if "$CLI" preflight \
  --target "$target" \
  --artifact-root "$target" \
  --mode A \
  --profile "$FIXTURES/full.json" \
  >/dev/null 2>&1; then
  fail "malformed engagement manifest unexpectedly passed"
else
  status=$?
  [ "$status" -eq 2 ] || fail "malformed engagement manifest exited $status instead of 2"
fi
report="$target/ai_agents_internal/preflight.json"
test -f "$report" || fail "malformed engagement block did not persist a report"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const engagement = report.checks.find((check) => check.id === 'engagement-manifest');
if (report.status !== 'blocked' || engagement?.status !== 'fail') throw new Error('malformed engagement manifest was not fail-closed');
if (report.engagement.sha256 !== null || report.engagement.phase !== null) throw new Error('malformed engagement manifest was treated as usable');
NODE
test ! -e "$target/ai_agents_internal/engagement-state.json" || fail "malformed engagement initialized state"

target="$WORK/unsafe-path-target"
mkdir -p "$target"
if "$CLI" preflight \
  --target "$target" \
  --artifact-root "$target" \
  --output ../escape.json \
  --mode A \
  --profile "$FIXTURES/full.json" \
  >/dev/null 2>&1; then
  fail "unsafe output path unexpectedly passed"
else
  status=$?
  [ "$status" -eq 2 ] || fail "unsafe output path exited $status instead of 2"
fi
test ! -e "$WORK/escape.json" || fail "unsafe output escaped the artifact root"
report="$target/ai_agents_internal/preflight.json"
test -f "$report" || fail "unsafe-path block did not persist a safe fallback report"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'blocked' || report.artifactRoot.safePaths !== false) throw new Error('unsafe artifact path was not blocked');
NODE

printf 'PASS  Argus preflight: auto, full, partial, insufficient, malformed-engagement, and unsafe-path environments\n'
