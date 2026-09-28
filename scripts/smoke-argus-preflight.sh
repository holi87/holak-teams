#!/usr/bin/env bash
# Exercise Argus preflight against deterministic full, partial, and insufficient
# capability environments. Reports must be persisted before any lane dispatch.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL_CLI="$ROOT/argus/claude/bin/argus-assets"
CLI="$ROOT/scripts/lib/argus-smoke-cli.sh"
FIXTURES="$ROOT/scripts/fixtures/argus-preflight"
AUTH_FIXTURES="$ROOT/scripts/fixtures/argus-authorization"
source "$ROOT/scripts/lib/argus-smoke-model-control.sh"
WORK="$(mktemp -d)"
NATIVE_HOST="$(mktemp -d)"
trap 'rm -rf "$WORK" "$NATIVE_HOST"' EXIT
export ARGUS_SMOKE_REAL_CLI="$REAL_CLI"
export ARGUS_SMOKE_HOST_ROOT="$NATIVE_HOST"
export ARGUS_SMOKE_LAUNCHER="$ROOT/argus/claude/bin/argus-launch"
export ARGUS_SMOKE_CLAUDE="$ROOT/scripts/fixtures/argus-launcher/claude"
export ARGUS_SMOKE_PREFLIGHT_CLI="$CLI"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Preflight never treats database coordinates in its environment as db-access evidence; only
# the scenario that proves it exports one, so every other report stays host-independent.
unset DATABASE_URL PGHOST MYSQL_HOST

# browser-runtime.json must satisfy argus/browser-runtime@1, repeat the report's
# browserRuntime verbatim, bind the engagement, and leave no probe scratch behind.
validate_browser_runtime_record() {
  local artifact_root="$1"
  node --input-type=module - "$ROOT/argus/runtime/json-schema.mjs" "$ROOT/argus/schemas/browser-runtime.schema.json" "$artifact_root" <<'NODE'
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [runtimePath, schemaPath, artifactRoot] = process.argv.slice(2);
const { compileJsonSchema } = await import(pathToFileURL(runtimePath));
const control = join(artifactRoot, 'ai_agents_internal');
const recordPath = join(control, 'browser-runtime.json');
if (!existsSync(recordPath)) throw new Error(`${artifactRoot}: browser-runtime.json was not persisted`);
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const errors = compileJsonSchema(JSON.parse(readFileSync(schemaPath, 'utf8')))(record);
if (errors.length > 0) throw new Error(`browser-runtime@1 schema rejected ${recordPath}: ${JSON.stringify(errors)}`);
const report = JSON.parse(readFileSync(join(control, 'preflight.json'), 'utf8'));
const engagement = JSON.parse(readFileSync(join(control, 'engagement.json'), 'utf8'));
const { $schema, schemaVersion, engagementId, ...result } = record;
if (engagementId !== engagement.engagementId) throw new Error(`${recordPath}: engagementId is not bound to the engagement manifest`);
if (JSON.stringify(result) !== JSON.stringify(report.browserRuntime)) throw new Error(`${recordPath}: record differs from the preflight report browserRuntime`);
const scratch = join(control, 'tmp');
const leftovers = existsSync(scratch) ? readdirSync(scratch).filter((name) => name.startsWith('browser-probe-')) : [];
if (leftovers.length > 0) throw new Error(`${artifactRoot}: browser probe scratch remained: ${leftovers.join(', ')}`);
NODE
}

validate_report_schema() {
  local report="$1"
  "$CLI" schema validate --kind preflight-report --input "$report" >/dev/null
  node --input-type=module - "$ROOT/argus/runtime/json-schema.mjs" "$ROOT/argus/schemas/preflight-report.schema.json" "$report" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [runtimePath, schemaPath, reportPath] = process.argv.slice(2);
const { compileJsonSchema } = await import(pathToFileURL(runtimePath));
const validate = compileJsonSchema(JSON.parse(readFileSync(schemaPath, 'utf8')));
const errors = validate(JSON.parse(readFileSync(reportPath, 'utf8')));
if (errors.length > 0) throw new Error(`preflight v3 schema rejected ${reportPath}: ${JSON.stringify(errors)}`);
NODE
}

