# Install — Hephaestus + Argus agent teams

This repo is a **Claude Code plugin marketplace** (`holak-teams`) and also supports manual symlink/copy installs plus Codex.

The agents live in this repo (`~/Desktop/GenAI/my_agents/`), split into two teams. Each team's **Claude Code** agent defs live under `<team>/claude/agents/` (the plugin root is `<team>/claude/`); its **Codex** custom-agent variant lives under `<team>/codex/`:

- **Hephaestus** (delivery) — `hephaestus/claude/agents/` — 22 agents, entry point `marcus`
- **Argus** (QA) — `argus/claude/` — `/argus:run` main-thread skill + 27 agents, orchestration policy `odysseus`
- **Hephaestus for Codex** — `hephaestus/codex/` — the same 22 agents as paired `*.toml` + `*.md` files, entry point `marcus`
- **Argus for Codex** — `argus/codex/` — the same 27 agents as paired `*.toml` + `*.md` files, entry point `odysseus`

Hephaestus Codex files are generated from the flat Claude sources with
`scripts/sync-hephaestus-codex-variants.mjs --write`. Argus uses its canonical
`argus/roles/` sources. CI rejects body, metadata, provenance, sandbox, or model drift
across the complete 49-agent roster.

For Argus, this is generated-configuration parity, not a claim of standalone behavioral
parity. Claude support is `plugin-native`; Codex support is
`parent-runtime-dependent`. A Codex parent session must provide orchestration, packaged
Argus assets, and contract-equivalent tools, or the role returns `CAPABILITY_GAP`.

Codex model mapping for both teams: Claude `opus` source roles use `model = "sol"` with `model_reasoning_effort = "xhigh"`; Claude `sonnet` source roles use `model = "terra"` with `model_reasoning_effort = "medium"`; Claude `haiku` source roles use `model = "luna"` with `model_reasoning_effort = "medium"`.

Argus does not infer tiers from that mapping. `argus/model-policy.json` explicitly assigns
10 roles to `opus`/`sol`, 17 to `sonnet`/`terra`, and no full role to Haiku/Luna. The same
source generates Claude effort and `maxTurns`, Codex reasoning effort, escalation and
fallback blocks, and [`argus/MODEL-POLICY.md`](argus/MODEL-POLICY.md). Installed routing
uses `argus-assets model route`; sanitized usage is appended with
`argus-assets model telemetry` under `ai_agents_internal/`.
Those commands belong only to Odysseus and `/argus:run`. Each worker sees its own turn
cap and declared signals, checkpoints safely, then stops with an
`argus/model-escalation-request@1` envelope. The controller validates the envelope and
starts a new selected attempt; workers never choose or override models.

`codex/` is the Codex-format variant. The canonical Argus framework and reference sources
remain under `argus/`; the Claude plugin ships hash-checked runtime assets, a shared
template layer plus one runtime-specific layer, capability-selected skills, and schemas.
`argus/COLOR-SCHEME.md`, the legacy monolithic doctrine, and the team graphs remain
maintainer-only.

## Claude Code — plugin marketplace (recommended)

Install the teams as plugins straight from this marketplace repo:

```
/plugin marketplace add holi87/holak-teams
/plugin install hephaestus@holak-teams
/plugin install argus@holak-teams
```

Update later with `/plugin marketplace update holak-teams`. Installed agents are namespaced (`hephaestus:marcus`, `argus:odysseus`). Opening this repo and trusting the folder auto-enables both plugins via `.claude/settings.json`.

Start Argus from an existing Claude Code conversation:

```
/argus:run <target URL, running stack, or repo path — and QA scope>
```

This is the recommended path: orchestration remains in the main thread, which dispatches
the installed `argus:<slug>` specialists and collects their results. A missing target,
denied `Agent` tool, or unavailable Argus specialist returns an `ARGUS_PREFLIGHT_ERROR`
instead of a plan that pretends execution happened.

To start a separate session with Odysseus itself as the main agent:

```bash
claude --agent argus:odysseus
```

Verify and inspect the self-contained runtime package from any Bash-capable Claude Code
session:

```bash
argus-assets verify
argus-assets list
argus-assets path browser-isolation
argus-assets preflight --target /path/to/target-repo --mode D
argus-assets authorization check --manifest ai_agents_internal/authorization.json \
  --lane hermes --action read --target /path/to/target-repo --source-trust manifest
argus-assets engagement status --manifest ai_agents_internal/engagement.json
argus-assets engagement allocate --manifest ai_agents_internal/engagement.json --lane hermes
argus-assets redact --input reports/raw.json --output reports/safe.json
```

