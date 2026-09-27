# Argus QA Test Framework — Playwright + TS (API + UI)

Prepped scaffold for an **Argus QA engagement**. Do not copy it directly. Run
`argus-assets template detect`, make an explicit `template select` choice, then use
`template scaffold` only for `action=build`. The adapter relocates the internal `tests/`
and `src/` placeholders to the selected test/harness roots and records npm as the verified
build adapter. `action=adapt` preserves the target's existing layout and runner. One
command, one report, a real layered framework — not loose spec files.

## Why this stack
One tool covers **API** (`request` context) and **UI** (browser) → one runner, one report, built-in trace/screenshot/video for bug evidence. Playwright-native everything (fixtures, projects, storageState auth, html/json reporters). Fast to stand up, deterministic, AI-friendly.

## Run

Shared contract: four runner modes, `argus/runner-result@1`, outcome TSV, retained
redacted evidence under `reports/evidence/`, lane/regression/contract-smoke tags, zero
automatic retries, and expiring `solution/quarantine.tsv` records. `@quarantine` without
one valid ledger row is a policy failure, not a silent skip.
```bash
API_URL=... UI_URL=... ./run-tests.sh --mode baseline   # strict green, excludes @regression
./run-tests.sh --mode defect-evidence      # known RED: live, repeat, and counterfactual passes
./run-tests.sh --mode candidate-regression # strict green over bug-linked tests
./run-tests.sh --mode full-suite           # the delivery gate: every enabled lane, no selectors
./run-tests.sh --mode baseline -- --grep @smoke   # framework args narrow any mode except full-suite
npm run report                 # open the HTML report
npm run test:resilience        # plain Playwright run of one project (no Argus contract)
npm run perf                   # optional light perf probe (PERF_TARGETS="/api/a,/api/b") — separate from run-tests.sh on purpose
```
`run-tests.sh` defines only the Playwright hooks; the shared `scripts/runner-lib.sh` owns
the run. In order: template selection, the lane plan, `npm ci` + `tsc --noEmit` (a suite
that doesn't typecheck doesn't run), readiness ("ENVIRONMENT NOT READY"), the environment
baseline, a collect-only inventory (`reports/test-inventory.tsv`, `reports/test-case-ids.tsv`,
`reports/expected-bugs.txt`, `reports/counterfactual-plan.tsv`), the quarantine and inventory gates, the evidence
passes, the surface-coverage gate (`scripts/baseline-coverage.mjs`, baseline and full-suite),
and `reports/argus-runner-result.json` (`argus/runner-result@1`). Exit codes are 0
or 10-15 per `RUNNER-CONTRACT.md`, never Playwright's own.

- **Lanes.** Each product lane (`api`, `ui`, `perf`, `security`, `db`, `resilience`) is a
  Playwright project. `solution/test-lanes.tsv` enables or disables each one with an owner,
  its prerequisite variables, and a reason; only enabled lanes are selected
  (`--project=<lane>` plus its `<lane>-<variant>` browser/device projects, such as
  `ui-firefox`), and `full-suite` refuses a lane still marked `not-yet-planned`.
  Tests never skip themselves on a missing prerequisite: `requireEnv` reports it.
- **Environment.** `solution/environment.tsv` declares a reset and a read-only verify
  script under `scripts/`. The reset runs only with `ARGUS_ENVIRONMENT_RESET=execute`
  (inside an engagement also with the destructive grant and the exclusive reset window);
  `full-suite` needs an executed reset or a passing verify.
- **Outcomes.** The Argus outcome adapter (`scripts/argus-playwright-reporter.mjs`) turns
  every test into one seven-field event in `reports/outcomes.raw.tsv`; tests never write
  events by hand. Known RED is accepted only in `defect-evidence` and always fails the
  candidate and full-suite gates. `.only` never runs (`forbidOnly`), and the inventory gate
  reports it as a policy denial.
- **Evidence.** Each pass (`live`, `repeat`, `cf-correct`, `cf-tamper-<k>`) keeps its
  Playwright HTML report, `results.json`, and traces under `reports/evidence/passes/<pass>/`.
- **Resilience.** `faultInjector` (`src/argus/fault-injector.ts`) records the restore before
  injecting, always restores, and verifies the restore; a failed restore stops the run as an
  infrastructure failure. A server-side fault additionally needs
  `ARGUS_FAULT_INJECTION=authorized`.

**Before the engagement:** walk `ai_agents_internal/PRE-EVENT-CHECKLIST.md` top to bottom (free ports, docker, browsers pre-downloaded, agents + skill installed).

**Visual regression** is pre-configured (`toHaveScreenshot`: 1% diff ratio, animations disabled): first run creates baselines, `--update-snapshots` refreshes them; baselines are render-environment-specific — never accept a diff without eyeballing it. **Browser matrix:** the checked-in Chromium project is only a starter. Adapt the Playwright projects to every browser/device/viewport entry derived in `ai_agents_internal/engagement.json`, naming each one `<lane>-<variant>` so its lane's selection runs it; each omission is a named residual risk, never a fixed-quota decision.