assert_report() {
  local report="$1" expected_status="$2" scenario="$3"
  validate_report_schema "$report"
  node - "$report" "$expected_status" "$scenario" <<'NODE'
const fs = require('fs');
const [path, expectedStatus, scenario] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(report.schemaVersion === 3, `${scenario}: schemaVersion`);
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
assert(bySlug.get('odysseus').dispatchAllowed === false, `${scenario}: controller must never be dispatchable`);
assert(report.agents.every((agent) => typeof agent.stopsEngagement === 'boolean'), `${scenario}: every agent needs a boolean stopsEngagement`);
assert(report.agents.every((agent) => Array.isArray(agent.pendingGates) && (agent.pendingGates.length > 0) === (agent.status === 'conditional')),
  `${scenario}: pendingGates must be non-empty exactly on conditional records`);
assert(report.summary.conditional === report.agents.filter((agent) => agent.selected && agent.status === 'conditional').length, `${scenario}: summary.conditional miscounted`);
const residualSlugs = report.residualRisks.map((risk) => risk.slug).sort();
const expectedResidualSlugs = report.agents
  .filter((agent) => agent.selected && agent.status !== 'ready' && agent.status !== 'degraded')
  .map((agent) => agent.slug)
  .sort();
assert(JSON.stringify(residualSlugs) === JSON.stringify(expectedResidualSlugs), `${scenario}: residualRisks must list exactly the selected lanes that will not run`);
for (const risk of report.residualRisks) {
  const agent = bySlug.get(risk.slug);
  assert(risk.status === agent.status && risk.reason.length > 0 && risk.reason.length <= 600, `${scenario}/${risk.slug}: residual risk is not bound to its agent record`);
  assert(JSON.stringify(risk.missingTools) === JSON.stringify(agent.missingTools)
    && JSON.stringify(risk.missingCapabilities) === JSON.stringify(agent.missingCapabilities), `${scenario}/${risk.slug}: residual risk lost its missing tools or capabilities`);
}
if (scenario !== 'insufficient') {
  assert(report.orchestration?.sha256 && report.orchestration.specialists === report.summary.dispatchable, `${scenario}: bound orchestration projection required`);
  const plan = JSON.parse(fs.readFileSync(report.orchestration.path, 'utf8'));
  const planned = plan.waves.flatMap((wave) => wave.roles.map((role) => role.slug)).sort();
  const dispatchable = report.agents.filter((agent) => agent.dispatchAllowed).map((agent) => agent.slug).sort();
  assert(JSON.stringify(planned) === JSON.stringify(dispatchable), `${scenario}: projection differs from dispatchable specialists`);
}
if (scenario === 'full' || scenario === 'partial') {
  assert(report.summary.downgraded === 0, `${scenario}: no lane may be downgraded`);
  assert(report.agents.every((agent) => agent.stopsEngagement === false && agent.downgradedFrom === undefined), `${scenario}: no lane may stop the engagement`);
  assert(report.browserRuntime.status === 'not-probed' && report.browserRuntime.evidence === 'profile features are authoritative'
    && report.browserRuntime.candidates.length === 0, `${scenario}: an authoritative profile feature list must not probe the host browser runtime`);
}
if (scenario === 'full') {
  assert(report.summary.ready === 27 && report.summary.dispatchable === 26, 'full: 26 specialists must be dispatchable');
  assert(report.summary.conditional === 0, 'full: a fully provisioned engagement has no conditional lane');
  assert(report.residualRisks.length === 0, 'full: a fully provisioned engagement has no residual lane risk');
  assert(report.authorization.defaultReadOnly === false, 'full: explicit authorization fixture required');
}
if (scenario === 'partial') {
  assert(bySlug.get('perseus').status === 'degraded' && bySlug.get('perseus').dispatchAllowed, 'partial: CLI security hunt must remain dispatchable without browser');
  assert(bySlug.get('perseus').actions.some(action => action.includes('Run authorized CLI request-level security checks')), 'partial: security fallback must explicitly exclude DOM checks');
  assert(report.summary.blocked === 0, 'partial: optional gaps must not block the engagement');
  // Every lane whose only unmet requirements are gates resolve-gates can re-check itself is
  // conditional: sealed and planned now, allocated only after resolve-gates releases it.
  const expectedConditional = {
    antigone: ['browser-runtime'], asklepios: ['existing-suite'], daidalos: ['browser-runtime'],
    lynceus: ['browser-runtime'], orion: ['browser-runtime'], penelope: ['browser-runtime'],
    proteus: ['non-rest-surface'], tiresias: ['source-access'],
  };
  const conditional = Object.fromEntries(report.agents.filter((agent) => agent.status === 'conditional').map((agent) => [agent.slug, agent.pendingGates]));
  assert(JSON.stringify(conditional) === JSON.stringify(expectedConditional), `partial: conditional lanes differ: ${JSON.stringify(conditional)}`);
  assert(report.summary.conditional === 8 && report.summary.deferred === 0 && report.summary.skipped === 3,
    `partial: expected 8 conditional, no deferred, and 3 skipped lanes, got ${JSON.stringify(report.summary)}`);
  // Recon can never release db-access or multi-service, so those lanes stay skipped with their
  // fallback and the only remedy that works: an operator --feature at launch.
  const operatorOnly = { charon: 'db-access', mnemosyne: 'db-access', pistis: 'multi-service' };
  for (const [slug, gate] of Object.entries(operatorOnly)) {
    const agent = bySlug.get(slug);
    assert(agent.status === 'skipped' && agent.pendingGates.length === 0 && agent.dispatchAllowed === false,
      `partial: ${slug} must stay skipped without a pending gate, got ${agent.status} ${JSON.stringify(agent.pendingGates)}`);
    assert(agent.actions[0].startsWith(`${gate}: `) && agent.actions[0].endsWith(`Recon never releases ${gate}; only an operator \`--feature ${gate}\` at launch makes the lane ready.`)
      && !agent.actions.some((action) => action.includes('resolve-gates')), `partial: ${slug} lacks its operator-feature remedy: ${agent.actions[0]}`);
  }
  for (const [slug, gates] of Object.entries(expectedConditional)) {
    const agent = bySlug.get(slug);
    assert(agent.dispatchAllowed === true && agent.stopsEngagement === false, `partial: conditional ${slug} must be dispatchable without stopping the engagement`);
    assert(agent.actions[0].startsWith(`Conditional on ${gates.join(', ')}: sealed with a model decision now;`)
      && agent.actions[0].includes('`argus-assets engagement resolve-gates` releases the lane')
      && agent.actions[0].includes(`is recorded as residual risk: ${gates[0]}: `), `partial: ${slug} lacks its conditional action: ${agent.actions[0]}`);
    assert(!agent.actions.some((action) => gates.some((gate) => action.startsWith(`${gate}: `))), `partial: ${slug} kept a bare required-capability fallback`);
  }
  assert(bySlug.get('daidalos').actions.some((action) => action.startsWith('context7: ')), 'partial: a conditional lane must keep its optional-capability fallback');
  assert(bySlug.get('orion').actions.some((action) => action.startsWith('Authorization denied browser-state-change')), 'partial: a conditional lane must keep its authorization denials');
  const plannedRoles = JSON.parse(fs.readFileSync(report.orchestration.path, 'utf8')).waves.flatMap((wave) => wave.roles.map((role) => role.slug));
  assert(Object.keys(expectedConditional).every((slug) => plannedRoles.includes(slug)), 'partial: the orchestration projection must list the conditional lanes');
  assert(Object.keys(operatorOnly).every((slug) => !plannedRoles.includes(slug)), 'partial: the orchestration projection kept an operator-feature-only lane');
  const partialRisks = new Map(report.residualRisks.map((risk) => [risk.slug, risk]));
  assert(partialRisks.get('orion')?.status === 'conditional' && partialRisks.get('orion').reason.startsWith('pending gate resolution: Conditional on browser-runtime')
    && partialRisks.get('orion').missingCapabilities.includes('browser-runtime'), 'partial: a conditional browser lane must be a named pending residual risk');
  assert(partialRisks.get('charon')?.status === 'skipped' && partialRisks.get('charon').reason.startsWith('db-access: ')
    && partialRisks.get('charon').missingCapabilities.includes('db-access'), 'partial: a skipped DB lane must be a named residual risk with its fallback');
  assert(!partialRisks.has('perseus') && !partialRisks.has('aegis'), 'partial: degraded dispatchable lanes are not residual lane risks');
  assert(bySlug.get('aegis').status === 'degraded' && bySlug.get('aegis').dispatchAllowed, 'partial: Context7 fallback must degrade, not block');
  assert(bySlug.get('aegis').actions.some((action) => action.includes('official documentation')), 'partial: fallback action must be explicit');
  assert(report.authorization.defaultReadOnly === true, 'partial: generated manifest must default to read-only');
  assert(bySlug.get('hermes').authorization.find((item) => item.action === 'load')?.ruleId === 'AUTH-PRODUCTION-READ-ONLY', 'partial: load must be denied by default policy');
}
if (scenario === 'insufficient') {
  assert(report.summary.blocked === 27 && report.summary.dispatchable === 0 && report.summary.conditional === 0, 'insufficient: no specialist may dispatch');
  assert(report.summary.downgraded === 0 && report.agents.every((agent) => agent.stopsEngagement === true && agent.downgradedFrom === undefined),
    'insufficient: failed prerequisites must keep every selected lane blocked and stopping the engagement');
  assert(report.residualRisks.length === 27 && report.residualRisks.every((risk) => risk.status === 'blocked'), 'insufficient: every blocked lane must be a residual risk');
  assert(report.orchestration.sha256 === null, 'insufficient: orchestration must not persist after failed prerequisites');
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
validate_report_schema "$report"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!report.target.reachable || report.status === 'blocked') throw new Error('automatic local-target detection failed');
if (!report.checks.some((check) => check.id === 'artifact-paths-safe' && check.status === 'pass')) throw new Error('automatic artifact-path check failed');
if (!report.checks.some((check) => check.id === 'engagement-manifest' && check.status === 'pass')) throw new Error('automatic engagement manifest check failed');
if (!report.checks.some((check) => check.id === 'path-immutability-hook' && check.status === 'pass')) throw new Error('automatic immutability hook check failed');
// Without a profile the host runtime is resolved for real; its outcome depends on the host,
// but it must be probed, and the capability must follow the functional result.
const runtime = report.browserRuntime;
const capability = report.capabilities.find((item) => item.id === 'browser-runtime');
if (!['available', 'unavailable'].includes(runtime.status) || typeof runtime.probedAt !== 'string') throw new Error(`automatic preflight did not resolve the browser runtime: ${runtime.status}`);
if (capability.available !== (runtime.status === 'available')) throw new Error('automatic browser-runtime capability disagrees with the functional probe');
if (runtime.candidates.filter((candidate) => candidate.result === 'launched' || candidate.result === 'failed').length > 3) throw new Error('automatic preflight probed more than three browser runtime candidates');
NODE
validate_browser_runtime_record "$target"
initial_heartbeat_lines="$(wc -l <"$target/ai_agents_internal/heartbeat/odysseus.log")"
"$CLI" preflight --target "$target" --mode B >/dev/null
[ "$(wc -l <"$target/ai_agents_internal/heartbeat/odysseus.log")" -eq "$initial_heartbeat_lines" ] || \
  fail 'preflight resume rewrote the initial controller heartbeat'
jq -e '.checks[] | select(.id == "controller-heartbeat" and .status == "pass") | .evidence | contains("validated existing controller heartbeat")' \
  "$report" >/dev/null || fail 'preflight resume did not report its non-writing heartbeat path truthfully'

json_target="$WORK/json-target"
mkdir -p "$json_target"
"$CLI" preflight --target "$json_target" --mode B --json \
  >"$WORK/preflight-json.stdout" 2>"$WORK/preflight-json.stderr"
jq -e '.schemaVersion == 3' "$WORK/preflight-json.stdout" >/dev/null || fail 'preflight --json stdout is not one JSON document'
diff -u <(jq -S . "$WORK/preflight-json.stdout") <(jq -S . "$json_target/ai_agents_internal/preflight.json") >/dev/null || \
  fail 'preflight --json stdout differs from the persisted report'

# Codex preflight must preview the requested runtime instead of silently
# reporting Claude. Dispatch-specific parent attestations are intentionally
# required later by model route, after stable dispatch IDs exist.
codex_target="$WORK/codex-target"
mkdir -p "$codex_target"
if "$CLI" preflight --target "$codex_target" --mode B --model-runtime codex >/dev/null; then
  fail 'Codex preflight became dispatchable without a native hard turn cap'
fi
codex_report="$codex_target/ai_agents_internal/preflight.json"
validate_report_schema "$codex_report"
node - "$codex_report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.modelRuntime !== 'codex' || report.status !== 'blocked' || report.summary.dispatchable !== 0) throw new Error('Codex preflight did not fail closed');
if (!report.checks.some((check) => check.id === 'native-host-execution' && check.status === 'fail')) throw new Error('Codex preflight omitted native-cap failure');
for (const agent of report.agents) {
  if (agent.model.runtime !== 'codex') throw new Error(`${agent.slug}: preflight hardcoded a non-Codex model preview`);
  if (agent.model.adapterId !== 'codex-custom-agent@1') throw new Error(`${agent.slug}: wrong Codex adapter`);
  if (agent.model.status !== 'blocked' || !agent.model.missingCapabilities.includes('maxTurns') || (agent.selected && agent.status !== 'blocked')) {
    throw new Error(`${agent.slug}: Codex native turn-cap failure is not explicit`);
  }
  if (agent.selected && (agent.stopsEngagement !== true || agent.downgradedFrom !== undefined)) {
    throw new Error(`${agent.slug}: Codex prerequisite failure downgraded a lane instead of stopping the engagement`);
  }
}
NODE
if "$CLI" preflight --target "$WORK/invalid-runtime-target" --mode B --model-runtime invented >/dev/null 2>&1; then
  fail 'preflight accepted an unknown model runtime'
fi

# URL reachability is probed only after control manifests, state, and an audited
# read authorization exist. The local server observes filesystem state at HEAD time.
order_target="$WORK/control-order-target"
order_port="$WORK/control-order.port"
order_marker="$WORK/control-order.json"
order_profile="$WORK/control-order-profile.json"
mkdir -p "$order_target"
jq 'del(.targetReachable)' "$FIXTURES/full.json" >"$order_profile"
node "$FIXTURES/control-order-server.mjs" "$order_target" "$order_port" "$order_marker" &
order_server_pid=$!
for _ in {1..100}; do
  [ -s "$order_port" ] && break
  sleep 0.05
done
[ -s "$order_port" ] || fail 'control-order server did not publish its port'
"$CLI" preflight \
  --target "http://127.0.0.1:$(<"$order_port")/" \
  --artifact-root "$order_target" \
  --mode B \
  --profile "$order_profile" \
  >/dev/null
wait "$order_server_pid"
node - "$order_marker" <<'NODE'
const fs = require('fs');
const observation = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (observation.method !== 'HEAD') throw new Error(`expected HEAD, got ${observation.method}`);
for (const [name, present] of Object.entries(observation.present)) {
  if (!present) throw new Error(`target was probed before ${name} existed`);
}
NODE

# Argus 1.18 stored URL identities exactly as supplied, while current preflight
# normalizes them with URL.toString(). Equivalent trailing-slash forms must
# resume without rewriting the engagement or authorization binding.
url_resume_target="$WORK/url-resume-target"
url_resume_raw='http://127.0.0.1:43123'
url_resume_normalized="$url_resume_raw/"
mkdir -p "$url_resume_target/ai_agents_internal"
jq --arg target "$url_resume_raw" '.target.identifiers = [$target]' \
  "$AUTH_FIXTURES/full.json" >"$url_resume_target/ai_agents_internal/authorization.json"
"$CLI" preflight \
  --target "$url_resume_normalized" \
  --artifact-root "$url_resume_target" \
  --mode A \
  --authorization "$url_resume_target/ai_agents_internal/authorization.json" \
  --profile "$FIXTURES/full.json" \
  >/dev/null
jq --arg target "$url_resume_raw" '.target.identifier = $target' \
  "$url_resume_target/ai_agents_internal/engagement.json" >"$WORK/url-resume-engagement.json"
mv "$WORK/url-resume-engagement.json" "$url_resume_target/ai_agents_internal/engagement.json"
"$CLI" preflight \
  --target "$url_resume_normalized" \
  --artifact-root "$url_resume_target" \
  --mode A \
  --authorization "$url_resume_target/ai_agents_internal/authorization.json" \
  --profile "$FIXTURES/full.json" \
  >/dev/null
jq -e --arg target "$url_resume_raw" '.target.identifier == $target' \
  "$url_resume_target/ai_agents_internal/engagement.json" >/dev/null || fail 'URL resume rewrote the stored 1.18 target binding'
jq -e '.checks[] | select(.id == "engagement-manifest" and .status == "pass")' \
  "$url_resume_target/ai_agents_internal/preflight.json" >/dev/null || fail 'URL-equivalent engagement binding did not resume'
jq -e '.checks[] | select(.id == "authorization-target-boundary" and .status == "pass")' \
  "$url_resume_target/ai_agents_internal/preflight.json" >/dev/null || fail 'URL-equivalent authorization binding did not resume'

# A denied authorization boundary must prevent every target-derived metadata
# read, including source/test discovery, manifest inspection, and browser lookup.
denied_target="$WORK/denied-metadata-target"
denied_profile="$WORK/denied-metadata-profile.json"
denied_authorization="$WORK/denied-metadata-authorization.json"
mkdir -p "$denied_target/ai_agents_internal" "$denied_target/package.json" \
  "$denied_target/tests" "$denied_target/node_modules/playwright"
jq 'del(.features, .targetReachable)' "$FIXTURES/full.json" >"$denied_profile"
jq --arg allowed "$WORK/different-authorized-target" '.target.identifiers = [$allowed]' \
  "$AUTH_FIXTURES/full.json" >"$denied_authorization"
cp "$denied_authorization" "$denied_target/ai_agents_internal/authorization.json"
if "$CLI" preflight \
  --target "$denied_target" \
  --artifact-root "$denied_target" \
  --mode A \
  --authorization "$denied_target/ai_agents_internal/authorization.json" \
  --profile "$denied_profile" \
  >/dev/null 2>&1; then
  fail 'authorization-denied target metadata probe unexpectedly passed'
fi
validate_report_schema "$denied_target/ai_agents_internal/preflight.json"
node - "$denied_target/ai_agents_internal/preflight.json" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const byId = new Map(report.capabilities.map((item) => [item.id, item]));
for (const id of ['source-access', 'existing-suite', 'non-rest-surface', 'browser-runtime']) {
  if (byId.get(id)?.available !== false) throw new Error(`denied preflight read target-derived capability ${id}`);
}
if (!String(report.target.evidence).startsWith('target probe skipped:')) throw new Error('denied target probe was not reported as skipped');
if (report.browserRuntime.status !== 'not-probed' || !report.browserRuntime.evidence.startsWith('target probe skipped')
  || report.browserRuntime.candidates.length !== 0) throw new Error('denied preflight resolved or probed a browser runtime');
const boundary = report.checks.find((check) => check.id === 'authorization-target-boundary');
if (report.status !== 'blocked' || boundary?.status !== 'fail') throw new Error('denied authorization boundary did not fail closed');
NODE

# The report inlines the browser-runtime@1 result shape; the two definitions must not drift.
node - "$ROOT/argus/schemas/browser-runtime.schema.json" "$ROOT/argus/schemas/preflight-report.schema.json" <<'NODE'
const fs = require('fs');
const [recordPath, reportPath] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const meta = new Set(['$schema', 'schemaVersion', 'engagementId']);
const inline = report.$defs.browserRuntime;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
if (report.properties.browserRuntime?.$ref !== '#/$defs/browserRuntime' || !report.required.includes('browserRuntime')) throw new Error('preflight report does not require browserRuntime');
if (!same(Object.fromEntries(Object.entries(record.properties).filter(([key]) => !meta.has(key))), inline.properties)
  || !same(record.required.filter((key) => !meta.has(key)), inline.required)
  || !same(record.allOf, inline.allOf)
  || !same(record.$defs.browserRuntimeCandidate, report.$defs.browserRuntimeCandidate)) {
  throw new Error('preflight-report browserRuntime drifted from argus/browser-runtime@1');
}
NODE

# Browser runtime resolution against a URL target whose profile has no authoritative
# feature list: fixture Playwright packages stand in for a working and a broken install.
browser_profile="$WORK/browser-runtime-base-profile.json"
jq 'del(.features) | .commands += ["make", "psql"]' "$FIXTURES/partial.json" >"$browser_profile"
browser_runtime_preflight() {
  local name="$1" filter="$2" root="$WORK/browser-runtime-$1"
  mkdir -p "$root/ai_agents_internal"
  cp "$AUTH_FIXTURES/full.json" "$root/ai_agents_internal/authorization.json"
  jq --arg fixtures "$FIXTURES" --arg root "$root" "$filter" "$browser_profile" >"$WORK/browser-runtime-$name-profile.json"
  "$CLI" preflight \
    --target http://127.0.0.1:9/ \
    --artifact-root "$root" \
    --mode B \
    --authorization "$root/ai_agents_internal/authorization.json" \
    --profile "$WORK/browser-runtime-$name-profile.json" \
    >/dev/null
  validate_report_schema "$root/ai_agents_internal/preflight.json"
  validate_browser_runtime_record "$root"
}
browser_runtime_preflight working '.browserRuntime = {modulePath: ($fixtures + "/fake-playwright")}'
browser_runtime_preflight broken '.browserRuntime = {modulePath: ($fixtures + "/fake-playwright-broken")}'
browser_runtime_preflight disabled '.browserRuntime = false'
# A Playwright package planted inside the worker-writable artifact root is refused unprobed,
# even when the profile names it: its import-time side effect must never run.
mkdir -p "$WORK/browser-runtime-planted/node_modules"
cp -R "$FIXTURES/fake-playwright" "$WORK/browser-runtime-planted/node_modules/playwright"
{
  printf 'import { writeFileSync } from "node:fs";\n'
  printf 'writeFileSync(new URL("../../planted-module-ran", import.meta.url), "imported\\n");\n'
  cat "$FIXTURES/fake-playwright/index.mjs"
} >"$WORK/browser-runtime-planted/node_modules/playwright/index.mjs"
browser_runtime_preflight planted '.browserRuntime = {modulePath: ($root + "/node_modules/playwright")}'
DATABASE_URL=postgres://fixture browser_runtime_preflight database '.browserRuntime = false'
[ -z "${DATABASE_URL:-}" ] || fail 'database coordinates leaked beyond their single preflight run'
node - "$WORK" "$FIXTURES" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [work, fixtures] = process.argv.slice(2);
const load = (name) => JSON.parse(fs.readFileSync(path.join(work, `browser-runtime-${name}`, 'ai_agents_internal', 'preflight.json'), 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(`browser runtime: ${message}`); };
const lanes = (report) => new Map(report.agents.map((agent) => [agent.slug, agent]));
const capability = (report, id) => report.capabilities.find((item) => item.id === id);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const working = load('working');
const module = fs.realpathSync(path.join(fixtures, 'fake-playwright'));
const runtime = working.browserRuntime;
assert(runtime.status === 'available' && runtime.source === 'profile' && runtime.modulePath === module, `working fixture was not resolved from the profile: ${runtime.status} ${runtime.evidence}`);
assert(runtime.moduleVersion === '0.0.0-argus-fixture' && runtime.executablePath === '/argus-fixture/chromium/headless-shell', 'working fixture version or executable path was not recorded');
assert(runtime.packageJsonSha256 === sha256(fs.readFileSync(path.join(module, 'package.json'))), 'packageJsonSha256 is not the digest of package.json bytes');
assert(runtime.candidates.length === 1 && runtime.candidates[0].result === 'launched', 'an explicit profile module must be the only probed candidate');
// Recompute moduleTreeSha256 exactly as ENGAGEMENT-POLICY.md documents it.
const entries = [];
for (const root of runtime.moduleTreeRoots) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const entryPath = path.join(directory, name);
      const stat = fs.lstatSync(entryPath);
      const label = path.relative(path.dirname(runtime.modulePath), entryPath).split(path.sep).join('/');
      if (stat.isSymbolicLink()) entries.push([label, 'symlink', fs.readlinkSync(entryPath)]);
      else if (stat.isDirectory()) pending.push(entryPath);
      else entries.push([label, 'file', sha256(fs.readFileSync(entryPath))]);
    }
  }
}
entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
const tree = crypto.createHash('sha256');
for (const [label, kind, payload] of entries) tree.update(`${label}\0${kind}\0${payload}\n`);
assert(runtime.moduleTreeRoots[0] === module && runtime.moduleTreeSha256 === tree.digest('hex'), 'moduleTreeSha256 does not follow the documented algorithm');
const workingCapability = capability(working, 'browser-runtime');
assert(workingCapability.available && workingCapability.evidence.includes('from profile') && workingCapability.evidence.includes('0.0.0-argus-fixture')
  && workingCapability.evidence.includes('/argus-fixture/chromium/headless-shell'), 'browser-runtime evidence must name the source, version, and executable');
