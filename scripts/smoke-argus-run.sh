#!/usr/bin/env bash
# Validate the /argus:run main-thread entry point. Use --live to execute two
# real plugin specialists through Claude Code and verify their collected result.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/argus/claude"
SKILL="$PLUGIN/skills/run/SKILL.md"
ODYSSEUS="$PLUGIN/agents/odysseus.md"
MODE="${1:---static}"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

require_text() {
  local pattern="$1" file="$2" message="$3"
  grep -Fq -- "$pattern" "$file" || fail "$message"
}

[ -f "$SKILL" ] || fail "missing argus/claude/skills/run/SKILL.md"
require_text "name: run" "$SKILL" "run skill has no stable name"
require_text 'disable-model-invocation: true' "$SKILL" "run skill must be user-invoked"
require_text 'allowed-tools: Read, Agent, Bash(argus-assets *)' "$SKILL" "run skill does not pre-approve its runtime asset verifier"
# shellcheck disable=SC2016 # The skill must retain Claude Code's literal runtime variable.
require_text '${CLAUDE_PLUGIN_ROOT}/agents/odysseus.md' "$SKILL" "run skill does not load the packaged Odysseus policy"
require_text 'ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED' "$SKILL" "missing target preflight error"
require_text 'ARGUS_PREFLIGHT_ERROR: AGENT_TOOL_UNAVAILABLE' "$SKILL" "missing Agent preflight error"
require_text 'ARGUS_PREFLIGHT_ERROR: ARGUS_AGENTS_UNAVAILABLE' "$SKILL" "missing specialist preflight error"
require_text 'ARGUS_PREFLIGHT_ERROR: CAPABILITY_PREFLIGHT_BLOCKED' "$SKILL" "missing capability preflight error"
require_text 'ai_agents_internal/preflight.json' "$SKILL" "run skill does not persist the preflight report"
require_text 'dispatchAllowed=true' "$SKILL" "run skill does not gate dispatch from the preflight report"
require_text 'ARGUS_SMOKE_OK: argus:kleio,argus:theseus' "$SKILL" "missing deterministic smoke result"
require_text 'tools: Read, Grep, Glob, Bash, Write, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent' "$ODYSSEUS" "Odysseus does not expose current orchestration tools"
require_text 'argus-assets preflight' "$ODYSSEUS" "Odysseus does not run the packaged capability preflight"

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
require_text 'Skills (1)  run' "$DETAILS_OUTPUT" "clean marketplace install does not expose the run skill"
require_text 'Agents (27)' "$DETAILS_OUTPUT" "clean marketplace install does not expose all 27 agents"
INSTALLED_PLUGIN="$(find "$CONFIG_DIR/plugins/cache/holak-teams/argus" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$INSTALLED_PLUGIN" ] && [ -d "$INSTALLED_PLUGIN" ] || fail "clean marketplace install did not create an Argus plugin cache"
printf 'PASS  clean marketplace install exposes /argus:run and 27 agents\n'

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
if (!report.agents.find((agent) => agent.slug === 'kleio')?.dispatchAllowed) throw new Error('Kleio was not dispatchable');
if (!report.agents.find((agent) => agent.slug === 'theseus')?.dispatchAllowed) throw new Error('Theseus was not dispatchable');
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
