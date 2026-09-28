# Solution Architecture — test strategy & framework

> **Canonical owner and merge authority: Atlas (Automation Architect).**
> The agreed brief names THIS file as the strategy deliverable ("what you test and why, risks, approach and technology, how you used AI") plus the run-documentation summary section. This file must therefore stand alone for a reviewer. Full planning detail lives in `TEST-STRATEGY.md`; delivered-vs-designed lives in `IMPLEMENTATION-REPORT.md` — link, don't duplicate.

> **Single-writer rule.** Contributors submit stable immutable fragments through Odysseus; only Atlas runs the deterministic canonical merge. Fragment sources: §1–2 Metis · §3 Talos/Atlas · §4 and §6 Atlas · §5 and §7–9 Talos · §10–11 Kleio.

## 1. What we test & why (owner: Metis)
<5–10 line digest of the strategy: domain in one sentence, the prioritised areas and the risk reasoning behind them. Full strategy: [`TEST-STRATEGY.md`](./TEST-STRATEGY.md).>

## 2. Key risks (owner: Metis)
Top of the risk register — full register with scoring in [`TEST-STRATEGY.md`](./TEST-STRATEGY.md) §2.

| ID | Risk | Priority | Covered by |
|----|------|----------|-----------|
| RISK-001 | <e.g. broken access control / IDOR> | P1 | `tests/api/...` @tags |

## 3. Approach, stack & rationale (owner: Talos)
Playwright + TypeScript, single tool for API (`request` context) and UI (browser): one runner, one report, built-in trace/screenshot/video as bug evidence. API-first plus a funded, risk-derived UI lane covering each primary screen's validation, client state, visual baseline, and accessibility matrix. <Adjust and justify per target app.>

## 4. Layers
Coverage denominators live in `solution/surface-inventory.json`; execution, assertion,
and evidence observations live in `solution/coverage-observations.json`. Do not use
universal case-count or defect-count targets.

```
src/config/    env.ts          — URLs, accounts, roles (single source of config)
src/api/       auth.ts         — login + token cache; apiAs(role)
               api-client.ts   — resource-oriented clients (endpoint paths in ONE place)
src/fixtures/  fixtures.ts     — custom test fixtures (DI): apiAsUser/apiAsAdmin, page objects
src/pages/     *.page.ts       — Page Objects (locators + user-intent methods, no assertions)
src/data/      factory.ts      — unique, override-friendly test-data builders
src/oracles/   index.ts        — the shared oracle library (see "Oracle library" below)
tests/setup/   auth.setup.ts   — UI login once → storageState (.auth/user.json)
tests/api|ui|regression/       — specs only: arrange via fixtures/factories, assert in the spec
scripts/       hunt-driver.mjs — isolated per-agent browser for EXPLORATORY hunting
               driver.config.json — app-specific config (gitignored; copy from .example)
```
Dependency direction: specs → fixtures/pages/data → api → config. Specs never call `request.newContext` or hardcode URLs/credentials.

### Oracle library
Every spec imports its oracles from `src/oracles` (`src/oracles/index.ts`); no lane re-implements one. A RED is a Playwright `expect` failure (a product failure); a misuse throws `TypeError` (an automation failure). The contract-smoke self-tests (`tests/contract/oracles-*.selftest.spec.ts`) prove each helper GREEN on a correct stub and RED on a faulty one.

| # | Helper | Module | Oracle |
|---|--------|--------|--------|
| 1 | `assertSchema(res, operationId)` | `src/oracles/schema.ts` | the body matches the schema documented for that status; strict by default, so an undocumented field is RED |
| 2 | `assertSchemaStrict(body, ref)` | `src/oracles/schema.ts` | a body matches a component schema with strict mode forced |
| 3 | `expectStatus(res, exact)` | `src/oracles/http.ts` | one exact documented status code, never a class |
| 4 | `idempotentReplay` / `replayWithIdempotencyKey` + `assertRestStatus(res, state)` | `src/oracles/replay.ts`, `src/oracles/http.ts` | a replay preserves the independently read state (response equality is contract opt-in), and one idempotency key makes one effect; the REST-correct code per state (201 + Location, 204 empty, 405 + Allow) |
| 5 | `softDeleteSweep` | `src/oracles/state.ts` | after the delete: 404 by id, absent from every list, and a deleted user's login answers 401 |
| 6 | `doubleSubmit` | `src/oracles/concurrency.ts` | two simultaneous submits make exactly the contracted number of effects |
| 7 | `concurrentRace` | `src/oracles/concurrency.ts` | N simultaneous contenders: no 5xx, successes within capacity, the invariant holds |
| 8 | `i18nCharset` | `src/oracles/i18n.ts` | stored text round-trips code point for code point; a length limit counts characters, not bytes |
| 9 | `IDENTITY_VECTORS` + `credentialConsistency` + `validEmail` / `invalidEmails` + `caseVariants` | `src/oracles/identity.ts` | the canonical identity vectors; register and login agree byte for byte |
| 10 | `visualBounds(locator)` (pure rules: `evaluateBounds`) | `src/oracles/visual.ts` | at 375 px the element is not off-screen, not overflowing its box, and not covered |
| 11 | `n1Scaling` (pure analysis: `analyzeScaling`) | `src/oracles/scaling.ts` | read time and payload grow sub-linearly with the collection size (N+1, over-fetch) |
| 12 | `boundary3` + `moneyReconciles` + `percentagesSumTo100` | `src/oracles/boundary.ts` | B - step, B, B + step with the domain's smallest unit; exact minor-unit sums; exactly 100% |
| 13 | `invalidPartitions` / `invalidObjectPartitions` | `src/oracles/partitions.ts` | one invalid value per declared constraint, each rejected with the documented code |
| 14 | `paginateAll` + `assertCollectionConservation` | `src/oracles/pagination.ts` | two walks at a small page size: no duplicate, no gap, and the total matches |

`src/oracles/openapi.ts` loads and normalizes the `OPENAPI_PATH` document for the schema oracles. The ADAPT-ME examples in `tests/api/`, `tests/ui/`, and `tests/perf/` show each lane's use.

## 5. Conventions
- One dir per API resource under `tests/api/<resource>/` — parallel writers never collide; the shared `src/` harness is owned by the skeleton owner.
- Tags: `@api`, `@ui`, native `@regression` selection, and `@bug:<canonical-or-origin>` provenance. One regression test per confirmed bug, oracle cited; `@bug` never selects a runner mode by itself.
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