for (const slug of ['orion', 'lynceus', 'antigone']) {
  assert(lanes(working).get(slug).status === 'ready', `${slug} must be ready once the runtime launches (got ${lanes(working).get(slug).status})`);
}

const broken = load('broken');
assert(broken.browserRuntime.status === 'unavailable' && broken.browserRuntime.modulePath === null, 'broken fixture was reported available');
assert(broken.browserRuntime.candidates[0]?.result === 'failed' && broken.browserRuntime.candidates[0].evidence.includes('fixture: browser executable missing'),
  'broken fixture launch failure was not recorded as candidate evidence');
assert(!capability(broken, 'browser-runtime').available && capability(broken, 'browser-runtime').evidence.includes('fixture: browser executable missing'),
  'broken fixture capability does not carry the first failure');
assert(lanes(broken).get('orion').status === 'conditional' && JSON.stringify(lanes(broken).get('orion').pendingGates) === '["browser-runtime"]',
  'orion must wait on the browser-runtime gate without a functional browser runtime');

const planted = load('planted');
const plantedModule = fs.realpathSync(path.join(work, 'browser-runtime-planted', 'node_modules', 'playwright'));
assert(planted.browserRuntime.status === 'unavailable' && planted.browserRuntime.modulePath === null
  && JSON.stringify(planted.browserRuntime.candidates) === JSON.stringify([{ source: 'profile', modulePath: plantedModule, result: 'invalid',
    evidence: 'module lies inside the worker-writable artifact root' }]), `a module inside the artifact root was not refused: ${JSON.stringify(planted.browserRuntime)}`);
