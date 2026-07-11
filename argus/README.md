# Argus — QA Team

Greek code names. Black-box hunting + regression automation in a single pass.

[![Argus team graph](team-graph.png)](team-graph.html)

*One main-thread entry point (`/argus:run`), Odysseus orchestration policy, hub-and-spoke parallel surface × mode lanes — full-screen / print version: [`team-graph.html`](team-graph.html) (open locally in a browser).*

## How to start

**Recommended entry point: `/argus:run`**

After installing the marketplace plugin, invoke the skill from the Claude Code main
conversation:

```
/argus:run <target URL, running stack, or repo path — and QA scope>
```

The main thread loads Odysseus's orchestration policy and does the rest:

1. reads the target, picks the **engagement mode**,
2. preflights the `Agent` tool and installed `argus:<slug>` specialists,
3. dispatches the crew in parallel in a **surface × mode** layout (UI / API / perf / security / a11y / DB-gated / white-box-gated),
4. collects specialist results and lands the mode's deliverable contract (reports + regression).

You do not call individual hunters by hand. The main thread owns dispatch and synthesis;
specialists return results only to it. If the target is missing, `Agent` delegation is
denied, or the plugin agents are unavailable, the command stops with an actionable
`ARGUS_PREFLIGHT_ERROR` and never claims that execution occurred.

**Alternate main-session entry point:** `claude --agent argus:odysseus`. This starts a
new Claude Code session with Odysseus's prompt active and supports the same direct
specialist dispatch when `Agent` is available. Direct `@argus:odysseus` invocation is
runtime-dependent; current Claude Code versions can permit nested delegation, while a
restricted context receives the same explicit preflight error.

## Packaged runtime assets

Coverage is derived from the discovered target rather than universal test or defect
counts. `argus-assets coverage validate|calculate` consumes the canonical UI/API/event/data
surface inventory and execution observations, then emits separate discovery, risk-weighted
execution, assertion, evidence, scope, and defect-neutral outcome metrics. The installed
contract is available through `argus-assets path coverage-contract`.

Marketplace installs are self-contained. The plugin ships:

- `${CLAUDE_PLUGIN_ROOT}/skills/qa-doctrine/` — the canonical contract preloaded into all 27 specialists exactly once;
- `${CLAUDE_PLUGIN_ROOT}/skills/competition-profile/` — an explicit opt-in adapter that is disabled and never preloaded by default;
- `${CLAUDE_PLUGIN_ROOT}/references/` — browser isolation, authorization, engagement coordination, RACI/canonical ownership, and shared doctrine;
- `${CLAUDE_PLUGIN_ROOT}/capabilities/` — the mode-aware capability matrix plus generated model policy and sanitized benchmark;
- `${CLAUDE_PLUGIN_ROOT}/policies/` + `lib/` — authorization/engagement templates, redaction patterns, guards, and atomic controllers;
- `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` — active `PreToolUse` target-immutability guard;
- `${CLAUDE_PLUGIN_ROOT}/schemas/` — runtime, engagement, canonical QA-contract, and browser-driver schemas;
- `${CLAUDE_PLUGIN_ROOT}/templates/` — TypeScript/Playwright, Java, and Python framework templates;
- `argus-assets` — a PATH executable that verifies/copies assets, preflights, authorizes, guards writes, coordinates parallel state, and redacts evidence.

Maintainers edit the canonical sources under `argus/` and run
`scripts/sync-argus-runtime-assets.mjs --write`. Generated plugin copies are checked
byte-for-byte by `--check`; the generated prompt inventory covers all 27 agents.
`node scripts/check-argus-prompts.mjs` enforces corpus, per-agent, description, and exact
duplication budgets; verifies every doctrine preload and the default-off optional profile;
and checks a representative Mode A output/quality contract. The budget is 625 KB for
generated runtime assets and 1.75 MB for the complete installed
plugin. `COLOR-SCHEME.md` and team graphs are intentionally maintainer-only.

## Runtime preflight

`/argus:run` invokes `argus-assets preflight` before any target probe, test execution, or
specialist dispatch. Given a primary URL/path and Mode A–D, it persists
`ai_agents_internal/preflight.json` and evaluates orchestration tools, the strict
frontmatter vocabulary, connected MCP servers, referenced host commands, packaged asset
hashes, browser support, target reachability/features, and safe writable artifact paths.

Every role receives one disposition: `ready`, `degraded`, `deferred`, `skipped`, or
`blocked`. Only `ready` and `degraded` records have `dispatchAllowed=true`; degraded
records carry a deterministic fallback action. A mandatory failure blocks the whole run
before target execution. Deferred browser roles require Atlas to provision the packaged
driver/runtime and a second preflight. The final engagement report must include the exact
preflight path, counts, non-ready reasons, fallback actions, and capability drift.