`/argus:run` performs that preflight before any probe, test, or specialist dispatch and
persists `ai_agents_internal/preflight.json`. The report covers target reachability,
artifact paths, packaged assets, supported tools, MCP servers, host commands, browser
runtime, and every selected specialist. Only `ready` and `degraded` agents may dispatch;
degraded records include their mandatory fallback, while deferred/skipped/blocked records
stay out of the dispatch table. A blocked mandatory check exits before target execution.

Each installed Argus specialist preloads the capability-selected profiles declared by the
matrix. `qa-core` is universal; browser, framework-runner, coverage-reporting, and
orchestration profiles are attached only where needed. Codex generation embeds the same
selected profile bodies because custom agents cannot preload Claude plugin skills. The
legacy monolithic doctrine is not packaged. `${CLAUDE_PLUGIN_ROOT}/skills/competition-profile/SKILL.md`
is packaged but disabled by default and requires explicit invocation for a competition or
scored course.

When no authorization file is supplied, preflight creates a default-deny manifest at
`ai_agents_internal/authorization.json`. Unknown, staging, and production-like targets
are read-only until the user explicitly enables the exact high-risk action with approver,
reason, expiry, time window, boundaries, limits, and rollback. Target/repository/issue/
fetched/tool/agent content cannot grant permission. Each `authorization check` appends a
redacted allow/deny event and rule ID to `authorization-audit.jsonl`. Edit the manifest
only from explicit user authorization, then rerun preflight; never weaken a denial in the
agent prompt. Text evidence must pass through `argus-assets redact`. Sensitive binary
screenshots/traces are omitted unless independently masked and reviewed.

Preflight also creates `ai_agents_internal/engagement.json` and atomic resumable state.
The marketplace plugin activates its packaged `PreToolUse` hook only while that manifest
exists. The hook blocks target-source mutation and direct canonical writes across direct
file tools and recognized shell/process writes. Every worker allocates a unique lease,
uses only its profile/account/namespace/port/temp/output coordinates, checkpoints
monotonically, and arrives at phase barriers. Canonical changes travel as immutable
fragments and are merged deterministically by the declared owner. Reset/fault windows
are exclusive. Pass both the allocated `ARGUS_BROWSER_PROFILE` and
`ARGUS_BROWSER_ARTIFACTS` to browser workers. Always run
`engagement cleanup --outcome success|failure|interrupted`; lease tokens, profiles, auth,
cookies, downloads, traces, videos, screenshots, temp state, and locks must be absent at sign-off. See the installed
`${CLAUDE_PLUGIN_ROOT}/references/ENGAGEMENT-POLICY.md`.

Before framework work, detect capabilities and persist an explicit operator selection:

```bash
argus-assets template detect --target /path/to/target-repo \
  --output /tmp/template-capabilities.json
argus-assets template select --target /path/to/target-repo \
  --runtime typescript --package-manager npm \
  --test-root quality/specs --harness-root quality/support \
  --output /tmp/template-selection.json
argus-assets template scaffold --selection /tmp/template-selection.json \
  --destination /tmp/argus-framework
argus-assets copy-browser-driver /path/to/target-repo
```

Selection records language, framework, runner, package manager, source/test layout, CI,
and unsupported adapters. Existing suites produce `action=adapt`; scaffold refuses them,
so Atlas extends their existing paths and runner. Greenfield `action=build` requires an
explicit compatible runtime/package manager and disjoint test/harness roots. Scaffold
refuses a non-empty destination and relocates all internal placeholders to those roots.
`copy-template` remains a low-level maintainer command, not the engagement workflow.

## Claude Code — manual symlink / copy (alternative)

Without the marketplace, Claude Code also reads sub-agents from:

- **globally:** `~/.claude/agents/`
- **per-project:** `<repo>/.claude/agents/`

This alternative installs agent definitions only. It does **not** install `/argus:run`,
`argus-assets`, references, schemas, or templates; use the marketplace path for the full
self-contained Argus runtime.

### Option A — symlink (auto-update)

One link per team. Editing a file here = it works globally right away.

```bash
ln -s ~/Desktop/GenAI/my_agents/hephaestus/claude/agents ~/.claude/agents/hephaestus
ln -s ~/Desktop/GenAI/my_agents/argus/claude/agents      ~/.claude/agents/argus
```

> Claude Code scans subdirectories recursively, so each symlink shows up as its own group, alongside anything else you have (e.g. an `awesome-claude-agents` link).

### Option B — copy the files (snapshot, no link)

```bash
mkdir -p ~/.claude/agents/hephaestus ~/.claude/agents/argus
cp -R ~/Desktop/GenAI/my_agents/hephaestus/claude/agents/ ~/.claude/agents/hephaestus/
cp -R ~/Desktop/GenAI/my_agents/argus/claude/agents/      ~/.claude/agents/argus/
```