assert(!fs.existsSync(path.join(work, 'browser-runtime-planted', 'planted-module-ran')), 'preflight imported a module planted inside the artifact root');
assert(lanes(planted).get('orion').status === 'conditional', 'a refused planted runtime must leave orion waiting on its browser-runtime gate');

const disabled = load('disabled');
assert(disabled.browserRuntime.status === 'not-probed' && disabled.browserRuntime.evidence === 'profile disabled browser runtime resolution'
  && disabled.browserRuntime.probedAt === null, 'browserRuntime=false must skip resolution');
assert(!capability(disabled, 'db-access').available && lanes(disabled).get('charon').status === 'skipped'
  && lanes(disabled).get('charon').pendingGates.length === 0, 'without an operator --feature db-access charon must stay skipped, never pending recon');

// argus-launch runs preflight under `env -i` with a fixed allowlist, so database coordinates
// never reach an engagement: only an operator --feature db-access declares the capability,
// and a direct-CLI diagnostic must predict the same disposition.
const database = load('database');
assert(!capability(database, 'db-access').available && capability(database, 'db-access').evidence === 'target/profile feature not detected: db-access',
  'DATABASE_URL made db-access available although only an operator --feature declares it');
assert(lanes(database).get('charon').status === lanes(disabled).get('charon').status
  && JSON.stringify(lanes(database).get('charon').pendingGates) === JSON.stringify(lanes(disabled).get('charon').pendingGates),
  `database coordinates changed the charon disposition (got ${lanes(database).get('charon').status})`);
