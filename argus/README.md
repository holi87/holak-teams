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

Marketplace installs are self-contained. The plugin ships:

- `${CLAUDE_PLUGIN_ROOT}/references/` — browser isolation, authorization, engagement coordination, and shared doctrine;
- `${CLAUDE_PLUGIN_ROOT}/capabilities/` — the mode-aware capability matrix for all 27 roles;
- `${CLAUDE_PLUGIN_ROOT}/policies/` + `lib/` — authorization/engagement templates, redaction patterns, guards, and atomic controllers;
- `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` — active `PreToolUse` target-immutability guard;
- `${CLAUDE_PLUGIN_ROOT}/schemas/` — runtime asset, bug-ledger, and browser-driver config schemas;
- `${CLAUDE_PLUGIN_ROOT}/templates/` — TypeScript/Playwright, Java, and Python framework templates;
- `argus-assets` — a PATH executable that verifies/copies assets, preflights, authorizes, guards writes, coordinates parallel state, and redacts evidence.

Maintainers edit the canonical sources under `argus/` and run
`scripts/sync-argus-runtime-assets.mjs --write`. Generated plugin copies are checked
byte-for-byte by `--check`; the generated prompt inventory covers all 27 agents. The
budget is 550 KB for generated runtime assets and 1.75 MB for the complete installed
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

Each selected worker receives a unique lease with deterministic browser profile, account,
namespace, port, temp, and output coordinates. Workers write immutable fragments;
canonical owners merge them in stable order under an atomic lock. The controller also
enforces discovery/hunting/automation/verification/reporting barriers, exclusive
reset/fault windows, atomic `BUG-NNNN` allocation, monotonic resumable checkpoints, and
idempotent success/failure cleanup. Full contract: `ENGAGEMENT-POLICY.md`; installed path:
`${CLAUDE_PLUGIN_ROOT}/references/ENGAGEMENT-POLICY.md`.

## Roster (`claude/` + `codex/`)

The Claude Code version lives in `claude/`. The Codex version lives in `codex/` as the same 27 agents with the same slugs and names, each as a `*.toml` + `*.md` pair. Codex model mapping: source roles `sonnet` use `terra` + `medium`, and source roles `opus` use `sol` + `xhigh`.

| Agent | Role |
|---|---|
| **odysseus** | orchestration policy / alternate main-session agent — picks the mode, dispatches the crew when `Agent` is available |
| kalchas | recon — maps the unknown stack, endpoints, roles, data |
| minos | bug triage / QA lead — severity, dedup, reconciliation |
| metis | test strategist — TEST-STRATEGY.md, coverage grid |
| kleio | QA reporter — README, IMPLEMENTATION-REPORT, acceptance |
| theseus | API test-path analyst — canonical baseline |
| pistis | consumer-driven contract analyst — Pact baseline (PIS-) |
| penelope | UI test-path analyst — user journeys baseline |
| atlas | automation architect — shared harness, run-tests.sh |
| **Hunters** | |
| atalanta | API / data-integrity (ATA-) |
| proteus | multi-protocol API — GraphQL / gRPC / WebSocket / async (PRO-) |
| orion | functional UI (ORI-) |
| lynceus | UI presentation / i18n / layout (LYN-) |
| ariadne | deep journeys + business-rule lifecycle (ARI-) |
| hermes | performance — structural oracles (HER-) |
| tyche | resilience / chaos — fault-injection oracles (TYC-) |
| perseus | security — STRIDE/OWASP (PER-) |
| antigone | accessibility — WCAG 2.1 AA (ANG-) |
| charon | database (gated, CHA-) |
| tiresias | white-box source analyst (gated, TIR-) |
| **Automation** | |
| talos | API regression (tests/api/) |
| daidalos | UI E2E + a11y auto (tests/ui/) |
| aegis | security regression (tests/security/) |
| nike | perf regression (tests/perf/) |
| mnemosyne | DB invariants (gated, tests/db/) |
| **Cross-cutting** | |
| aristarchus | code reviewer — runs LAST, BLOCKER/WARNING |
| asklepios | test-suite sanitation / deflaking — brownfield Mode D (ASK-) |

(In `odysseus.md`'s lane roster, `atlas`, `ariadne`, `aristarchus`, `tiresias` and `asklepios` form the **Cross** lane; the table above is a flattened by-function view.)

`codex/` — Codex variant of the roster (27 `*.toml` + `*.md` pairs). `framework-template/` (Playwright + TS), `framework-template-java/` (RestAssured + JUnit5 + Playwright-Java), `framework-template-python/` (pytest + Playwright + httpx) — project skeletons, all no-Selenium. `COLOR-SCHEME.md`, `SHARED-DOCTRINE.md`, `BROWSER-ISOLATION.md` — docs.