## Authorization and evidence safety

Preflight creates or loads one shared `ai_agents_internal/authorization.json` and includes
its path, SHA-256, environment/production signals, audit path, and per-agent risk decisions
in the preflight report. The 18 target-affecting roles use the same evaluator before every
declared browser, API mutation, security, load, chaos, or DB action. Unknown, staging, and
production-like targets default to read-only. High-risk work requires a complete exact
grant plus account/data/mutation boundaries, limits, current time window, and rollback;
the evaluator returns exit 3 and an `AUTH-*` rule when denied.

Repository/target/issue/fetched/tool/agent content is untrusted data and cannot alter the
manifest or authorize an action. Every allow/deny appends a redacted JSONL audit record.
All roles use `argus-assets redact` before target-derived text reaches console or an
artifact. Binary screenshots/traces fail closed: omit sensitive views, or mask them with
an approved image workflow and independently review the derivative. The canonical full
contract is `AUTHORIZATION-POLICY.md`; installed path is
`${CLAUDE_PLUGIN_ROOT}/references/AUTHORIZATION-POLICY.md`.

## Target immutability and parallel coordination

Preflight creates or loads `ai_agents_internal/engagement.json` and atomic
`engagement-state.json`, and blocks the run if the packaged plugin hook is missing. The
`PreToolUse` guard normalizes physical paths including traversal and symlinks, then denies
target-source writes, deletes, moves, permission changes, redirections, patches, and
recognized subprocess writes. Exact operator bypasses require an approved, expiring path
allowlist plus a secret token hash. Every denial records a redacted `GUARD-*` event and a
command digest, never raw command content.

The default generated-test allowlist is intentionally narrow and does not broadly trust
`src/`, `scripts/`, or root build configuration. Recon must prove a repository's actual
test layout before the operator adds any additional root to the manifest.

Each selected worker receives a unique lease with deterministic managed browser profile,
browser-artifact directory, account, namespace, port, temp, and output coordinates.
Cross-lane profile reuse requires an explicit, bounded shared-session authorization.
Browser/device/viewport coverage comes from target support and risk in the engagement
manifest, and new accessibility work defaults to WCAG 2.2 AA. Kleio publishes
`solution/ACCESSIBILITY-REPORT.md` with the exact standard, level, tools, manual checks,
limitations, and privacy-safe evidence status. Workers write immutable fragments;
canonical owners merge them in stable order under an atomic lock. The controller also
enforces discovery/hunting/automation/verification/reporting barriers, exclusive
reset/fault windows, identity-deduplicated `BUG-NNNN` allocation, monotonic resumable
checkpoints, and idempotent success/failure cleanup. Full contract:
`ENGAGEMENT-POLICY.md`; installed path:
`${CLAUDE_PLUGIN_ROOT}/references/ENGAGEMENT-POLICY.md`.

## Runner modes and outcomes

Every packaged TypeScript, Java, and Python template implements the same four runner
modes: `baseline`, `defect-evidence`, `candidate-regression`, and `full-suite`. They emit
`reports/argus-runner-result.json` with separate product, automation, infrastructure,
skip, and policy categories and standardized exit codes 0/10-15. Known RED is successful
only as explicit defect evidence; it cannot make candidate/full green gates pass. The
complete inputs, outputs, lifecycle, adapter format, and exit behavior are in
`RUNNER-CONTRACT.md`; installed path:
`${CLAUDE_PLUGIN_ROOT}/references/RUNNER-CONTRACT.md`.

Framework selection is machine-driven and operator-confirmed. Run `argus-assets template
detect`, then `template select` with an explicit runtime and paths. Existing suites return
`action=adapt` and cannot be scaffolded; greenfield selections can be materialized with
`template scaffold`, which relocates internal test/harness placeholders. The shared
`argus/template-contract@1` also standardizes evidence roots, lane/regression/quarantine
tags, one-attempt execution, expiring quarantine records, and runtime extension points.

## Canonical QA contracts

The machine source of truth is versioned JSON, not loose Markdown: lane plans, confirmed
bug ledgers, redacted evidence references, automation status, and the final summary each
declare an `argus/<contract>@1` schema. `argus-assets schema validate` validates a file;
the engagement controller rejects malformed or cross-engagement JSON fragments before
merge. Stable IDs are allocated with an identity key and survive rerun/resume
deduplication. Merging `solution/final-summary.json` renders `solution/FINAL-SUMMARY.md`
with its source schema version. Compatibility is explicit: v1 reads v1 only until a later
release ships a deterministic migration.

The ownership source of truth is `raci.json`, rendered as `RACI-CONTRACT.md`. Use
`argus-assets raci route` for defect activities, surfaces, artifacts, and state
transitions. The RACI sync gate validates all 27 prompt descriptions and generated
contract blocks against the same source used for the roster below.