assert(!JSON.stringify(database).includes('postgres://fixture'), 'database coordinates leaked into the preflight report');
NODE

invalid_browser_root="$WORK/browser-runtime-invalid"
mkdir -p "$invalid_browser_root"
jq '.browserRuntime = {modulePath: "relative/playwright"}' "$browser_profile" >"$WORK/browser-runtime-invalid-profile.json"
if "$CLI" preflight --target http://127.0.0.1:9/ --artifact-root "$invalid_browser_root" --mode B \
  --profile "$WORK/browser-runtime-invalid-profile.json" >/dev/null 2>"$WORK/browser-runtime-invalid.stderr"; then
  fail 'preflight accepted a relative browserRuntime.modulePath'
fi
grep -Fq 'preflight profile browserRuntime must be false or' "$WORK/browser-runtime-invalid.stderr" || \
  fail 'invalid browserRuntime profile was not rejected with its contract'

# An operator --feature can declare only target capabilities. Browser and MCP capabilities are
# proven by preflight's own probes, so declaring one never overrides a failed runtime probe.
for probed_feature in browser-runtime playwright-mcp context7; do
  probed_root="$WORK/browser-runtime-declared-$probed_feature"
  mkdir -p "$probed_root/ai_agents_internal"
  cp "$AUTH_FIXTURES/full.json" "$probed_root/ai_agents_internal/authorization.json"
  if "$CLI" preflight --target http://127.0.0.1:9/ --artifact-root "$probed_root" --mode B \
    --authorization "$probed_root/ai_agents_internal/authorization.json" \
    --profile "$WORK/browser-runtime-broken-profile.json" --feature db-access --feature "$probed_feature" \
    >/dev/null 2>"$probed_root.stderr"; then
    fail "preflight accepted the probe-only --feature $probed_feature"
  fi
  grep -Fq "preflight --feature $probed_feature is not operator-declarable" "$probed_root.stderr" || \
    { cat "$probed_root.stderr" >&2; fail "probe-only --feature $probed_feature was not refused as not operator-declarable"; }
  [ ! -e "$probed_root/ai_agents_internal/preflight.json" ] || fail "refused --feature $probed_feature still wrote a preflight report"
