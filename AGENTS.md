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

- Update with `/plugin marketplace update holak-teams`.
- Inside this repo, `.claude/settings.json` registers the marketplace (`autoUpdate: true`)
  and enables both plugins once the folder is trusted.
- **Hephaestus** — ask Marcus in a Claude Code session, for example
  `marcus, build a REST API for task management with tests and CI`.
- **Argus** — run the packaged `bin/argus-launch` from a terminal, not from inside a session:
  - `argus-launch doctor` checks the host first.
  - `argus-launch claude --target … --artifact-root … --mode <A|B|C|D> --engagement-id …`
    writes a short-lived request for the isolated runtime-attestation signer, then starts
    `/argus:run` with `--max-turns 96`, the frontier controller model, and the OS sandbox.
  - `--unattested` is an explicit opt-in for hosts without Ed25519 keys. It skips only the
    cryptographic attestation; every report names the engagement UNATTESTED.
  - A direct `/argus:run` or `claude --agent argus:odysseus` session fails preflight.
  - Full command sequence: **INSTALL.md** → "Start Argus". Every flag: `argus-launch --help`.
- Manual `--plugin-dir` installs and the Codex setup: **INSTALL.md**.

---

## Repository layout

- Plugin roots are `hephaestus/claude/` and `argus/claude/`. Only these ship to users.
  The `codex/` variants and Argus's maintainer sources stay outside them.
- The marketplace catalog is `.claude-plugin/marketplace.json`.
- `AGENTS.md` is the canonical doc and `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`;
  the Edit and Write tools refuse to write through the symlink.
- For the tree itself, use `ls`/`tree`.
- `argus/claude/` holds generated, hash-checked copies of the Argus runtime subset, so an
  installed plugin never reads outside its own directory.

### Agent files

- Keep agent files **flat** in `<plugin root>/agents/`. The slug is the file name without
  `.md` and must equal the frontmatter `name`.
- Claude Code itself now loads subfolders of `agents/` as `<plugin>:<subfolder>:<name>`.
  This repo forbids them anyway (`scripts/validate-marketplace-contracts.mjs`) so slugs stay
  `argus:<slug>` and `hephaestus:<slug>`.
- Frontmatter allowed by the gate: `name`, `description`, `tools`, `model`, `color`,
  `skills`, `effort`, `maxTurns`. Argus agents use all eight; Hephaestus agents use the
  first five.
- Claude Code also supports `disallowedTools`, `memory`, `background`, `omitClaudeMd`,
  `isolation`, and `experimental.cacheTtl`. To use one, extend `supportedFrontmatter` in
  the gate in the same commit.
- Claude Code ignores `hooks`, `mcpServers`, `permissionMode`, and `initialPrompt` in
  plugin agents. Put hooks in `<plugin root>/hooks/hooks.json`; only Argus has one.
- Keep the team theme (Hephaestus = Roman, Argus = Greek) and a unique slug per team.

### Source vs generated files

Never hand-edit a generated file. Edit its source, then regenerate:

| Source (edit this) | Regenerate | Generated (do not edit) |
|---|---|---|
| `argus/roles/<slug>.md`, `argus/roles/manifest.json` | `scripts/sync-argus-role-variants.mjs --write` | `argus/claude/agents/*`, `argus/codex/*` |
| Assets declared in `argus/runtime-assets.source.json` (`argus/bin/`, `argus/runtime/`, `argus/schemas/`, `argus/shared-skills/`, `argus/policies/`, contracts, templates) | `scripts/sync-argus-runtime-assets.mjs --write` | matching paths under `argus/claude/` (`bin/argus-launch`, `lib/`, `skills/qa-*`, `references/`, …) |
| `argus/raci.json` | `node scripts/sync-argus-raci.mjs --write` | `argus/RACI-CONTRACT.md`, roster block in `argus/README.md` |
| `argus/model-policy.json` | `node scripts/sync-argus-model-policy.mjs --write` | `argus/MODEL-POLICY.md` |
| `argus/technique-catalogs/*.json` | `node scripts/sync-argus-technique-bundle.mjs --write` | `argus/technique-catalogs.bundle.b64` |
| `hephaestus/claude/agents/<slug>.md` | `scripts/sync-hephaestus-codex-variants.mjs --write` | `hephaestus/codex/*` |

