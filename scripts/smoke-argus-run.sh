#!/usr/bin/env bash
# Validate the /argus:run main-thread entry point. Use --live to execute two
# real plugin specialists through Claude Code and verify their collected result.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/argus/claude"
SKILL="$PLUGIN/skills/run/SKILL.md"
CORE="$PLUGIN/skills/orchestration-core/SKILL.md"
ODYSSEUS="$PLUGIN/agents/odysseus.md"
MODEL_POLICY="$ROOT/argus/model-policy.json"
MODE="${1:---static}"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

require_text() {
  local pattern="$1" file="$2" message="$3"
  grep -Fq -- "$pattern" "$file" || fail "$message"
}

require_controller_text() {
  local pattern="$1" message="$2"
  grep -Fq -- "$pattern" "$SKILL" "$CORE" || fail "$message"
}

[ -f "$SKILL" ] || fail "missing argus/claude/skills/run/SKILL.md"
[ -f "$CORE" ] || fail "missing argus/claude/skills/orchestration-core/SKILL.md"
[ -f "$ODYSSEUS" ] || fail "missing argus/claude/agents/odysseus.md"
require_text "name: run" "$SKILL" "run skill has no stable name"
require_text 'disable-model-invocation: true' "$SKILL" "run skill must be user-invoked"
require_text 'allowed-tools: Read, Agent, Bash(argus-assets *)' "$SKILL" "run skill does not pre-approve its runtime asset verifier"
ODYSSEUS_TIER="$(jq -r '.roles[] | select(.slug == "odysseus") | .tier' "$MODEL_POLICY")"
EXPECTED_CONTROLLER_MODEL="$(jq -r --arg tier "$ODYSSEUS_TIER" '.tiers[$tier].claude.model' "$MODEL_POLICY")"
EXPECTED_CONTROLLER_EFFORT="$(jq -r --arg tier "$ODYSSEUS_TIER" '.tiers[$tier].claude.effort' "$MODEL_POLICY")"
require_text "model: $EXPECTED_CONTROLLER_MODEL" "$SKILL" "run skill model differs from canonical Odysseus policy"
require_text "effort: $EXPECTED_CONTROLLER_EFFORT" "$SKILL" "run skill effort differs from canonical Odysseus policy"
# shellcheck disable=SC2016 # The skill must retain Claude Code's literal runtime variable.
require_text '${CLAUDE_PLUGIN_ROOT}/skills/orchestration-core/SKILL.md' "$SKILL" "run skill does not load the packaged orchestration core"
# shellcheck disable=SC2016 # The rejected path must also retain the literal runtime variable.
if grep -Fq -- '${CLAUDE_PLUGIN_ROOT}/agents/odysseus.md' "$SKILL"; then
  fail "run skill still loads Odysseus as a second policy source"