done

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
  if [ "$scenario" = partial ]; then
    manifest="$target/ai_agents_internal/engagement.json"
    argus_smoke_prepare_model_control "$CLI" "$manifest" "$target" "$target" A \
      "$FIXTURES/partial.json" "$WORK/model-control-host" >/dev/null
    odysseus_allocation="$(argus_smoke_allocate "$CLI" "$manifest" "$WORK/model-control-host" odysseus)"
    odysseus_token="$(jq -r .token <<<"$odysseus_allocation")"
    seal="$target/ai_agents_internal/model-control-seal.json"
    # The seal binds every dispatchable record, conditional lanes included, and the engagement
    # state carries exactly the sealed report's conditional projection.
    jq -e --slurpfile preflight "$target/ai_agents_internal/preflight.json" '
      ([ $preflight[0].agents[] | select(.selected and (.status == "ready" or .status == "degraded" or .status == "conditional") and (.slug == "odysseus" or .dispatchAllowed == true)) | .slug ] | sort) as $expected |
      (.dispatchableAgents | sort) == $expected and ([.decisions | keys[]] | sort) == $expected and
      (.decisions | has("orion")) and (.decisions | has("tiresias")) and ([.dispatchableAgents[] | select(. == "charon" or . == "mnemosyne" or . == "pistis")] | length) == 0
    ' "$seal" >/dev/null || fail 'partial model-control seal differs from the exact dispatchable preflight projection'
    "$CLI" engagement status --manifest "$manifest" >"$WORK/partial-sealed-state.json"
    jq -e --slurpfile preflight "$target/ai_agents_internal/preflight.json" '
      ([ $preflight[0].agents[] | select(.status == "conditional") | {key: .slug, value: .pendingGates} ] | from_entries) as $expected |
      .conditionalAgents == $expected and (.conditionalAgents | length) == 8 and .gateResolution == null
    ' "$WORK/partial-sealed-state.json" >/dev/null || fail 'sealed engagement state does not carry the conditional preflight projection'

    # After the seal, preflight never rewrites the sealed report; a diagnostic report under
    # another output path stays allowed and leaves the sealed report and projection intact.
    sealed_report_digest="$(digest_file "$report")"
    sealed_plan_digest="$(digest_file "$target/ai_agents_internal/orchestration-plan.json")"
    if "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/partial.json" \
      --environment unknown >/dev/null 2>"$WORK/sealed-preflight.stderr"; then
      fail 'preflight rewrote the sealed report after the first allocation'
    fi
    grep -Fq 'preflight.json is sealed by the model-control seal; release conditional lanes with `argus-assets engagement resolve-gates`, never by rerunning preflight' \
      "$WORK/sealed-preflight.stderr" || fail "sealed preflight rerun failed for the wrong reason: $(cat "$WORK/sealed-preflight.stderr")"
    if "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/partial.json" \
      --environment unknown --output ../escaped-preflight.json >/dev/null 2>"$WORK/sealed-escape.stderr"; then
      fail 'an unsafe output path fell back to the sealed report'
    fi
    grep -Fq 'preflight.json is sealed by the model-control seal' "$WORK/sealed-escape.stderr" || fail 'an unsafe output path was not refused as the sealed report'
    test ! -e "$WORK/escaped-preflight.json" || fail 'a refused sealed preflight wrote outside the artifact root'
    "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/partial.json" \
      --environment unknown --output ai_agents_internal/preflight-diagnostic.json >/dev/null || fail 'a diagnostic preflight to another output was refused after the seal'
    jq -e '.status == "degraded" and .summary.conditional == 8' "$target/ai_agents_internal/preflight-diagnostic.json" >/dev/null || \
      fail 'the diagnostic preflight did not report the same conditional projection'
    [ "$(digest_file "$report")" = "$sealed_report_digest" ] || fail 'a refused or diagnostic preflight changed the sealed report'
    [ "$(digest_file "$target/ai_agents_internal/orchestration-plan.json")" = "$sealed_plan_digest" ] || \
      fail 'a diagnostic preflight changed the sealed orchestration projection'

    mkdir -p "$WORK/partial-tokens"
    printf '%s\n' "$odysseus_token" >"$WORK/partial-tokens/odysseus"
    # A conditional lane is sealed but refuses allocation until resolve-gates records its verdict.
    if conditional_output="$(argus_smoke_allocate "$CLI" "$manifest" "$WORK/model-control-host" orion "$odysseus_token" 2>&1)"; then
      fail 'a conditional lane allocated before engagement resolve-gates'
    fi
    grep -Fq 'orion is conditional on browser-runtime; run engagement resolve-gates first' <<<"$conditional_output" || \
      fail "pre-resolution conditional allocation failed for the wrong reason: $conditional_output"
    while IFS= read -r lane; do
      allocation="$(argus_smoke_allocate "$CLI" "$manifest" "$WORK/model-control-host" "$lane" "$odysseus_token")"
      jq -r .token <<<"$allocation" >"$WORK/partial-tokens/$lane"
    done < <(jq -r --slurpfile state "$WORK/partial-sealed-state.json" \
      '.dispatchableAgents[] as $lane | select($lane != "odysseus" and ($state[0].conditionalAgents | has($lane) | not)) | $lane' "$seal")

    # Kalchas arrives at discovery; resolve-gates then re-probes the browser runtime against a
    # host-provisioned fixture (deterministic whatever the host has installed) and, with no
    # capability evidence file, leaves every evidence-backed gate unmet.
    "$CLI" engagement barrier arrive --manifest "$manifest" --lane kalchas \
      --token "$(tr -d '\n' <"$WORK/partial-tokens/kalchas")" --phase discovery >/dev/null
    partial_home="$WORK/partial-home"
    mkdir -p "$partial_home/.cache/argus/browser-runtime/0.0.1/node_modules"
    cp -R "$FIXTURES/fake-playwright" "$partial_home/.cache/argus/browser-runtime/0.0.1/node_modules/playwright"
    HOME="$partial_home" "$CLI" engagement resolve-gates --manifest "$manifest" --controller-token "$odysseus_token" >"$WORK/partial-gates.json"
    jq -e '.released == ["antigone","daidalos","lynceus","orion","penelope"]
      and .gateUnmet == ["asklepios","proteus","tiresias"]
      and .gateResolution.evidenceSha256 == null
      and .gateResolution.capabilities["browser-runtime"].status == "proven"
      and ([.gateResolution.capabilities[] | select(.status == "unmet")] | length) == 3
      and ([.gateResolution.capabilities[] | select(.basis == "operator-feature-required")] | length) == 0' "$WORK/partial-gates.json" >/dev/null || \
      fail "partial resolve-gates released the wrong lanes: $(cat "$WORK/partial-gates.json")"
    while IFS= read -r lane; do
      allocation="$(argus_smoke_allocate "$CLI" "$manifest" "$WORK/model-control-host" "$lane" "$odysseus_token")"
      jq -r .token <<<"$allocation" >"$WORK/partial-tokens/$lane"
    done < <(jq -r '.released[]' "$WORK/partial-gates.json")
    # The released browser lanes import exactly the runtime resolve-gates recorded. A diagnostic
    # preflight after the seal, including a Codex one that fails its own mandatory check, keeps
    # its result in its own report and never replaces that record.
    runtime_record="$target/ai_agents_internal/browser-runtime.json"
    runtime_record_digest="$(digest_file "$runtime_record")"
    jq -e '.status == "available" and .source == "host-provisioned"' "$runtime_record" >/dev/null || \
      fail "resolve-gates did not record the host-provisioned runtime: $(cat "$runtime_record")"
    "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/partial.json" \
      --environment unknown --output ai_agents_internal/preflight-diagnostic2.json >/dev/null || fail 'a diagnostic preflight after gate resolution was refused'
    jq -e '.browserRuntime.status == "not-probed"' "$target/ai_agents_internal/preflight-diagnostic2.json" >/dev/null || \
      fail 'the post-resolution diagnostic preflight did not report its own browser runtime result'
    if "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/partial.json" \
      --environment unknown --model-runtime codex --output ai_agents_internal/preflight-diagnostic-codex.json >/dev/null 2>&1; then
      fail 'a Codex diagnostic preflight passed without a native hard turn cap'
    fi
    [ "$(digest_file "$runtime_record")" = "$runtime_record_digest" ] || \
      fail "a diagnostic preflight after the seal replaced browser-runtime.json: $(cat "$runtime_record")"
    if omitted_output="$(argus_smoke_allocate "$CLI" "$manifest" "$WORK/model-control-host" asklepios "$odysseus_token" 2>&1)"; then
      fail 'a gate-unmet lane allocated after engagement resolve-gates'
    fi
    grep -Fq 'asklepios was omitted: gate unmet (existing-suite)' <<<"$omitted_output" || \
      fail "gate-unmet allocation failed for the wrong reason: $omitted_output"
    "$CLI" engagement barrier status --manifest "$manifest" --phase discovery | jq -e '.participants | index("tiresias") | not' >/dev/null || \
      fail 'a gate-unmet discovery lane still holds the discovery barrier'
    while [ "$("$CLI" engagement status --manifest "$manifest" | jq -r .currentPhase)" != complete ]; do
      phase="$("$CLI" engagement status --manifest "$manifest" | jq -r .currentPhase)"
      while IFS= read -r lane; do
        "$CLI" engagement barrier arrive --manifest "$manifest" --lane "$lane" \
          --token "$(tr -d '\n' <"$WORK/partial-tokens/$lane")" --phase "$phase" >/dev/null
      done < <("$CLI" engagement barrier status --manifest "$manifest" --phase "$phase" | jq -r '.participants[]')
      # A proof phase with its validator dispatched advances only after a Minos ledger merge.
      if jq -e --arg phase "$phase" '.phasePlan[] | select(.id == $phase) | .kind == "proof"' "$manifest" >/dev/null &&
        "$CLI" engagement barrier status --manifest "$manifest" --phase "$phase" | jq -e '.participants | index("minos")' >/dev/null; then
        if [ ! -f "$WORK/partial-ledger.json" ]; then
          jq -n --arg id "$(jq -r .engagementId "$manifest")" '{"$schema":"argus/bug-ledger@2",schemaVersion:2,engagementId:$id,bugs:[]}' >"$WORK/partial-ledger.json"
          "$CLI" engagement fragment --manifest "$manifest" --lane minos --token "$(tr -d '\n' <"$WORK/partial-tokens/minos")" \
            --canonical solution/bug-ledger.json --id partial-ledger --input "$WORK/partial-ledger.json" >/dev/null
        fi
        "$CLI" engagement merge --manifest "$manifest" --owner minos --token "$(tr -d '\n' <"$WORK/partial-tokens/minos")" \
          --canonical solution/bug-ledger.json >/dev/null
      fi
      # Kleio's merged final summary is the completion record, so reporting advances only after it.
      # This Mode A engagement has no installed template selection, hence no framework and no
      # runner result: the runner=null summary merges, blocked by template-selection-missing.
      if [ "$phase" = reporting ]; then
        if "$CLI" engagement barrier advance --manifest "$manifest" --lane odysseus --token "$odysseus_token" >/dev/null 2>"$WORK/partial-unsummarized.err"; then
          fail 'reporting advanced to completion without a merged final summary'
        fi
        grep -Fq 'phase reporting requires the kleio merge of solution/final-summary.json before it can advance' "$WORK/partial-unsummarized.err" || \
          fail "an unsummarized reporting advance failed for the wrong reason: $(cat "$WORK/partial-unsummarized.err")"
        kalchas_token="$(tr -d '\n' <"$WORK/partial-tokens/kalchas")"
        kleio_token="$(tr -d '\n' <"$WORK/partial-tokens/kleio")"
        engagement_id="$(jq -r .engagementId "$manifest")"
        jq --arg id "$engagement_id" '.engagementId = $id | .items[0].discoveryEvidenceIds = []' "$ROOT/scripts/fixtures/argus-schemas/valid/surface-inventory.json" \
          >"$WORK/partial-inventory.json"
        jq -n --arg id "$engagement_id" '{"$schema":"argus/coverage-observations@2",schemaVersion:2,engagementId:$id,observations:[]}' >"$WORK/partial-observations.json"
        "$CLI" engagement fragment --manifest "$manifest" --lane kalchas --token "$kalchas_token" \
          --canonical solution/surface-inventory.json --id partial-inventory --input "$WORK/partial-inventory.json" >/dev/null
        "$CLI" engagement merge --manifest "$manifest" --owner kalchas --token "$kalchas_token" --canonical solution/surface-inventory.json >/dev/null
        "$CLI" engagement fragment --manifest "$manifest" --lane kleio --token "$kleio_token" \
          --canonical solution/coverage-observations.json --id partial-observations --input "$WORK/partial-observations.json" >/dev/null
        "$CLI" engagement merge --manifest "$manifest" --owner kleio --token "$kleio_token" --canonical solution/coverage-observations.json >/dev/null
        (cd "$target" && "$CLI" coverage calculate --inventory solution/surface-inventory.json --observations solution/coverage-observations.json \
          --ledger solution/bug-ledger.json --root "$target") >"$WORK/partial-coverage.json"
        "$CLI" engagement fragment --manifest "$manifest" --lane kleio --token "$kleio_token" \
          --canonical solution/coverage-result.json --id partial-coverage --input "$WORK/partial-coverage.json" >/dev/null
        "$CLI" engagement merge --manifest "$manifest" --owner kleio --token "$kleio_token" --canonical solution/coverage-result.json >/dev/null
        jq --arg id "$engagement_id" '.engagementId = $id | .runner = null' "$ROOT/scripts/fixtures/argus-schemas/valid/final-summary.json" >"$WORK/partial-summary.json"
        "$CLI" engagement fragment --manifest "$manifest" --lane kleio --token "$kleio_token" \
          --canonical solution/final-summary.json --id partial-summary --input "$WORK/partial-summary.json" >/dev/null
        "$CLI" engagement merge --manifest "$manifest" --owner kleio --token "$kleio_token" --canonical solution/final-summary.json >/dev/null
        jq -e '.runner == null and .status == "blocked" and (.statusReasons | index("template-selection-missing") != null)' "$target/solution/final-summary.json" >/dev/null || \
          fail "the unselected Mode A summary was not blocked by the missing template selection: $(cat "$target/solution/final-summary.json")"
      fi
      "$CLI" engagement barrier advance --manifest "$manifest" --lane odysseus --token "$odysseus_token" >/dev/null
    done
    "$CLI" engagement barrier arrive --manifest "$manifest" --lane odysseus --token "$odysseus_token" --phase complete >/dev/null
    # Gate-unmet lanes never allocated, so cleanup covers exactly the allocated workers.
    while IFS= read -r lane; do
      "$CLI" engagement cleanup --manifest "$manifest" --lane "$lane" \
        --token "$(tr -d '\n' <"$WORK/partial-tokens/$lane")" --outcome success >/dev/null
    done < <(jq -r --slurpfile gates "$WORK/partial-gates.json" \
      '.dispatchableAgents[] as $lane | select($lane != "odysseus" and ($gates[0].gateUnmet | index($lane) | not)) | $lane' "$seal")
    "$CLI" engagement cleanup --manifest "$manifest" --lane odysseus --token "$odysseus_token" --outcome success >/dev/null
    jq -e '([.allocations[] | select(.status == "active")] | length) == 0 and (.exclusiveLocks | length) == 0' \
      "$target/ai_agents_internal/engagement-state.json" >/dev/null || fail 'partial lifecycle left active allocations or locks'
  fi
  if [ "$scenario" = full ]; then
    openssl genpkey -algorithm ED25519 -out "$WORK/preflight-model-private.pem" >/dev/null 2>&1
    openssl pkey -in "$WORK/preflight-model-private.pem" -pubout \
      -out "$WORK/preflight-model-public.pem" >/dev/null 2>&1
    openssl genpkey -algorithm ED25519 -out "$WORK/preflight-operator-private.pem" >/dev/null 2>&1
    openssl pkey -in "$WORK/preflight-operator-private.pem" -pubout \
      -out "$WORK/preflight-operator-public.pem" >/dev/null 2>&1
    trust_store="$WORK/preflight-model-trust.json"
    jq -n --rawfile runtimePublic "$WORK/preflight-model-public.pem" --rawfile operatorPublic "$WORK/preflight-operator-public.pem" \
      '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
        {keyId:"preflight-runtime",purpose:"runtime-attestation",subjectId:"preflight-runtime-wrapper",algorithm:"Ed25519",publicKeyPem:$runtimePublic,status:"active"},
        {keyId:"preflight-operator",purpose:"operator-approval",subjectId:"preflight-smoke-operator",algorithm:"Ed25519",publicKeyPem:$operatorPublic,status:"active"}
      ]}' \
      >"$trust_store"
    chmod 600 "$trust_store"
    ARGUS_MODEL_TRUST_STORE="$(realpath "$trust_store")" "$CLI" model trust \
      --manifest "$target/ai_agents_internal/engagement.json" \
      --runtime-key-id preflight-runtime --operator-key-id preflight-operator \
      >/dev/null
    if "$CLI" model route --manifest "$target/ai_agents_internal/engagement.json" --agent aegis --runtime claude --signal normal --dispatch-id stale-preflight-digest --attempt 1 >/dev/null 2>&1; then
      fail 'model route accepted a preflight report whose engagement digest predates trust pinning'
    fi
    "$CLI" preflight \
      --target "$target" \
      --artifact-root "$target" \
      --mode A \
      --profile "$FIXTURES/$scenario.json" \
      "${authorization_args[@]}" \
      >/dev/null
    decision="$WORK/full-model-decision.json"
    "$CLI" model route --manifest "$target/ai_agents_internal/engagement.json" --agent aegis --runtime claude --signal normal --dispatch-id preflight-digest --attempt 1 >"$decision"
    [ "$(jq -r .engagement.sha256 "$report")" = "$(jq -r .engagementManifestSha256 "$decision")" ] || fail 'preflight and model routing engagement digests differ'
  fi