## Solution documents (`solution/`)
| File | Owner | Answers |
|------|-------|---------|
| `TEST-STRATEGY.md` | Metis | WHAT we test, WHY, in what order — planning of tests, zero implementation detail |
| `ARCHITECTURE.md` | Atlas (canonical merge); contributor fragments from Metis, lane engineers, and Kleio | the reviewer-facing strategy+framework doc: what-we-test digest, key risks, stack & layers, How-we-used-AI, Summary — the agreed brief names THIS file as the strategy + run-summary deliverable |
| `IMPLEMENTATION-REPORT.md` | Kleio (at finalisation) | what was DELIVERED vs designed — honest reconciliation + residual risk |
| `ACCESSIBILITY-REPORT.md` | Kleio (from Antigone + Daidalos) | standard, level, tools, manual and automated checks, limitations, risk-derived browser matrix, and privacy-safe evidence |
| `TRACEABILITY.md` | Kleio (canonical merge of immutable contributor fragments) | matrix: RISK → why this path → implemented tests → defects found |
| `PERF-REPORT.md` | Hermes (optional) | perf probe: verdict vs a STATED budget, or light characterisation — p50/p97.5/p99, anomalies as candidate defects |

Plus `solution/BUG-LEDGER.md` (Minos — in `solution/` so `bugs/` stays strictly one-file-per-bug): ranked defect ledger + **Severity × Priority matrix** + detection-source split (automated suite vs agent exploratory/manual — each bug carries a `Detected by` field).

## Framework layout (layered — specs never touch raw config/auth)
```
src/config/env.ts        URLs, accounts, roles — single source of config
src/api/auth.ts          login + token cache, apiAs(role)
src/api/api-client.ts    resource-oriented clients (endpoint paths in ONE place)
src/api/schema.ts        expectMatchesSchema(body, '#/components/schemas/X') — OpenAPI as executable oracle
src/api/route-mocks.ts   failNext/delayNext/abortNext — page.route() fault injection for UI error states
src/fixtures/fixtures.ts custom fixtures (DI) on top of counterfactualTest: apiAsUser/apiAsAdmin, page objects,
                         consoleGuard (wraps `page`: fails UI tests on console errors / 5xx responses),
                         createdResources (strict teardown cleanup when the app has no reset command),
                         faultInjector (resilience faults with a verified restore)
src/argus/               Argus runner kit: error classes + requireEnv, counterfactual stub and its activation
                         (playwright-fixtures.ts counterfactualTest, api-url.ts), fault injector
src/pages/*.page.ts      Page Objects: getByRole/getByLabel locators + user-intent methods
src/data/factory.ts      unique, override-friendly test-data builders
src/perf/run-perf.mjs    light autocannon probe (`npm run perf`) — characterisation by default; a gate ONLY with PERF_BUDGET_MS (stated budgets, never invented)
tests/setup/auth.setup.ts  UI login ONCE → storageState (.auth/user.json)
tests/api/<resource>/    API/contract tests — one dir per OpenAPI tag (parallel writers)
tests/ui/<flow>/         few critical-path UI smokes (project starts authenticated)
tests/ui/a11y.smoke.spec.ts  axe-core WCAG 2.2 AA scan on critical pages (citable oracle)
tests/perf|security|db/  lane placeholders; enabled by solution/test-lanes.tsv, prerequisites via requireEnv
tests/resilience/        degradation under injected faults (faultInjector)
tests/contract/          contract-smoke self-tests of the scaffold and the oracles
tests/regression/        README only: regressions live in their lane's directory with @regression + one @bug
bugs/_TEMPLATE.md        bug report template (replace with the target's verbatim; the _-prefixed file is not a bug report)
```

## Repo layout — deliverables vs internal
Top level is ONLY what the agreed brief requires (reviewer-facing): `README.md`, `solution/`, `bugs/`, `tests/`, `src/`, `run-tests.sh`, configs, final `RAPORT_LAST.html`. The canonical machine ledger is `solution/bug-ledger.json`, next to the human `solution/BUG-LEDGER.md`. Internal working artifacts — campaign state, event log, intermediate `RAPORT_RUN*.html`, pre-event checklist, and coordination scratch — live in **`ai_agents_internal/`** so the root stays clean. Code paths NEVER move (breaks imports). See `ai_agents_internal/README.md`.
Dependency direction: specs → fixtures/pages/data → api → config. The **skeleton owner** builds `src/` first; parallel writers import it and never edit it.

## Configure for the app (at engagement start, from Kalchas's recon)
- **Ports/URLs:** env `API_URL` (3001), `UI_URL` (3000), `HELPER_URL` (3002). Defaults in `src/config/env.ts` serve plain Playwright runs; `run-tests.sh` requires every enabled lane's prerequisites in `solution/test-lanes.tsv` (e.g. `API_URL`) to be set explicitly.
- **Lanes and baseline:** decide every row of `solution/test-lanes.tsv` and `solution/environment.tsv`; `not-yet-planned` blocks `full-suite`.
- **Auth + accounts:** adapt `src/api/auth.ts` (login path, token field, header scheme), `tests/setup/auth.setup.ts` (UI login + success signal) and `env.ts` accounts to the real seeded roles.
- Replace the `ADAPT-ME` example specs, page object and factory with the real OpenAPI surface.

## Ground rules baked in
- **Never modify the app under test** — tests only.
- One command (`run-tests.sh`) + report. Determinism: `retries: 0`, no `sleep`, isolated unique data (factory), reset between runs.
- Verify the current Playwright API via context7 before heavy edits; `npm i -D @playwright/test@latest` if you want the newest.