fi
require_text 'Do not read the Odysseus agent as a second policy source.' "$SKILL" "run skill does not forbid the duplicate Odysseus policy source"
require_text 'argus-assets preflight --target <target> --mode <A|B|C|D> --artifact-root <artifact-root>' "$SKILL" "run skill does not bind preflight and projection to one artifact root"
require_text 'name: orchestration-core' "$CORE" "orchestration core has no stable name"
require_text 'user-invocable: false' "$CORE" "orchestration core must not be user-invoked directly"
require_text '## Sources of authority' "$CORE" "orchestration core does not define authoritative sources"
require_text '## Select one engagement mode' "$CORE" "orchestration core does not own mode selection"
require_text '## Fail-closed preflight' "$CORE" "orchestration core does not own fail-closed preflight"
require_text '## Plan-driven execution and ownership' "$CORE" "orchestration core does not own plan-driven execution"
require_text '## Model decisions' "$CORE" "orchestration core does not own model decisions"
require_text '## Validation and closeout' "$CORE" "orchestration core does not own validation and closeout"
require_controller_text 'ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED' "missing target preflight error"
require_controller_text 'ARGUS_PREFLIGHT_ERROR: AGENT_TOOL_UNAVAILABLE' "missing Agent preflight error"
require_controller_text 'ARGUS_PREFLIGHT_ERROR: ARGUS_AGENTS_UNAVAILABLE' "missing specialist preflight error"
require_controller_text 'ARGUS_PREFLIGHT_ERROR: CAPABILITY_PREFLIGHT_BLOCKED' "missing capability preflight error"
require_controller_text 'ai_agents_internal/preflight.json' "controller does not persist/read the preflight report"
require_controller_text 'ai_agents_internal/orchestration-plan.json' "controller does not require the persisted orchestration projection"
require_controller_text 'ai_agents_internal/heartbeat/' "controller does not preserve the event-driven heartbeat board"
require_controller_text 'argus-assets authorization check' "controller does not enforce authorization decisions"
require_controller_text 'argus-assets redact' "controller does not enforce output redaction"
require_controller_text 'allocate each worker with its exact decision plus that token' "controller does not allocate isolated worker leases"
require_controller_text "on \`success\`, \`failure\`, or" "controller does not guarantee cleanup on success and failure"
require_controller_text "\`interrupted\`, preserving durable fragments/checkpoints." "controller does not guarantee cleanup after interruption"
require_controller_text 'argus-assets raci route' "controller does not route from the packaged RACI contract"
require_controller_text 'argus-assets model route' "controller does not route from the packaged model policy"
require_controller_text 'argus-assets model request' "controller cannot persist a worker escalation envelope"
require_controller_text 'argus-assets model telemetry' "controller does not record sanitized model telemetry"
require_controller_text 'model-escalation-request@1' "controller does not validate worker escalation envelopes"
require_controller_text 'model-operator-decision@1' "controller has no explicit frontier operator decision path"
require_controller_text 'argus-assets engagement heartbeat' "controller has no bounded heartbeat writer"
require_controller_text 'start a new thread' "controller can resume a thread under a different model"
require_controller_text 'argus-assets template detect' "controller does not detect template capabilities"
require_controller_text 'template select' "controller does not require explicit template selection"
require_controller_text 'dispatchAllowed=true' "controller does not gate dispatch from the preflight report"
require_controller_text 'Advance W0–W4' "controller does not own wave and barrier advancement"
require_controller_text 'Collect every RESULT' "controller does not collect and validate worker results"
require_controller_text 'selected-dispatchable-predecessors' "controller does not define dependency barrier semantics"
require_controller_text 'independent automation blocklist' "controller does not preserve independent automation review"
require_text 'ARGUS_SMOKE_OK: argus:kleio,argus:theseus' "$SKILL" "missing deterministic smoke result"
require_text 'tools: Read, Grep, Glob, Bash, Write, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent' "$ODYSSEUS" "Odysseus does not expose current orchestration tools"
require_text 'skills:' "$ODYSSEUS" "Odysseus does not preload its controller contracts"
require_text '  - qa-core' "$ODYSSEUS" "Odysseus does not preload qa-core"
require_text '  - orchestration-core' "$ODYSSEUS" "Odysseus does not preload orchestration-core"
require_text '  - qa-framework-runner' "$ODYSSEUS" "Odysseus does not preload the runner contract"
require_text '  - qa-coverage-reporting' "$ODYSSEUS" "Odysseus does not preload the coverage contract"
require_text "The complete controller policy is the preloaded \`orchestration-core\` skill." "$ODYSSEUS" "Odysseus does not defer to the single orchestration policy source"
require_text 'Do not reconstruct a roster,' "$ODYSSEUS" "Odysseus can reconstruct duplicated roster policy"
require_text 'routes work from the RACI contract' "$ODYSSEUS" "Odysseus frontmatter does not match RACI-driven execution"