done

# A signed launch that names its operator-approval anchor (argus-launch --operator-key-id) is
# routable after exactly one preflight. A URL launch runs in its artifact root, where the
# PreToolUse guard finds the engagement and denies `model trust`, and a second preflight would
# have to fit the five-minute launch window. Preflight therefore pins both signed anchors from
# the launch trust store while it creates the manifest, so its first report binds the final digest.
signed_root="$WORK/signed-anchor-artifacts"
mkdir -p "$signed_root"
signed_root="$(cd "$signed_root" && pwd -P)"
signed_manifest="$signed_root/ai_agents_internal/engagement.json"
signed_target='http://127.0.0.1:43999/'
signed_preflight() {
  (cd "$signed_root" && ARGUS_SMOKE_OPERATOR_KEY_ID="${1:-}" "$CLI" preflight --target "$signed_target" --mode B \
    --artifact-root "$signed_root" --engagement-id signed-anchor --profile "$FIXTURES/full.json")
}
signed_preflight signed-operator >/dev/null || fail 'signed-anchor launch preflight failed'
jq -e '.modelTrust.source == "host-trust-store" and .modelTrust.keys.operatorApproval.keyId == "signed-operator"
  and .modelTrust.keys.operatorApproval.purpose == "operator-approval"
  and (.modelTrust.keys.runtimeAttestation.keyId | startswith("runtime-"))
  and .modelTrust.keys.runtimeAttestation.purpose == "runtime-attestation"' "$signed_manifest" >/dev/null || {
  jq '.modelTrust' "$signed_manifest" >&2
  fail 'preflight did not pin the signed runtime and operator anchors when it created the engagement'
}
signed_guard() {
  jq -nc --arg cwd "$signed_root" --arg command "$1" \
    '{hook_event_name:"PreToolUse",session_id:"signed-anchor",cwd:$cwd,tool_name:"Bash",tool_input:{command:$command}}' | "$REAL_CLI" guard
}
grep -Fq 'GUARD-SHELL-AMBIGUOUS: model trust pinning is host/operator-only' \
  <<<"$(signed_guard "argus-assets model trust --manifest $signed_manifest --runtime-key-id runtime --operator-key-id operator")" || \
  fail 'the guard stopped denying in-session model trust pinning'
