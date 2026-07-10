#!/usr/bin/env bash
# Exercise Argus preflight against deterministic full, partial, and insufficient
# capability environments. Reports must be persisted before any lane dispatch.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
FIXTURES="$ROOT/scripts/fixtures/argus-preflight"
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
assert(report.summary.selected === 27, `${scenario}: Mode A must evaluate all 27 agents`);
assert(report.checks.some((check) => check.id === 'packaged-assets' && check.status === 'pass'), `${scenario}: assets check`);

const bySlug = new Map(report.agents.map((agent) => [agent.slug, agent]));
if (scenario === 'full') {
  assert(report.summary.ready === 27 && report.summary.dispatchable === 27, 'full: every agent must be ready');
}
if (scenario === 'partial') {
  assert(report.summary.blocked === 0, 'partial: optional gaps must not block the engagement');
  assert(bySlug.get('orion').status === 'deferred' && !bySlug.get('orion').dispatchAllowed, 'partial: browser lane must be deferred');
  assert(bySlug.get('charon').status === 'skipped' && !bySlug.get('charon').dispatchAllowed, 'partial: DB lane must be skipped');
  assert(bySlug.get('aegis').status === 'degraded' && bySlug.get('aegis').dispatchAllowed, 'partial: Context7 fallback must degrade, not block');
  assert(bySlug.get('aegis').actions.some((action) => action.includes('official documentation')), 'partial: fallback action must be explicit');
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
NODE

for scenario in full partial; do
  target="$WORK/$scenario-target"
  mkdir -p "$target"
  "$CLI" preflight \
    --target "$target" \
    --artifact-root "$target" \
    --mode A \
    --profile "$FIXTURES/$scenario.json" \
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

printf 'PASS  Argus preflight: auto, full, partial, insufficient, and unsafe-path environments\n'
