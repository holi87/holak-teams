# holak-teams — Claude Code plugin marketplace

This repository **is a Claude Code plugin marketplace**. It ships two themed sub-agent
teams as installable plugins:

| Plugin | Theme | Agents | Entry point | Purpose |
|---|---|:--:|---|---|
| **hephaestus** | Roman names | 22 | `marcus` | Software delivery — goal → designed team → delivered increment |
| **argus** | Greek names | 27 | `/argus:run` | QA — black-box bug hunting + regression automation |

Both teams are **hub-and-spoke**: you use the team's entry point (`marcus` or
`/argus:run`); its main-thread controller decomposes the work, dispatches specialists,
and reports back. Specialists never talk to each other directly.

---

## Install

### Recommended — via the marketplace

```
/plugin marketplace add holi87/holak-teams
/plugin install hephaestus@holak-teams
/plugin install argus@holak-teams
```

Then in any session:

```
> marcus, build a REST API for task management with tests and CI
> /argus:run <target — URL / running stack / repo path — and QA scope>
```

`/argus:run` stays in the main Claude Code thread, applies Odysseus's orchestration
policy, dispatches the namespaced specialists (`argus:kalchas`, `argus:metis`, etc.),
and collects their results. To start a new session with Odysseus as the main agent, use
`claude --agent argus:odysseus`. Installed plugin agents remain available under their
namespaced slugs. Update later with `/plugin marketplace update holak-teams`.

### Automatic — when working inside this repo

`.claude/settings.json` registers the marketplace and enables both plugins. Anyone who
clones this repo and **trusts the folder** is prompted to add `holak-teams` and gets both
plugins enabled automatically:

```json
{
  "extraKnownMarketplaces": {
    "holak-teams": { "source": { "source": "github", "repo": "holi87/holak-teams" }, "autoUpdate": true }
  },
  "enabledPlugins": { "hephaestus@holak-teams": true, "argus@holak-teams": true }
}
```

### Manual / Codex install

The plugins package their **Claude Code** components under `<team>/claude/`: flat agent
definitions for both teams and the `/argus:run` skill for Argus. The repo also carries
**Codex** variants (`<team>/codex/`, paired `*.toml` + `*.md`) and Playwright framework
templates outside the plugin roots. For symlink/copy installs and the Codex setup, see
**INSTALL.md**.

---

## Repository layout

Each plugin's root is the team's **`claude/`** directory — so Claude things and Codex
things are visibly separated, and the Codex variants are *not* shipped with the installed
plugin.

```
holak-teams/                         # this repo == the marketplace
├── .claude-plugin/
│   └── marketplace.json             # marketplace catalog (source: ./hephaestus/claude, ./argus/claude)
├── .claude/
│   └── settings.json                # auto-register marketplace + enable both plugins
├── AGENTS.md                        # this file (canonical doc)
├── CLAUDE.md -> AGENTS.md           # symlink (Claude Code project memory)
├── README.md / INSTALL.md
├── agents-roster.html               # visual roster (both teams)
├── hephaestus/                      # ── delivery team ──
│   ├── claude/                      # == PLUGIN ROOT (Claude only)
│   │   ├── .claude-plugin/plugin.json
│   │   └── agents/                  # 22 flat agent defs (loaded by Claude Code)
│   ├── codex/                       # Codex variants (*.toml + *.md) — separate, not in the plugin
│   ├── team-graph.html + .png       # visual team graph (embedded in README)
│   └── README.md                    # roster + how-to-start
└── argus/                           # ── QA team ──
    ├── claude/                      # == PLUGIN ROOT (Claude only)
    │   ├── .claude-plugin/plugin.json
    │   ├── agents/                  # 27 flat specialist defs (loaded by Claude Code)
    │   └── skills/run/SKILL.md      # /argus:run main-thread orchestrator
    ├── codex/                       # Codex variants (*.toml + *.md) — separate, not in the plugin
    ├── framework-template/          # prepped Playwright + TS framework (shared reference)
    ├── framework-template-java/     # RestAssured + JUnit5 + Playwright-Java (shared reference)
    ├── framework-template-python/   # pytest + Playwright + httpx (shared reference)
    ├── COLOR-SCHEME.md              # colors by role type (shared reference)
    ├── SHARED-DOCTRINE.md           # cross-agent QA doctrine (shared reference)
    ├── BROWSER-ISOLATION.md         # browser-lane isolation spec + hunt-driver verb map (shared reference)
    ├── team-graph.html + .png       # visual team graph (embedded in README)
    └── README.md                    # roster + how-to-start
```

**Plugin component rule (Claude Code):** inside a plugin root (`<team>/claude/`), agent
files must be **flat** inside `agents/` — no subdirectories. The agent slug is the file
name without `.md` (`marcus`, `odysseus`, …). The `codex/` variants and the argus shared
reference docs live **outside** the plugin root, so they are kept in the repo but never
loaded or shipped as Claude plugin components.

---

## Rosters

Full rosters, roles, models and lane structure live in each plugin's README:

- **Hephaestus** — `hephaestus/README.md` (22 agents: ba / dev / management / QA, leader `marcus`).
- **Argus** — `argus/README.md` (27 agents: core + surface×mode hunter/automation/path-analyst lanes, plus resilience, consumer-driven contract, and test-suite-sanitation roles, leader `odysseus`).

Codex runtime mapping for both teams: Claude `opus` → `sol` + `xhigh`,
`sonnet` → `terra` + `medium`, `haiku` → `luna` + `medium`.

---

## Versioning & releasing

Versions are **semver**. Each plugin's version is declared in **two** places that must
stay equal:

1. `<team>/claude/.claude-plugin/plugin.json` → `"version"` (source of truth for the installed plugin)
2. `.claude-plugin/marketplace.json` → the plugin's entry `"version"` (what `/plugin marketplace update` reads to detect a new release)

**To bump a plugin** (e.g. after editing its agents):

1. Edit the agent files under `<team>/claude/agents/` (and the matching `<team>/codex/` variant).
2. Raise `"version"` in **both** files above — same number — following semver:
   - **patch** (`1.0.0 → 1.0.1`): wording / prompt tweaks, no behavioural change.
   - **minor** (`1.0.0 → 1.1.0`): new agent, new capability, backward-compatible.
   - **major** (`1.0.0 → 2.0.0`): removed/renamed agent or breaking change to entry-point contract.
3. If you bump a plugin, also bump the marketplace's own top-level `"version"` in `marketplace.json`.
4. Commit and push. Installed users pick it up via `/plugin marketplace update holak-teams`
   (or automatically when `autoUpdate` is on).

---

## Adding or changing an agent

- One agent = one flat `*.md` file in `<team>/claude/agents/`, **same kebab-case slug** as
  the Codex variant in `<team>/codex/`.
- Frontmatter: `name`, `description`, `tools`, `model`, `color`. **Not supported in plugin
  agents:** `hooks`, `mcpServers`, `permissionMode` (Claude Code strips/ignores them).
- Keep the team theme (Hephaestus = Roman, Argus = Greek) and a **unique slug** within a team.
- Update the plugin's `README.md` roster and bump the version (see above).

## Artifact language

Every artifact the agents write to disk — docs, reports, plans, bug reports, checklists,
code, comments, test names, commit messages — is **100% English**, regardless of the
conversation language. The rule is baked into every agent prompt (`Artifact Language`
section). This repository's documentation follows the same rule.

<!-- Author: Grzegorz Holak -->
