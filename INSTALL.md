# Install — Hephaestus + Argus agent teams

This repo is a **Claude Code plugin marketplace** (`holak-teams`) and also supports manual symlink/copy installs plus Codex.

The agents live in this repo (`~/Desktop/GenAI/my_agents/`), split into two teams. Each team's **Claude Code** agent defs live under `<team>/claude/agents/` (the plugin root is `<team>/claude/`); its **Codex** custom-agent variant lives under `<team>/codex/`:

- **Hephaestus** (delivery) — `hephaestus/claude/agents/` — 22 agents, entry point `marcus`
- **Argus** (QA) — `argus/claude/agents/` — 23 agents, entry point `odysseus`
- **Hephaestus for Codex** — `hephaestus/codex/` — the same 22 agents as paired `*.toml` + `*.md` files, entry point `marcus`
- **Argus for Codex** — `argus/codex/` — the same 23 agents as paired `*.toml` + `*.md` files, entry point `odysseus`

Codex model mapping for both teams: Claude `opus` source roles use `model = "gpt-5.5"` with `model_reasoning_effort = "xhigh"`; Claude `sonnet` source roles use `model = "gpt-5.5"` with `model_reasoning_effort = "medium"`; Claude `haiku` source roles use `model = "gpt-5.4-mini"` with `model_reasoning_effort = "medium"`.

`codex/` (Codex-format variant), `argus/framework-template/` (Playwright framework), and the Argus reference docs (`argus/COLOR-SCHEME.md`, `argus/SHARED-DOCTRINE.md`) are **not** Claude agents.

## Claude Code — plugin marketplace (recommended)

Install the teams as plugins straight from this marketplace repo:

```
/plugin marketplace add holi87/holak-teams
/plugin install hephaestus@holak-teams
/plugin install argus@holak-teams
```

Update later with `/plugin marketplace update holak-teams`. Installed agents are namespaced (`hephaestus:marcus`, `argus:odysseus`). Opening this repo and trusting the folder auto-enables both plugins via `.claude/settings.json`.

## Claude Code — manual symlink / copy (alternative)

Without the marketplace, Claude Code also reads sub-agents from:

- **globally:** `~/.claude/agents/`
- **per-project:** `<repo>/.claude/agents/`

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
find ~/.claude/agents/hephaestus/ ~/.claude/agents/argus/ -name "*.md" 2>/dev/null | wc -l   # → 45 (22 Hephaestus + 23 Argus)

# in a new Claude Code session:
/agents        # marcus, odysseus and the rest should be on the list
```

Then in any session:

```
> Marcus, <your task>
```

## Codex Install — Hephaestus + Argus

A Codex subagent is a **single standalone `*.toml`** (the persona prompt lives inside it, in `developer_instructions`). The matching `*.md` next to each `.toml` is the Claude-format companion — same content, **not read by Codex** — so for Codex you install only the `*.toml`. Codex has no marketplace/git install for subagents (Codex plugins ship skills / MCP / apps / hooks, not subagents), so the install is a copy or symlink of the `*.toml` files into `~/.codex/agents/`. Slugs stay the bare first names (`marcus`, `fabricius`, `odysseus`, `talos`, ...).

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
ls ~/.codex/agents/*.toml | wc -l   # → 45 (22 Hephaestus + 23 Argus)
ls ~/.codex/agents/marcus.toml ~/.codex/agents/odysseus.toml
```

Then in Codex, use `marcus` as the delivery entry point and `odysseus` as the Argus QA / testing / bug-hunt entry point.

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
