# Global install — Hephaestus + Argus agent teams

The agents live in this repo (`~/Desktop/GenAI/my_agents/`), split into two teams. Each team keeps its Claude Code agent defs under a `claude/` directory and its Codex custom-agent variant under `codex/`:

- **Hephaestus** (delivery) — `hephaestus/claude/` — 22 agents, entry point `marcus`
- **Argus** (QA) — `argus/claude/` — 23 agents, entry point `odysseus`
- **Hephaestus for Codex** — `hephaestus/codex/` — the same 22 agents as paired `*.toml` + `*.md` files, entry point `marcus`
- **Argus for Codex** — `argus/codex/` — the same 23 agents as paired `*.toml` + `*.md` files, entry point `odysseus`

Codex model mapping for both teams: Claude `opus` source roles use `model = "gpt-5.5"` with `model_reasoning_effort = "xhigh"`; Claude `sonnet` source roles use `model = "gpt-5.5"` with `model_reasoning_effort = "medium"`; Claude `haiku` source roles use `model = "gpt-5.4-mini"` with `model_reasoning_effort = "medium"`.

`codex/` (Codex-format variant), `argus/framework-template/` (Playwright framework), and the two Argus reference docs (`argus/COLOR-SCHEME.md`, `argus/BROWSER-ISOLATION.md`) are **not** Claude agents. Claude Code reads sub-agents from:

- **globally:** `~/.claude/agents/`
- **per-project:** `<repo>/.claude/agents/`

## Claude Code Install

### Option A — symlink (recommended, auto-update)

One link per team. Editing a file here = it works globally right away.

```bash
ln -s ~/Desktop/GenAI/my_agents/hephaestus/claude ~/.claude/agents/hephaestus
ln -s ~/Desktop/GenAI/my_agents/argus/claude      ~/.claude/agents/argus
```

> Claude Code scans subdirectories recursively, so each symlink shows up as its own group, alongside anything else you have (e.g. an `awesome-claude-agents` link).

### Option B — copy the files (snapshot, no link)

```bash
mkdir -p ~/.claude/agents/hephaestus ~/.claude/agents/argus
cp -R ~/Desktop/GenAI/my_agents/hephaestus/claude/ ~/.claude/agents/hephaestus/
cp -R ~/Desktop/GenAI/my_agents/argus/claude/      ~/.claude/agents/argus/
```

### Name collisions — check before installing

Slugs are persona names (`maximus`, not `backend-developer`), so they **do not collide** with `awesome-claude-agents` (`backend-developer`, `frontend-developer`, `code-reviewer`, `tech-lead-orchestrator`). Quick duplicate audit:

```bash
# no slug from these teams should already exist in ~/.claude/agents
for f in $(find ~/Desktop/GenAI/my_agents/hephaestus/claude ~/Desktop/GenAI/my_agents/argus/claude -name "*.md"); do
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

Codex uses paired `*.toml` + `*.md` files. The portable install is to expose the files from both `hephaestus/codex/` and `argus/codex/` directly in `~/.codex/agents/`; the Codex slugs stay the same bare first names (`marcus`, `fabricius`, `odysseus`, `talos`, ...).

### Option A — symlink each file (recommended, auto-update)

```bash
mkdir -p ~/.codex/agents
for dir in ~/Desktop/GenAI/my_agents/hephaestus/codex ~/Desktop/GenAI/my_agents/argus/codex; do
  for f in "$dir"/*.{toml,md}; do
    ln -sf "$f" ~/.codex/agents/"$(basename "$f")"
  done
done
```

### Option B — copy the files (snapshot, no link)

```bash
mkdir -p ~/.codex/agents
cp ~/Desktop/GenAI/my_agents/hephaestus/codex/*.toml ~/.codex/agents/
cp ~/Desktop/GenAI/my_agents/hephaestus/codex/*.md   ~/.codex/agents/
cp ~/Desktop/GenAI/my_agents/argus/codex/*.toml ~/.codex/agents/
cp ~/Desktop/GenAI/my_agents/argus/codex/*.md   ~/.codex/agents/
```

### Verification after installing

```bash
find ~/Desktop/GenAI/my_agents/hephaestus/codex ~/Desktop/GenAI/my_agents/argus/codex -maxdepth 1 \( -name "*.toml" -o -name "*.md" \) | wc -l   # → 90 (45 agents × 2 files)
ls ~/.codex/agents/marcus.toml ~/.codex/agents/marcus.md
ls ~/.codex/agents/odysseus.toml ~/.codex/agents/odysseus.md
```

Then in Codex, use `marcus` as the delivery entry point and `odysseus` as the Argus QA / testing / bug-hunt entry point.

## Per-project instead of global

If you want the teams in just one repo:

```bash
mkdir -p <repo>/.claude/agents/hephaestus <repo>/.claude/agents/argus
cp -R ~/Desktop/GenAI/my_agents/hephaestus/claude/ <repo>/.claude/agents/hephaestus/
cp -R ~/Desktop/GenAI/my_agents/argus/claude/      <repo>/.claude/agents/argus/
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