- Files edited in place under `argus/claude/`: `bin/argus-assets`, `bin/package.json`,
  `skills/run/SKILL.md`, `hooks/hooks.json`, `.claude-plugin/plugin.json`.
- Each sync script also accepts `--check`; the release gate runs every check.
- After an Argus runtime change, run the runtime-assets sync with `--write`, then `--check`.

---

## Argus maintainer rules

- **Budgets** (`argus/runtime-assets.source.json`): generated assets ≤ 880,000 bytes,
  installed plugin ≤ 1,800,000 bytes. Raise a budget only in a commit that names the growth.
  Prompt corpus budgets live in `argus/prompt-budgets.json`, enforced by
  `node scripts/check-argus-prompts.mjs`.
- **Profiles** — each specialist preloads exactly the profiles the capability matrix
  selects. `qa-core` is universal. `competition-profile` is packaged but never preloaded;
  it needs explicit user opt-in.
- **Technique catalogs** — Atalanta, Ariadne, Proteus, and Metis load hash-bound catalogs
  lazily after the surface inventory. Unknown or ambiguous `techniqueScopes` fall back to
  the complete catalog.
- **Models** (`argus/model-policy.json`) — 12 frontier roles use Claude `opus` / max effort
  (Codex `sol` / `xhigh`); 15 standard roles use `sonnet` / medium (Codex `terra` /
  medium). No complete role may use Haiku/Luna. Codex dispatch fails closed because the
  Codex CLI has no native hard turn cap.
- **Preflight** — writes control artifacts under `ai_agents_internal/` before any target
  probe. Each role gets `not-selected`, `ready`, `degraded`, `deferred`, `skipped`, or
  `blocked`; only `ready` and `degraded` roles are dispatchable.
- **Authorization** — unknown, staging, and production targets are read-only by default.
  All roles share one packaged redactor.
- **Target immutability** — the packaged `PreToolUse` hook blocks writes to the target and
  direct writes to canonical artifacts.
- **Finding quality (4.9.1)** — a new confirmed bug needs structured verification.
  `argus/runtime/finding-quality.mjs` reconciles confirmed bugs against their evidence at
  the canonical merge boundary. The discovery harness is `scripts/eval/discovery/`
  (maintainer-only; see its README). Background: RELEASE.md "Argus 4.9.1 finding-quality repair".
- **COLOR-SCHEME.md and team graphs** are maintainer-only; runtime values live in frontmatter.

### Where each contract lives

| Topic | Canonical doc |
|---|---|
| Model tiers, escalation, trust store, launch attestation, tokens | `argus/MODEL-POLICY.md` |
| Ownership, barriers, leases, checkpoints, cleanup, WCAG 2.2 AA default, `--unattested` | `argus/ENGAGEMENT-POLICY.md` |
| Authorization, audit, redaction | `argus/AUTHORIZATION-POLICY.md` |
| Browser lanes, managed profiles, device/viewport coverage | `argus/BROWSER-ISOLATION.md` |
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
- **Argus** — `argus/README.md` (27 agents: core + surface×mode hunter/automation/path-analyst
  lanes, plus resilience, consumer-driven contract, and test-suite-sanitation roles, leader
  `odysseus`).
- Codex mapping for both teams: Claude `opus` → `sol` + `xhigh`, `sonnet` → `terra` +
  `medium`, `haiku` → `luna` + `medium` (Hephaestus only).

---

## Versioning and releasing

Versions are **semver**:

- **patch** — wording or prompt tweaks, no behavioural change.
- **minor** — new agent or capability, backward-compatible.
- **major** — removed or renamed agent, or a breaking entry-point change.

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

Details and past release boundaries: **RELEASE.md**. To score an Argus run against a
private answer key: `make eval RUN=<engagement-root> ARGUS_ANSWER_KEY=<path outside repo>`.

---

## Adding or changing an agent

1. Edit the source file (see "Source vs generated files") and regenerate.
2. Update the plugin's `README.md` roster. For Argus, the roster comes from
   `argus/raci.json`.
3. Bump the version (see above) and run the gate.

## Artifact language

Every artifact the agents write to disk — docs, reports, plans, bug reports, checklists,
code, comments, test names, commit messages — is **100% English**, regardless of the
conversation language. Argus receives the rule from its universal `qa-core` profile;
Hephaestus keeps it inline. This repository's documentation follows the same rule.

<!-- Author: Grzegorz Holak -->
