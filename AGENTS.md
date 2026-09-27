# holak-teams — Claude Code plugin marketplace

This repository **is a Claude Code plugin marketplace**. It ships two themed sub-agent
teams as installable plugins:

| Plugin | Theme | Agents | Entry point | Purpose |
|---|---|:--:|---|---|
| **hephaestus** | Roman names | 22 | `marcus` | Software delivery — goal → designed team → delivered increment |
| **argus** | Greek names | 27 | `argus-launch` | QA — black-box bug hunting + regression automation |

Both teams are **hub-and-spoke**: the entry point's main-thread controller decomposes the
work, dispatches specialists, and reports back. Specialists never talk to each other.

---

## Install and start

```
/plugin marketplace add holi87/holak-teams
/plugin install hephaestus@holak-teams
/plugin install argus@holak-teams
```

- Update with `/plugin marketplace update holak-teams`. Inside this repo, `.claude/settings.json`
  registers the marketplace (`autoUpdate: true`) and enables both plugins once trusted.
- **Hephaestus** — ask Marcus in a Claude Code session, for example
  `marcus, build a REST API for task management with tests and CI`.
- **Argus** — run the packaged `argus/claude/bin/argus-launch` from a terminal, not a session:
  - `argus-launch doctor [--browser]` checks the host first; `probe-browser` tests Chromium.
  - `argus-launch claude --target … --artifact-root … --mode <A|B|C|D> --engagement-id …`
    writes a short-lived request for the isolated runtime-attestation signer, then starts
    `/argus:run` with `--max-turns 400`, the frontier controller model, and the OS sandbox
    `os-native-target-readonly@3`.
  - Optional, unsigned host flags: `--provision-browser`, `--feature <capability-id>`,
    `--authorization <path>` or `--environment <local|test|staging|production>`, and
    `--usage-json <path>`. None widens what the authorization evaluator allows.
  - `--unattested` is an explicit opt-in for hosts without Ed25519 keys. It skips only the
    cryptographic attestation; every report names the engagement UNATTESTED.
  - A direct `/argus:run` or `claude --agent argus:odysseus` session fails preflight.
  - Full command sequence: **INSTALL.md** → "Start Argus". Every flag: `argus-launch --help`.
- Manual `--plugin-dir` installs and the Codex setup: **INSTALL.md**.

---

## Repository layout

- Plugin roots are `hephaestus/claude/` and `argus/claude/`. Only these ship to users.
  The Codex variants (`<team>/codex/`) and Argus's maintainer sources stay outside them.
- The marketplace catalog is `.claude-plugin/marketplace.json`. For the tree, use `ls`/`tree`.
- `AGENTS.md` is the canonical doc and `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`;
  the Edit and Write tools refuse to write through the symlink.
- `argus/claude/` holds generated, hash-checked copies of the Argus runtime subset.

### Agent files

- Keep agent files **flat** in `<plugin root>/agents/`. The slug is the file name without
  `.md` and must equal the frontmatter `name`.
- Claude Code loads `<plugin root>/agents/` subfolders as `<plugin>:<subfolder>:<name>`; this repo
  forbids them (`scripts/validate-marketplace-contracts.mjs`) so slugs stay `<plugin>:<slug>`.
- Frontmatter allowed by the gate: `name`, `description`, `tools`, `model`, `color`,
  `skills`, `effort`, `maxTurns`. Argus agents use all eight; Hephaestus agents use the
  first five. Any other field needs `supportedFrontmatter` extended in the gate first.
- Claude Code ignores `hooks`, `mcpServers`, `permissionMode`, and `initialPrompt` in
  plugin agents. Put hooks in `<plugin root>/hooks/hooks.json`; only Argus has one.
- Keep the team theme (Hephaestus = Roman, Argus = Greek) and a unique slug per team.

### Source vs generated files

Never hand-edit a generated file. Edit its source, then regenerate:

| Source (edit this) | Regenerate | Generated (do not edit) |
|---|---|---|
| `argus/roles/<slug>.md`, `argus/roles/manifest.json` | `scripts/sync-argus-role-variants.mjs --write` | `argus/claude/agents/*`, `argus/codex/*` |
| Assets declared in `argus/runtime-assets.source.json` (`argus/bin/`, `argus/runtime/`, `argus/schemas/`, `argus/shared-skills/`, `argus/policies/`, `argus/orchestration-plan.json`, contracts, templates) | `scripts/sync-argus-runtime-assets.mjs --write` | matching paths under `argus/claude/` (`argus/claude/bin/argus-launch`, `argus/claude/lib/`, `argus/claude/references/`, …) |
| `argus/framework-template-common/` (shared runner kit, gates, solution skeletons) | `scripts/sync-argus-runtime-assets.mjs --write` | the common files inside `argus/framework-template/`, `argus/framework-template-java/`, `argus/framework-template-python/`, and `argus/claude/templates/` |
| `argus/raci.json` | `node scripts/sync-argus-raci.mjs --write` | `argus/RACI-CONTRACT.md`, roster block in `argus/README.md` |
| `argus/model-policy.json` | `node scripts/sync-argus-model-policy.mjs --write` | `argus/MODEL-POLICY.md` |
| `argus/technique-catalogs/*.json` | `node scripts/sync-argus-technique-bundle.mjs --write` | `argus/technique-catalogs.bundle.b64` |
| `hephaestus/claude/agents/<slug>.md` | `scripts/sync-hephaestus-codex-variants.mjs --write` | `hephaestus/codex/*` |

- Edited in place, not generated: `argus/claude/bin/argus-assets`, `argus/claude/bin/package.json`,
  `argus/claude/skills/run/SKILL.md`, `argus/claude/hooks/hooks.json`, `argus/claude/.claude-plugin/plugin.json`.
- Each sync script also accepts `--check`; the release gate runs every check. A prompt or
  profile change also moves the corpus hash (see "Prompt budgets" below).

---

## Argus maintainer rules

- **Budgets** (`argus/runtime-assets.source.json`): generated assets ≤ 2,520,000 bytes,
  installed plugin ≤ 3,520,000 bytes. Raise a budget only in a commit that names the growth.
- **Prompt budgets** (`argus/prompt-budgets.json`, schema v2) — absolute corpus and
  per-agent ceilings plus an `approvedCorpus` SHA-256 over prompts and doctrine profiles,
  enforced by `node scripts/check-argus-prompts.mjs`. Restamp with
  `node scripts/approve-argus-prompts.mjs --approved-for <text> --write` plus `--benchmark
  <adjudication.json>` or `--benchmark-pending <reason>` (valid only for the named release).
- **Profiles** — specialists preload exactly the matrix-selected profiles; `qa-core` is
  universal. `competition-profile` is packaged but never preloaded; it needs user opt-in.
- **Technique catalogs** (`argus/technique-catalogs/`) — Antigone, Ariadne, Atalanta,
  Charon, Lynceus, Metis, Orion, Perseus, and Proteus load hash-bound catalogs lazily after
  the surface inventory; unknown or ambiguous `techniqueScopes` get the complete catalog.
  Register every catalog in `argus/capabilities/capability-matrix.json`.
- **Models** (`argus/model-policy.json`) — 27 frontier roles (Claude `opus` / max, Codex
  `sol` / `xhigh`), 0 standard; a standard role needs a justified `baseline.standardAllowlist`
  entry, and no complete role may use Haiku/Luna. Specialists get 80–200 turns; the
  controller gets 400, the last 30 reserved for canonical merges and Kleio. Frontier
  auto-continuation ships on. Codex dispatch fails closed: its CLI has no native turn cap.
- **Preflight** (report v3) — writes `<artifact-root>/ai_agents_internal/` before any
  target probe. Roles get `not-selected`, `ready`, `degraded`, `conditional`, `deferred`,
  `skipped`, or `blocked`. `ready`, `degraded`, and `conditional` are sealed; a
  `conditional` lane allocates only after `argus-assets engagement resolve-gates` proves its
  `pendingGates` once in discovery. Preflight is never rerun after the seal.
- **Essential lanes** (`argus/orchestration-plan.json`) — a blocked Odysseus, Kalchas,
  Metis, Minos, Kleio, Atlas (outside Mode B), or Mode A/B mandatory hunter stops the run.
  Any other blocked lane becomes `deferred` with `downgradedFrom=blocked` and a residual risk.
- **Authorization** — unknown, staging, and production targets are read-only by default;
  all roles share one packaged redactor.
- **Target immutability** — the packaged `PreToolUse` hook blocks writes to the target and
  direct writes to canonical artifacts. Classify every new in-engagement `argus-assets`
  verb in `classifyPackagedCommand` (`argus/runtime/engagement.mjs`); unknown verbs are denied.