ODYSSEUS_WORDS="$(wc -w <"$ODYSSEUS" | tr -d ' ')"
[ "$ODYSSEUS_WORDS" -le 800 ] || fail "Odysseus is no longer a compact controller shell ($ODYSSEUS_WORDS words; maximum 800)"
if grep -Eq '^## (Team )?Roster|^\|[[:space:]]*(Agent|Slug)[[:space:]]*\|' "$ODYSSEUS"; then
  fail "Odysseus duplicates the machine-owned specialist roster"
fi

if grep -Fq 'a subagent cannot spawn other subagents' "$ODYSSEUS"; then
  fail "Odysseus still contains the obsolete no-nested-agent claim"
fi

if command -v claude >/dev/null 2>&1; then
  claude plugin validate --strict "$PLUGIN" >/dev/null
else
  [ "$MODE" != "--live" ] || fail "claude CLI is required for --live"
fi

printf 'PASS  /argus:run static contract\n'

case "$MODE" in
  --static)
    exit 0
    ;;
  --live)
    ;;
  *)
    fail "usage: $0 [--static|--live]"
    ;;
esac

command -v claude >/dev/null 2>&1 || fail "claude CLI is required for --live"

OUTPUT="$(mktemp)"
NO_TARGET_OUTPUT="$(mktemp)"
NO_AGENT_OUTPUT="$(mktemp)"
ODYSSEUS_OUTPUT="$(mktemp)"
DETAILS_OUTPUT="$(mktemp)"
WORKDIR="$(mktemp -d)"
CONFIG_DIR="$(mktemp -d)"
trap 'rm -f "$OUTPUT" "$NO_TARGET_OUTPUT" "$NO_AGENT_OUTPUT" "$ODYSSEUS_OUTPUT" "$DETAILS_OUTPUT"; rm -rf "$WORKDIR" "$CONFIG_DIR"' EXIT

CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin marketplace add "$ROOT" >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin install argus@holak-teams --scope user >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin details argus@holak-teams >"$DETAILS_OUTPUT"
require_text 'Skills (7)' "$DETAILS_OUTPUT" "clean marketplace install does not expose all seven Argus skills"
require_text 'run' "$DETAILS_OUTPUT" "clean marketplace install does not expose the run skill"
require_text 'competition-profile' "$DETAILS_OUTPUT" "clean marketplace install does not expose the optional competition profile"
require_text 'orchestration-core' "$DETAILS_OUTPUT" "clean marketplace install does not expose the orchestration core"
require_text 'qa-core' "$DETAILS_OUTPUT" "clean marketplace install does not expose the core QA contract"
require_text 'qa-browser' "$DETAILS_OUTPUT" "clean marketplace install does not expose the browser QA contract"
require_text 'qa-framework-runner' "$DETAILS_OUTPUT" "clean marketplace install does not expose the framework runner contract"
require_text 'qa-coverage-reporting' "$DETAILS_OUTPUT" "clean marketplace install does not expose the coverage reporting contract"
require_text 'Agents (27)' "$DETAILS_OUTPUT" "clean marketplace install does not expose all 27 agents"
require_text 'Hooks (1)  PreToolUse' "$DETAILS_OUTPUT" "clean marketplace install does not activate the PreToolUse guard"
INSTALLED_PLUGIN="$(find "$CONFIG_DIR/plugins/cache/holak-teams/argus" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$INSTALLED_PLUGIN" ] && [ -d "$INSTALLED_PLUGIN" ] || fail "clean marketplace install did not create an Argus plugin cache"
printf 'PASS  clean marketplace install exposes /argus:run, six controller/QA/profile skills, 27 agents, and the PreToolUse guard\n'

(
  cd "$WORKDIR"
  claude \
    --plugin-dir "$INSTALLED_PLUGIN" \
    --print '/argus:run ARGUS_ORCHESTRATION_SMOKE' \
    --permission-mode dontAsk \
    --allowedTools Agent,Read,Bash \
    --output-format stream-json \
    --verbose \
    --no-session-persistence \
    >"$OUTPUT"
)