### Name collisions — check before installing

Slugs are persona names (`maximus`, not `backend-developer`), so they **do not collide** with `awesome-claude-agents` (`backend-developer`, `frontend-developer`, `code-reviewer`, `tech-lead-orchestrator`). Quick duplicate audit:

```bash
# no slug from these teams should already exist in ~/.claude/agents
for f in $(find ~/Desktop/GenAI/my_agents/hephaestus/claude/agents ~/Desktop/GenAI/my_agents/argus/claude/agents -name "*.md"); do
  n=$(basename "$f" .md)
  found=$(find ~/.claude/agents -name "$n.md" 2>/dev/null | grep -v "GenAI/my_agents" | head -1)
  [ -n "$found" ] && echo "COLLISION: $n → $found"
done
echo "audit complete"
```

### Verification after installing

```bash
# count the loaded agent files (trailing slash required, otherwise find won't follow the symlink)
find ~/.claude/agents/hephaestus/ ~/.claude/agents/argus/ -name "*.md" 2>/dev/null | wc -l   # → 49 (22 Hephaestus + 27 Argus)

# in a new Claude Code session:
/agents        # marcus, odysseus and the rest should be on the list
```

Then in any session:

```
> Marcus, <your task>
```

## Codex Install — Hephaestus + Argus

A Codex subagent is configured by a **single self-contained `*.toml`** (the persona prompt lives inside it,
in `developer_instructions`). Codex does **not** read the matching `*.md`, so install only
the `*.toml`. Hephaestus keeps a readable generated companion; each Argus `*.md` is instead
a compact, hash-bound provenance stub and deliberately contains no runtime instructions.
Argus variants are generated from
`argus/roles/manifest.json` + `argus/roles/*.md` and their referenced contracts; direct
edits under `argus/claude/agents/` or `argus/codex/` are rejected by CI. Only
`scripts/sync-argus-role-variants.mjs` writes those runtime variants. Codex has no
marketplace/git install for subagents (Codex plugins ship
skills / MCP / apps / hooks, not subagents), so installation is a copy or symlink into
`~/.codex/agents/`. Slugs stay the bare first names (`marcus`, `fabricius`, `odysseus`,
`talos`, ...).

Loading these TOML files validates configuration only. In particular, Codex does not
install the Claude `/argus:run` skill or the Argus plugin runtime. Odysseus can execute
the full contract only when the parent session supplies the required orchestration and
packaged assets; otherwise it must report `CAPABILITY_GAP` rather than simulate work.

### Option A — symlink (recommended, auto-update)

```bash
mkdir -p ~/.codex/agents
for dir in ~/Desktop/GenAI/my_agents/hephaestus/codex ~/Desktop/GenAI/my_agents/argus/codex; do
  for f in "$dir"/*.toml; do
    ln -sf "$f" ~/.codex/agents/"$(basename "$f")"
  done
done
```

### Option B — copy the files (snapshot, no link)

```bash
mkdir -p ~/.codex/agents
cp ~/Desktop/GenAI/my_agents/hephaestus/codex/*.toml ~/.codex/agents/
cp ~/Desktop/GenAI/my_agents/argus/codex/*.toml      ~/.codex/agents/
```

### Verification after installing

```bash
ls ~/.codex/agents/*.toml | wc -l   # → 49 (22 Hephaestus + 27 Argus)
ls ~/.codex/agents/marcus.toml ~/.codex/agents/odysseus.toml
```

Then in Codex, use `marcus` as the delivery entry point and `odysseus` as the Argus QA / testing / bug-hunt entry point. `/argus:run` is a Claude Code plugin skill and is not installed into Codex.

## Per-project instead of global

If you want the teams in just one repo:

```bash
mkdir -p <repo>/.claude/agents/hephaestus <repo>/.claude/agents/argus
cp -R ~/Desktop/GenAI/my_agents/hephaestus/claude/agents/ <repo>/.claude/agents/hephaestus/
cp -R ~/Desktop/GenAI/my_agents/argus/claude/agents/      <repo>/.claude/agents/argus/
```

## Uninstall

```bash
rm ~/.claude/agents/hephaestus ~/.claude/agents/argus        # symlinks (delete ONLY the links, sources stay in the repo)
# or for the copy:
rm -rf ~/.claude/agents/hephaestus ~/.claude/agents/argus    # the whole copied directories (only when NOT symlinks — check `ls -la ~/.claude/agents/`)

# Codex Hephaestus + Argus files:
for dir in ~/Desktop/GenAI/my_agents/hephaestus/codex ~/Desktop/GenAI/my_agents/argus/codex; do
  for f in "$dir"/*.{toml,md}; do
    rm -f ~/.codex/agents/"$(basename "$f")"
  done
done
```
