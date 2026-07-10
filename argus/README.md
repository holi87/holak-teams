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

## Roster (`claude/` + `codex/`)

The Claude Code version lives in `claude/`. The Codex version lives in `codex/` as the same 27 agents with the same slugs and names, each as a `*.toml` + `*.md` pair. Codex model mapping: source roles `sonnet` use `gpt-5.5` + `medium`, and source roles `opus` use `gpt-5.5` + `xhigh`.

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