signed_route="argus-assets model route --manifest $signed_manifest --agents dispatchable --dispatch-prefix signed --signal normal --attempt 1 --runtime claude"
[ -z "$(signed_guard "$signed_route")" ] || fail 'the guard denied the controller batch route after a signed-anchor preflight'
"$REAL_CLI" ${signed_route#argus-assets } >"$WORK/signed-route.json" || fail 'routing required more than the one signed-anchor preflight'
jq -e '[.. | objects | select(has("agent") and has("status"))] | length > 0 and all(.status == "selected")' "$WORK/signed-route.json" >/dev/null || {
  cat "$WORK/signed-route.json" >&2
  fail 'batch routing after one signed-anchor preflight did not select every dispatchable lane'
}
# The pinned bundle is immutable: a relaunch with other signed anchors, and an unpinned manifest
# that a signed launch meets, are refused instead of re-pinned.
if signed_preflight signed-operator >"$WORK/signed-relaunch.stdout" 2>&1; then
  fail 'a relaunch with different signed anchors re-used the pinned engagement'
fi
jq -e '[.checks[] | select(.status == "fail") | .evidence] | any(contains("engagement modelTrust is not the trust this launch signed"))' \
  "$signed_root/ai_agents_internal/preflight.json" >/dev/null || fail 'a relaunch with different signed anchors was not refused by the pinned bundle'
unpinned_root="$WORK/unpinned-anchor-artifacts"
mkdir -p "$unpinned_root"
unpinned_root="$(cd "$unpinned_root" && pwd -P)"
(cd "$unpinned_root" && "$CLI" preflight --target "$signed_target" --mode B --artifact-root "$unpinned_root" \
  --engagement-id unpinned-anchor --profile "$FIXTURES/full.json" >/dev/null) || fail 'unsigned-anchor preflight failed'
jq -e '.modelTrust == null' "$unpinned_root/ai_agents_internal/engagement.json" >/dev/null || fail 'a launch without an operator anchor pinned model trust'
if (cd "$unpinned_root" && ARGUS_SMOKE_OPERATOR_KEY_ID=signed-operator "$CLI" preflight --target "$signed_target" --mode B \
  --artifact-root "$unpinned_root" --engagement-id unpinned-anchor --profile "$FIXTURES/full.json" >/dev/null 2>&1); then
  fail 'a signed-anchor launch accepted an unpinned existing engagement'
fi
jq -e '.modelTrust == null' "$unpinned_root/ai_agents_internal/engagement.json" >/dev/null || fail 'a signed-anchor launch rewrote an existing engagement manifest'

# Without Edit, Mode A blocks four essential lanes, which stop the engagement, and six
# non-essential automation lanes, which become deferred residuals with downgradedFrom=blocked.
target="$WORK/missing-edit-target"
mkdir -p "$target"
jq '.availableTools -= ["Edit"]' "$FIXTURES/full.json" >"$WORK/missing-edit-profile.json"
if "$CLI" preflight \
  --target "$target" \
  --artifact-root "$target" \
  --mode A \
  --profile "$WORK/missing-edit-profile.json" \
  >"$WORK/missing-edit.stdout" 2>&1; then
  fail 'blocked essential lanes unexpectedly passed preflight'
else
  status=$?
  [ "$status" -eq 2 ] || fail "blocked essential lanes exited $status instead of 2"
fi
grep -Fq 'downgraded=6 ' "$WORK/missing-edit.stdout" || fail 'preflight console line omitted the downgraded lane count'
report="$target/ai_agents_internal/preflight.json"
validate_report_schema "$report"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(`missing-edit: ${message}`); };
const bySlug = new Map(report.agents.map((agent) => [agent.slug, agent]));
const essentialBlocked = ['atlas', 'kleio', 'metis', 'minos'];
const downgraded = ['aegis', 'asklepios', 'daidalos', 'mnemosyne', 'nike', 'talos'];
assert(report.status === 'blocked', `expected blocked, got ${report.status}`);
assert(report.summary.blocked === 4 && report.summary.downgraded === 6, `expected 4 blocked and 6 downgraded, got ${report.summary.blocked}/${report.summary.downgraded}`);
for (const slug of essentialBlocked) {
  const agent = bySlug.get(slug);
  assert(agent.status === 'blocked' && agent.stopsEngagement === true && agent.downgradedFrom === undefined, `${slug} must stay blocked and stop the engagement`);
}
for (const slug of downgraded) {
  const agent = bySlug.get(slug);
  assert(agent.status === 'deferred' && agent.downgradedFrom === 'blocked' && agent.dispatchAllowed === false && agent.stopsEngagement === false,
    `${slug} must be a never-dispatched deferred lane downgraded from blocked`);
  assert(agent.missingTools.includes('Edit'), `${slug} lost its missing tool evidence`);
  assert(agent.actions.at(-1).startsWith(`Residual risk: ${slug} is blocked (Edit`), `${slug} does not name its residual risk`);
  const risk = report.residualRisks.find((entry) => entry.slug === slug);
  assert(risk?.status === 'deferred' && risk.downgradedFrom === 'blocked' && risk.reason.includes('Residual risk:'), `${slug} is missing from residualRisks`);
}
assert(report.agents.filter((agent) => agent.stopsEngagement).map((agent) => agent.slug).sort().join(',') === essentialBlocked.join(','),
  'only the blocked essential lanes may stop the engagement');
const plan = JSON.parse(fs.readFileSync(report.orchestration.path, 'utf8'));
const planned = plan.waves.flatMap((wave) => wave.roles.map((role) => role.slug));
assert(downgraded.every((slug) => !planned.includes(slug)) && essentialBlocked.every((slug) => !planned.includes(slug)),
  'the orchestration projection kept a blocked or downgraded lane');
assert(report.orchestration.specialists === report.summary.dispatchable && plan.essentialLanes.includes('kalchas'),
  'the orchestration projection is not bound to the dispatchable set or lost its essential lanes');
NODE

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
validate_report_schema "$report"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const engagement = report.checks.find((check) => check.id === 'engagement-manifest');
if (report.status !== 'blocked' || engagement?.status !== 'fail') throw new Error('malformed engagement manifest was not fail-closed');
if (report.engagement.sha256 !== null || report.engagement.phase !== null) throw new Error('malformed engagement manifest was treated as usable');
NODE
test ! -e "$target/ai_agents_internal/engagement-state.json" || fail "malformed engagement initialized state"

target="$WORK/target-mismatch"
mkdir -p "$target"
"$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/full.json" >/dev/null
jq '.target.identifier = "/different-target" | .target.root = "/different-target"' \
  "$target/ai_agents_internal/engagement.json" >"$WORK/mismatched-engagement.json"
mv "$WORK/mismatched-engagement.json" "$target/ai_agents_internal/engagement.json"
if "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/full.json" >/dev/null 2>&1; then
  fail 'engagement bound to a different target unexpectedly passed'
fi
validate_report_schema "$target/ai_agents_internal/preflight.json"
jq -e '.checks[] | select(.id == "engagement-manifest" and .status == "fail") | .evidence | contains("target does not match")' \
  "$target/ai_agents_internal/preflight.json" >/dev/null || fail 'target mismatch was not reported'

target="$WORK/symlink-control-root"
outside="$WORK/outside-control-root"
mkdir -p "$target" "$outside"
ln -s "$outside" "$target/ai_agents_internal"
if "$CLI" engagement init --target "$target" --artifact-root "$target" --mode A --engagement-id symlink-init >/dev/null 2>&1; then
  fail 'engagement init followed a symlinked control root'
fi
if "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/full.json" >/dev/null 2>&1; then
  fail 'symlinked control root unexpectedly passed preflight'
fi
[ -z "$(find "$outside" -mindepth 1 -print -quit)" ] || fail 'preflight wrote through a symlinked control root'

target="$WORK/hardlink-control-target"
mkdir -p "$target/app" "$target/ai_agents_internal"
printf 'application-source-sentinel\n' >"$target/app/source.txt"
cp "$target/app/source.txt" "$WORK/hardlink-source.before"
ln "$target/app/source.txt" "$target/ai_agents_internal/preflight.json"
if "$CLI" preflight --target "$target" --artifact-root "$target" --mode A --profile "$FIXTURES/full.json" >/dev/null 2>&1; then
  fail 'hard-linked preflight report unexpectedly passed'
fi
cmp -s "$WORK/hardlink-source.before" "$target/app/source.txt" || fail 'preflight mutated application source through a hard link'
[ "$(stat -c '%a' "$target/app/source.txt" 2>/dev/null || stat -f '%Lp' "$target/app/source.txt")" = \
  "$(stat -c '%a' "$WORK/hardlink-source.before" 2>/dev/null || stat -f '%Lp' "$WORK/hardlink-source.before")" ] || \
  fail 'preflight changed application source mode through a hard link'

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
validate_report_schema "$report"
node - "$report" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'blocked' || report.artifactRoot.safePaths !== false) throw new Error('unsafe artifact path was not blocked');
NODE

printf 'PASS  Argus preflight: bound projections, target identity, physical paths, and capability profiles\n'
