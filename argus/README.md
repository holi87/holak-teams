# Argus — QA Team

Greek code names. Black-box hunting + regression automation in a single pass.

[![Argus team graph](team-graph.png)](team-graph.html)

*One entry point (`odysseus`), hub-and-spoke, parallel surface × mode lanes — full-screen / print version: [`team-graph.html`](team-graph.html) (open locally in a browser).*

## How to start

**Entry point = `odysseus`** (team leader, entry point).

You launch a single agent — `odysseus` — and it does the rest:

1. reads the target, picks the **engagement mode**,
2. dispatches the crew in parallel in a **surface × mode** layout (UI / API / perf / security / a11y / DB-gated / white-box-gated),
3. lands the mode's deliverable contract (reports + regression).

You don't call individual hunters by hand — everything goes through `odysseus`.

## Roster (`claude/` + `codex/`)

The Claude Code version lives in `claude/`. The Codex version lives in `codex/` as the same 27 agents with the same slugs and names, each as a `*.toml` + `*.md` pair. Codex model mapping: source roles `sonnet` use `gpt-5.5` + `medium`, and source roles `opus` use `gpt-5.5` + `xhigh`.

| Agent | Role |
|---|---|
| **odysseus** | leader / entry point — picks the mode, dispatches the crew |
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
| aristarchus | code reviewer — runs LAST, BLOCKER/WARNING |
| asklepios | test-suite sanitation / deflaking — brownfield Mode D (ASK-) |

`codex/` — Codex variant of the roster (27 `*.toml` + `*.md` pairs). `framework-template/` (Playwright + TS), `framework-template-java/` (RestAssured + JUnit5 + Playwright-Java), `framework-template-python/` (pytest + Playwright + httpx) — project skeletons, all no-Selenium. `COLOR-SCHEME.md`, `BROWSER-ISOLATION.md` — docs.
