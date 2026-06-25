# Argus QA Test Framework — Playwright + TS (API + UI)

Prepped scaffold for an **Argus QA engagement**. Copy into the target repo (or run standalone) and adapt to the app under test at engagement start. One command, one report, a real layered framework — not loose spec files.

## Why this stack
One tool covers **API** (`request` context) and **UI** (browser) → one runner, one report, built-in trace/screenshot/video for bug evidence. Playwright-native everything (fixtures, projects, storageState auth, html/json reporters). Fast to stand up, deterministic, AI-friendly.

## Run
```bash
./run-tests.sh                 # all projects (setup + api + regression + ui)
./run-tests.sh --project=api   # API only
npm run report                 # open the HTML report
npm run perf                   # optional light perf probe (PERF_TARGETS="/api/a,/api/b") — separate from run-tests.sh on purpose
```
Reports: `reports/html/` (humans) + `reports/results.json` (tooling). Both Playwright-native.

**Before the engagement:** walk `ai_agents_internal/PRE-EVENT-CHECKLIST.md` top to bottom (free ports, docker, browsers pre-downloaded, agents + skill installed).

The runner fail-fasts on a dead environment ("ENVIRONMENT NOT READY") and gates on `tsc --noEmit` — a suite that doesn't typecheck doesn't run (Playwright strips types without checking them).

**Visual regression** is pre-configured (`toHaveScreenshot`: 1% diff ratio, animations disabled): first run creates baselines, `--update-snapshots` refreshes them; baselines are render-environment-specific — never accept a diff without eyeballing it. **Browser matrix:** chromium-only by default; firefox/webkit/mobile project blocks sit commented in `playwright.config.ts` — enabling (or not) is a strategy decision to record.

## Solution documents (`solution/`)
| File | Owner | Answers |
|------|-------|---------|
| `TEST-STRATEGY.md` | Metis | WHAT we test, WHY, in what order — planning of tests, zero implementation detail |
| `ARCHITECTURE.md` | Talos (framework) + Metis (§1–2 digest) + Kleio (§10–11) | the reviewer-facing strategy+framework doc: what-we-test digest, key risks, stack & layers, How-we-used-AI, Summary — the agreed brief names THIS file as the strategy + run-summary deliverable |
| `IMPLEMENTATION-REPORT.md` | Kleio (at finalisation) | what was DELIVERED vs designed — honest reconciliation + residual risk |
| `TRACEABILITY.md` | Metis seeds → Talos fills → Kleio reconciles | matrix: RISK → why this path → implemented tests → defects found |
| `PERF-REPORT.md` | Hermes (optional) | perf probe: verdict vs a STATED budget, or light characterisation — p50/p97.5/p99, anomalies as candidate defects |

Plus `solution/BUG-LEDGER.md` (Minos — in `solution/` so `bugs/` stays strictly one-file-per-bug): ranked defect ledger + **Severity × Priority matrix** + detection-source split (automated suite vs agent exploratory/manual — each bug carries a `Detected by` field).

## Framework layout (layered — specs never touch raw config/auth)
```
src/config/env.ts        URLs, accounts, roles — single source of config
src/api/auth.ts          login + token cache, apiAs(role)
src/api/api-client.ts    resource-oriented clients (endpoint paths in ONE place)
src/api/schema.ts        expectMatchesSchema(body, '#/components/schemas/X') — OpenAPI as executable oracle
src/api/route-mocks.ts   failNext/delayNext/abortNext — page.route() fault injection for UI error states
src/fixtures/fixtures.ts custom fixtures (DI): apiAsUser/apiAsAdmin, page objects,
                         consoleGuard (auto: fails UI tests on console errors / 5xx responses),
                         createdResources (teardown cleanup when the app has no reset command)
src/pages/*.page.ts      Page Objects: getByRole/getByLabel locators + user-intent methods
src/data/factory.ts      unique, override-friendly test-data builders
src/perf/run-perf.mjs    light autocannon probe (`npm run perf`) — characterisation by default; a gate ONLY with PERF_BUDGET_MS (stated budgets, never invented)
tests/setup/auth.setup.ts  UI login ONCE → storageState (.auth/user.json)
tests/api/<resource>/    API/contract tests — one dir per OpenAPI tag (parallel writers)
tests/ui/<flow>/         few critical-path UI smokes (project starts authenticated)
tests/ui/a11y.smoke.spec.ts  axe-core WCAG 2.1 AA scan on critical pages (citable oracle)
tests/regression/        bug-linked tests (red = evidence) — see its README
bugs/_TEMPLATE.md        bug report template (replace with the target's verbatim; the _-prefixed file is not a bug report)
```

## Repo layout — deliverables vs internal
Top level is ONLY what the agreed brief requires (reviewer-facing): `README.md`, `solution/`, `bugs/`, `tests/`, `src/`, `run-tests.sh`, configs, final `RAPORT_LAST.html`. Our internal working artifacts — `campaign-state.json`, event-log, intermediate `RAPORT_RUN*.html`, `bug-ledger.json` (the evaluated ledger is `solution/BUG-LEDGER.md`), `PRE-EVENT-CHECKLIST.md`, coordination scratch — live in **`ai_agents_internal/`** so the root stays clean. Code paths NEVER move (breaks imports). See `ai_agents_internal/README.md`.
Dependency direction: specs → fixtures/pages/data → api → config. The **skeleton owner** builds `src/` first; parallel writers import it and never edit it.

## Configure for the app (at engagement start, from Kalchas's recon)
- **Ports/URLs:** env `API_URL` (3001), `UI_URL` (3000), `HELPER_URL` (3002). Defaults in `src/config/env.ts`.
- **Auth + accounts:** adapt `src/api/auth.ts` (login path, token field, header scheme), `tests/setup/auth.setup.ts` (UI login + success signal) and `env.ts` accounts to the real seeded roles.
- Replace the `ADAPT-ME` example specs, page object and factory with the real OpenAPI surface.

## Ground rules baked in
- **Never modify the app under test** — tests only.
- One command (`run-tests.sh`) + report. Determinism: `retries: 0`, no `sleep`, isolated unique data (factory), reset between runs.
- Verify the current Playwright API via context7 before heavy edits; `npm i -D @playwright/test@latest` if you want the newest.