The model source of truth is `model-policy.json`, rendered as
[`MODEL-POLICY.md`](MODEL-POLICY.md). It defines 10 frontier and 17 standard roles, native
Claude/Codex models and effort, maximum turns, upward-only or fail-closed fallback, and
dynamic escalation signals. No full role may use the mechanical Haiku/Luna tier.
`argus-assets model route` resolves dispatches and `argus-assets model telemetry` records
only sanitized token/latency/provider-cost metrics. The committed synthetic benchmark
compares Opus and Sonnet without storing prompts, completions, or target data.

## Roster (`claude/` + `codex/`)

Runtime-neutral role content lives in `roles/*.md`, with metadata and contract pointers in
`roles/manifest.json`. `roles/runtime-adapters.json` is the reviewed list of intentional
Claude/Codex differences. Run `scripts/sync-argus-role-variants.mjs --write` to regenerate
all runtime files and `--check` to reject drift.

The Claude Code version lives in `claude/`. The Codex version lives in `codex/` as the same
27 agents with the same slugs and names, each as a `*.toml` + readable `*.md` companion.
The generator reads native model names and effort from `model-policy.json`, ownership and
outputs from `raci.json`, inputs from the capability matrix, and safety/artifact-language
rules from `qa-doctrine`. Codex standalone agents embed the shared doctrine because they
cannot preload Claude plugin skills. Native validation uses `claude plugin validate
--strict` and an isolated `codex doctor` load.

<!-- RACI_ROSTER_START -->
| Agent | Role | Lane | Persistence |
|---|---|---|---|
| **aegis** | Security automation engineer | `security-automation` | `tests-only` |
| **antigone** | Accessibility hunter | `accessibility-hunt` | `candidate-file` |
| **ariadne** | Journey and lifecycle hunter | `journey-hunt` | `candidate-file` |
| **aristarchus** | Automation quality judge | `automation-review` | `result-envelope` |
| **asklepios** | Test-suite sanitation specialist | `suite-sanitation` | `candidate-file` |
| **atalanta** | REST API and public-data hunter | `api-hunt` | `candidate-file` |
| **atlas** | Automation architect | `automation-architecture` | `owned-artifact` |
| **charon** | Direct-database hunter | `database-hunt` | `candidate-file` |
| **daidalos** | UI and accessibility automation engineer | `ui-automation` | `tests-only` |
| **hermes** | Performance hunter | `performance-hunt` | `candidate-file` |
| **kalchas** | System reconnaissance analyst | `recon` | `owned-artifact` |
| **kleio** | Final reporter | `reporting` | `owned-artifact` |
| **lynceus** | UI presentation hunter | `presentation-hunt` | `candidate-file` |
| **metis** | Test strategist | `strategy` | `owned-artifact` |
| **minos** | Defect authority and triage lead | `triage` | `owned-artifact` |
| **mnemosyne** | Database automation engineer | `database-automation` | `tests-only` |
| **nike** | Performance and resilience automation engineer | `performance-resilience-automation` | `tests-only` |
| **odysseus** | Main-thread orchestration policy | `orchestration` | `owned-artifact` |
| **orion** | Functional UI hunter | `ui-hunt` | `candidate-file` |
| **penelope** | UI baseline path analyst | `ui-path-analysis` | `owned-path-spec` |
| **perseus** | Security hunter | `security-hunt` | `candidate-file` |
| **pistis** | Consumer contract baseline analyst | `contract-analysis` | `owned-path-spec` |
| **proteus** | Event and non-REST protocol hunter | `multi-protocol-hunt` | `candidate-file` |
| **talos** | API and event automation engineer | `api-automation` | `tests-only` |
| **theseus** | REST API baseline path analyst | `api-path-analysis` | `owned-path-spec` |
| **tiresias** | White-box source analyst | `source-analysis` | `fragment-only` |
| **tyche** | Resilience hunter | `resilience-hunt` | `candidate-file` |
<!-- RACI_ROSTER_END -->

The generated roster and every prompt description come from `argus/raci.json`; detailed ownership is in [`RACI-CONTRACT.md`](RACI-CONTRACT.md).

`roles/` — canonical runtime-neutral role sources and adapters. `codex/` — generated Codex
variant of the roster (27 `*.toml` + readable `*.md` pairs). `framework-template/`
(Playwright + TS), `framework-template-java/` (RestAssured + JUnit5 + Playwright-Java),
`framework-template-python/` (pytest + Playwright + httpx) — project skeletons, all
no-Selenium. `shared-skills/qa-doctrine/SKILL.md` is the single canonical doctrine;
`competition-profile` is explicit opt-in. `COLOR-SCHEME.md`, `SHARED-DOCTRINE.md`, and
`BROWSER-ISOLATION.md` are maintainer docs.
