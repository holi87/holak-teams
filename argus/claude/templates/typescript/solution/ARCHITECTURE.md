# Solution Architecture — test strategy & framework

> **Primary owner: Talos (Test Automation Engineer); strategy digest: Metis; AI-use + Summary: Kleio.**
> The agreed brief names THIS file as the strategy deliverable ("what you test and why, risks, approach and technology, how you used AI") plus the run-documentation summary section. This file must therefore stand alone for a reviewer. Full planning detail lives in `TEST-STRATEGY.md`; delivered-vs-designed lives in `IMPLEMENTATION-REPORT.md` — link, don't duplicate.

> **Section ownership — edit ONLY your sections; never delete another owner's section or placeholder. Concurrent writers keep to disjoint sections; a genuine conflict is routed via Odysseus, never resolved by overwriting.**
> §1–2 **Metis** (strategy digest + risk register) · §3 Approach/stack — **Talos** (API-framework specifics) with **Atlas** (shared-harness + per-lane framework choice) · §4 Layers + §6 How-to-run — **Atlas** (owns the runner/aggregation) · §5, §7–9 conventions/extension/decisions/trace — **Talos** · §10 How-we-used-AI + §11 Summary — **Kleio** (finalisation).

## 1. What we test & why (owner: Metis)
<5–10 line digest of the strategy: domain in one sentence, the prioritised areas and the risk reasoning behind them. Full strategy: [`TEST-STRATEGY.md`](./TEST-STRATEGY.md).>

## 2. Key risks (owner: Metis)
Top of the risk register — full register with scoring in [`TEST-STRATEGY.md`](./TEST-STRATEGY.md) §2.

| ID | Risk | Priority | Covered by |
|----|------|----------|-----------|
| RISK-001 | <e.g. broken access control / IDOR> | P1 | `tests/api/...` @tags |

## 3. Approach, stack & rationale (owner: Talos)
Playwright + TypeScript, single tool for API (`request` context) and UI (browser): one runner, one report, built-in trace/screenshot/video as bug evidence. API-first + thin UI e2e smoke. <Adjust/justify per target app.>

## 4. Layers
```
src/config/    env.ts          — URLs, accounts, roles (single source of config)
src/api/       auth.ts         — login + token cache; apiAs(role)
               api-client.ts   — resource-oriented clients (endpoint paths in ONE place)
src/fixtures/  fixtures.ts     — custom test fixtures (DI): apiAsUser/apiAsAdmin, page objects
src/pages/     *.page.ts       — Page Objects (locators + user-intent methods, no assertions)
src/data/      factory.ts      — unique, override-friendly test-data builders
tests/setup/   auth.setup.ts   — UI login once → storageState (.auth/user.json)
tests/api|ui|regression/       — specs only: arrange via fixtures/factories, assert in the spec
scripts/       hunt-driver.mjs — isolated per-agent browser for EXPLORATORY hunting
               driver.config.json — app-specific config (gitignored; copy from .example)
```
Dependency direction: specs → fixtures/pages/data → api → config. Specs never call `request.newContext` or hardcode URLs/credentials.

## 5. Conventions
- One dir per API resource under `tests/api/<resource>/` — parallel writers never collide; the shared `src/` harness is owned by the skeleton owner.
- Tags: `@api`, `@ui`, `@regression BUG-NNN`. One regression test per confirmed bug, oracle cited.
- Locators: `getByRole`/`getByLabel`, never style-coupled CSS. Assertions live in specs, not page objects.
- Determinism: `retries: 0`, no sleeps, unique data per test (factory), state reset between runs.
- Reporting: Playwright-native — `list` + `html` (`reports/html/`) + `json` (`reports/results.json`).
- **Browser isolation (exploratory hunting):** hunters drive their OWN isolated browser via `scripts/hunt-driver.mjs` (`launchPersistentContext` per agent), NEVER the shared Playwright MCP browser — which clobbers `localStorage` sessions across concurrent agents and times out screenshots. The shared MCP `browser_*` is throwaway public-recon only. Locate the installed doctrine with `argus-assets path browser-isolation`. (Origin: Run-E recall collapse, ui 12% / i18n 0%.)

## 6. How to run
`./run-tests.sh` (everything) · `./run-tests.sh --project=api` · `npm run report`.

## 7. Extension points
- New resource: add `tests/api/<resource>/`, a `ResourceClient` instance (or subclass), a factory builder.
- New UI flow: add a Page Object in `src/pages/`, register it as a fixture, write the spec in `tests/ui/`.
- New role: add account to `src/config/env.ts`, add an `apiAs<Role>` fixture.

## 8. Design decisions & trade-offs (fill during the engagement)
| Decision | Alternatives considered | Why |
|----------|------------------------|-----|
| <e.g. storageState UI auth> | <per-test login> | <one login, faster + less flaky> |

## 9. Trace to strategy
| Strategy item (TEST-STRATEGY.md) | Architecture support |
|----------------------------------|----------------------|
| <RISK-001 role-matrix checks> | <apiAs(role) fixtures + ResourceClient> |

## 10. How we used AI (owner: Kleio, consolidated at finalisation; everyone captures continuously)
<Required. The delegate-vs-verify split: what was delegated to AI agents (recon, strategy drafting, automation, hunting, triage) vs what the human judged and corrected; concrete examples of where AI was wrong and how it was caught. Consolidated from the per-agent AI-collaboration log; also in [`TEST-STRATEGY.md`](./TEST-STRATEGY.md) §"How I used AI".>

## 11. Summary (owner: Kleio, finalisation — required by the agreed brief)
<Final state in ≤10 lines: suite size & shape (api/ui/regression counts), final `./run-tests.sh` result (pass/fail numbers, exit code), bug count by severity, where the reports live (`reports/html/`, `reports/results.json`), one-line residual risk. Full reconciliation: [`IMPLEMENTATION-REPORT.md`](./IMPLEMENTATION-REPORT.md).>