- **`argus-assets` verbs** new in 5.0: `browser provision`, `authorization verify|install`,
  `engagement resolve-gates|report-facts|lane-outcomes`, controller batch forms,
  `automation-review digest|check`, `orchestration plan`, `copy-runner-kit`. See `argus/README.md`.
- **Discovery evaluation** (`scripts/eval/discovery/`, maintainer-only; see its README) —
  run, judge, spot-check, adjudicate, record a baseline. `gate.mjs --check` prints SKIP while
  `scripts/eval/discovery/baseline.json` is `not-recorded`. Make targets: `eval`, `eval-smoke`, `eval-gate`.
- **COLOR-SCHEME.md and team graphs** are maintainer-only; runtime values live in frontmatter.

### Where each contract lives

| Topic | Canonical doc |
|---|---|
| Model tiers, escalation, trust store, launch attestation, tokens | `argus/MODEL-POLICY.md` |
| Ownership, barriers, leases, checkpoints, cleanup, dispositions, gate resolution, browser runtime record, WCAG 2.2 AA default, `--unattested` | `argus/ENGAGEMENT-POLICY.md` |
| Authorization, launch-time manifest, audit, redaction | `argus/AUTHORIZATION-POLICY.md` |
| Browser lanes, managed profiles, hunt driver, device/viewport coverage | `argus/BROWSER-ISOLATION.md` |
| Schema registry, field and transition owners | `argus/CANONICAL-CONTRACTS.md` |
| Runner modes, outcome categories, exit codes | `argus/RUNNER-CONTRACT.md` |
| Framework detect / select / scaffold | `argus/TEMPLATE-CONTRACT.md` |
| Coverage observations and results | `argus/COVERAGE-CONTRACT.md` |
| Agent responsibilities and handoffs (`argus-assets raci route`) | `argus/RACI-CONTRACT.md` |
| Claude vs Codex generated-config parity | `AGENT-RUNTIME-PARITY.md` |
| Roster, `argus-assets` commands, lanes | `argus/README.md` |

---

## Rosters

- **Hephaestus** — `hephaestus/README.md` (22 agents: BA / dev / management / QA, leader `marcus`).
- **Argus** — `argus/README.md` (27 agents: core, surface×mode hunter/automation/path-analyst
  lanes, resilience, consumer contract, and suite sanitation; leader `odysseus`).
- Codex mapping for both teams: Claude `opus` → `sol` + `xhigh`, `sonnet` → `terra` +
  `medium`, `haiku` → `luna` + `medium` (Hephaestus only).

---

## Versioning and releasing

Versions are **semver**: **patch** — wording or prompt tweaks, no behavioural change;
**minor** — new agent or capability, backward-compatible; **major** — removed or renamed
agent, or a breaking entry-point change.

Release declarations:

- `<plugin root>/.claude-plugin/plugin.json` `version` decides the installed version. Users
  stay on the cached copy until this string changes.
- The plugin's entry `version` in `.claude-plugin/marketplace.json` must be equal;
  `claude plugin validate` warns on a mismatch.
- The top-level marketplace `version` equals the **highest** plugin version. A
  Hephaestus-only bump leaves it unchanged.

Release steps:

1. Regenerate every changed source (table above).
2. Bump all declarations atomically:
   `node scripts/release-plugin.mjs --plugin <hephaestus|argus> --bump <patch|minor|major> --write`.
3. Run the full gate: `make validate` (runs `scripts/validate-release.sh`, same as CI).
4. Run `git diff --check` and review generated changes.
5. Commit on a dedicated branch, push, open a pull request, and wait for every required check.

Details and past release boundaries: **RELEASE.md**. Score an Argus run against a private
answer key with `make eval RUN=<engagement-root> ARGUS_ANSWER_KEY=<path outside repo>`.

---

## Adding or changing an agent

1. Edit the source file (see "Source vs generated files") and regenerate.
2. Update the plugin's `README.md` roster. For Argus, the roster comes from `argus/raci.json`.
3. Bump the version (see above) and run the gate.

## Artifact language

Every artifact the agents write to disk — docs, reports, plans, bug reports, checklists,
code, comments, test names, commit messages — is **100% English**, regardless of the
conversation language. Argus receives the rule from its universal `qa-core` profile;
Hephaestus keeps it inline. This repository's documentation follows the same rule.

<!-- Author: Grzegorz Holak -->