require_text 'argus:kleio' "$OUTPUT" "live smoke did not record the argus:kleio dispatch"
require_text 'argus:theseus' "$OUTPUT" "live smoke did not record the argus:theseus dispatch"
require_text 'ARGUS_SMOKE_KLEIO_OK' "$OUTPUT" "live smoke did not collect Kleio's result"
require_text 'ARGUS_SMOKE_THESEUS_OK' "$OUTPUT" "live smoke did not collect Theseus's result"
require_text 'ARGUS_SMOKE_OK: argus:kleio,argus:theseus' "$OUTPUT" "live smoke did not return the integrated success marker"
test -f "$WORKDIR/ai_agents_internal/preflight.json" || fail "live smoke did not persist its capability preflight report"
node - "$WORKDIR/ai_agents_internal/preflight.json" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.status === 'blocked') throw new Error('live orchestration smoke produced a blocked preflight');
if (!report.authorization?.defaultReadOnly || !report.authorization?.sha256) throw new Error('live orchestration smoke did not create a default-deny authorization manifest');
if (!report.engagement?.sha256 || !report.engagement?.hookPackaged || report.engagement?.phase !== 'discovery') throw new Error('live orchestration smoke did not create guarded engagement state');
if (!report.agents.find((agent) => agent.slug === 'kleio')?.dispatchAllowed) throw new Error('Kleio was not dispatchable');
if (!report.agents.find((agent) => agent.slug === 'theseus')?.dispatchAllowed) throw new Error('Theseus was not dispatchable');
NODE
test -f "$WORKDIR/ai_agents_internal/authorization.json" || fail "live smoke did not persist its authorization manifest"
test -f "$WORKDIR/ai_agents_internal/engagement.json" || fail "live smoke did not persist its engagement manifest"
test -f "$WORKDIR/ai_agents_internal/engagement-state.json" || fail "live smoke did not persist resumable engagement state"
node - "$WORKDIR/ai_agents_internal/engagement-state.json" <<'NODE'
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const lane of ['kleio', 'theseus']) {
  if (state.allocations[lane]?.status !== 'released') throw new Error(`${lane} smoke lease was not cleaned`);
}
if (Object.keys(state.exclusiveLocks).length) throw new Error('live smoke left an exclusive engagement lock');
NODE

printf 'PASS  /argus:run live dispatch: preflight + argus:kleio + argus:theseus collected\n'

(
  cd "$WORKDIR"
  claude \
    --plugin-dir "$INSTALLED_PLUGIN" \
    --print '/argus:run' \
    --tools Read \
    --permission-mode dontAsk \
    --no-session-persistence \
    >"$NO_TARGET_OUTPUT"
)
require_text 'ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED' "$NO_TARGET_OUTPUT" "live smoke did not reject a missing target"
printf 'PASS  /argus:run live preflight: missing target rejected\n'

(
  cd "$WORKDIR"
  claude \
    --plugin-dir "$INSTALLED_PLUGIN" \
    --print '/argus:run ARGUS_ORCHESTRATION_SMOKE' \
    --tools Read \
    --disallowedTools Agent \
    --permission-mode dontAsk \
    --no-session-persistence \
    >"$NO_AGENT_OUTPUT"
)
require_text 'ARGUS_PREFLIGHT_ERROR: AGENT_TOOL_UNAVAILABLE' "$NO_AGENT_OUTPUT" "live smoke did not reject unavailable Agent delegation"
printf 'PASS  /argus:run live preflight: unavailable Agent rejected\n'

(
  cd "$WORKDIR"
  claude \
    --plugin-dir "$INSTALLED_PLUGIN" \
    --agent argus:odysseus \
    --print 'No QA target was supplied. Perform the runtime preflight only.' \
    --tools Read \
    --permission-mode dontAsk \
    --no-session-persistence \
    >"$ODYSSEUS_OUTPUT"
)
require_text 'ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED' "$ODYSSEUS_OUTPUT" "claude --agent argus:odysseus did not load the runtime preflight contract"
printf 'PASS  alternate main session: claude --agent argus:odysseus\n'
