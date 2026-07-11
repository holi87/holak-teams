# Argus QA Test Framework — Java (REST Assured + Playwright)

Prepped scaffold for an **Argus QA engagement**, in Java. Do not copy it directly. Run
`argus-assets template detect`, make an explicit `template select` choice, and use
`template scaffold` only for `action=build`. The adapter relocates Java test/support roots
to the selected paths and records Maven as the verified build adapter. Gradle/TestNG are
explicit extension requirements; `action=adapt` preserves the target's existing build and
layout. Same doctrine and lane layout as the TypeScript template, ported to the JVM.
**No Selenium** — UI is Playwright only.

## Why this stack

| Concern | Choice | Why |
|---|---|---|
| Runner | **JUnit 5 (Jupiter)** | lanes via `@Tag`, gated lanes via `@EnabledIfEnvironmentVariable` (unset prerequisite = skipped, not failed) |
| API / contract | **REST Assured** | fluent given/when/then; the assertion vocabulary the whole industry reads |
| Contract oracle | **REST Assured `json-schema-validator`** | OpenAPI/JSON-schema as an *executable* oracle — every drift is a bug candidate, not a hand-rolled field check |
| UI | **Playwright for Java** (`com.microsoft.playwright`) | one modern browser-automation API, role/label locators, storageState auth-once, trace/screenshot/video for evidence — **no Selenium** |
| Async waits | **Awaitility** | readable polling for genuinely async conditions instead of `Thread.sleep` |
| Build / report | **Maven + Surefire** | Surefire XML per class (CI-native) + a small `reports/summary.{json,html}` digest |

One Maven module covers **API** and **UI** → one runner, one aggregated report. Deterministic
by construction: **no Surefire rerun, no retries** — flakiness is fixed at the source, never
hidden behind a retry.

## Run

Shared contract: four runner modes, `argus/runner-result@1`, outcome TSV, retained
redacted evidence under `reports/evidence/`, JUnit lane/regression/contract-smoke tags,
zero Surefire reruns, and expiring `solution/quarantine.tsv` records. `@Tag("quarantine")`
without one valid ledger row is a policy failure, not a silent skip.

```bash
./run-tests.sh --mode baseline          # strict green, excludes @Tag("regression")
./run-tests.sh --mode defect-evidence   # known RED only; requires adapter events
./run-tests.sh --mode candidate-regression # strict green over regression tag
./run-tests.sh --mode full-suite        # strict green over all selected tests
./run-tests.sh --mode baseline -- -Dgroups=api
./run-tests.sh -Papi                    # same, via a Maven profile
./run-tests.sh -Dtest=ExampleApiTest    # one class
PERF_BUDGET_MS=800 ./run-tests.sh       # enable the perf gate for this run
open reports/summary.html               # the human report
```

Reports: `target/surefire-reports/*.xml` (per class, CI-native) + `reports/summary.json`
(tooling) + `reports/summary.html` (humans). The aggregated summary is written in-process by
`qa.support.SummaryListener` (registered via the JUnit Platform ServiceLoader), so it always
matches the run Surefire just executed. The wrapper also writes
`reports/argus-runner-result.json`; outcome adapters append the shared seven-field TSV
events to `reports/outcomes.raw.tsv`. Exit codes are 0 or 10-15 per
`RUNNER-CONTRACT.md`, and known RED is successful only in `defect-evidence` mode.

Kleio completes `solution/ACCESSIBILITY-REPORT.md` from Antigone's manual checks and
Daidalos's automated results. It records the manifest's WCAG version/level/exception,
tools, limitations, risk-derived browser/device/viewport matrix, and privacy-safe evidence.
JUnit extensions/listeners record outcomes through `scripts/outcome-event.sh <case>
<category> <status> <expected> <lifecycle> <BUG-NNNN|-> <reason-token>`; parallel appends
are lock-safe.

**Before the engagement:** walk `ai_agents_internal/README.md` (the pre-engagement checklist
analog) top to bottom — JDK/Maven present, first run online so deps + the Playwright browser
download, stack up on the configured ports, accounts wired, OpenAPI doc saved.

The runner fail-fasts on a dead environment (`ENVIRONMENT NOT READY`) and gates on
`mvn test-compile` — a suite that doesn't compile doesn't run (the Java analog of the TS
typecheck gate).

## Framework layout (layered — tests never touch raw config/auth)

```
pom.xml                                  deps + Surefire (no rerun) + @Tag lane profiles
run-tests.sh                             ONE entry: compile gate → browser install → env readiness → mvn test → exit code
src/test/resources/
  junit-platform.properties              determinism: parallel off, no retries, stable ordering
  META-INF/services/…TestExecutionListener  registers the aggregated-summary listener
src/test/java/qa/
  support/Config.java                    URLs + accounts/roles — the SINGLE source of config
  support/ApiClient.java                 REST Assured request specs; endpoint paths in ONE place; apiAs(role) token helper
  support/SchemaOracle.java              OpenAPI component → JSON-schema matcher (executable oracle)
  support/PlaywrightFixture.java         JUnit extension: browser/context lifecycle + storageState auth-once
  support/DataFactory.java               unique, override-friendly builders (no shared records)
  support/SummaryListener.java           writes reports/summary.{json,html} on test-plan finish
  api/ExampleApiTest.java                @Tag("api") given/when/then + schema oracle
  ui/ExampleUiTest.java                  @Tag("ui") Playwright-Java, role/label locators (authenticated via storageState)
  perf/BudgetSmokeTest.java              @Tag("perf") + @EnabledIfEnvironmentVariable(PERF_BUDGET_MS)
  security/AccessSmokeTest.java          @Tag("security") + @EnabledIf…(SECURITY_ENABLED) — role × operation DENY
  db/IntegritySmokeTest.java             @Tag("db") + @EnabledIf…(DB_URL) — read-only JDBC
  regression/README.md                   bug-linked RED tests (red = evidence) — one per confirmed bug
bugs/_TEMPLATE.md                        bug report template (replace with the target's verbatim if it ships one)
solution/                                reviewer-facing deliverables (strategy, architecture, ledger…) — stub
ai_agents_internal/                      internal working artifacts (not a deliverable) + pre-engagement checklist
```

Dependency direction: tests → `support/` (fixtures, api-client, oracle, factory) → `Config`.
The **skeleton owner** builds `support/` first; parallel writers import it and never edit it.

### Lanes (one directory per lane, selected by `@Tag`)

| Lane | Tag | Gate | Unset behaviour |
|---|---|---|---|
| api | `@Tag("api")` | — | runs |
| ui | `@Tag("ui")` | — (auth-once via storageState) | runs |
| regression | `@Tag("regression")` | — | runs (bug-linked, RED on purpose) |
| perf | `@Tag("perf")` | `PERF_BUDGET_MS` | **skipped**, exit 0 |
| security | `@Tag("security")` | `SECURITY_ENABLED=1` | **skipped**, exit 0 |
| db | `@Tag("db")` | `DB_URL` (+ JDBC driver) | **skipped**, exit 0 |

Gated lanes use `@EnabledIfEnvironmentVariable`, so an unset run shows them *skipped* (not
failed) and the exit code stays 0 — enabling them is a deliberate, recorded decision.

## Configure for the app (at engagement start, from Kalchas's recon)

- **Ports/URLs:** env `API_URL` (3001), `UI_URL` (3000), `HELPER_URL` (3002). Defaults in
  `Config.java`.
- **Auth + accounts:** adapt `ApiClient.login()` (login path, token field, header scheme),
  `PlaywrightFixture.ensureStorageState()` (UI login selectors + success signal), and the
  account env vars (`ADMIN_USER`/`ADMIN_PASS`, `USER_USER`/`USER_PASS`).
- **Contract oracle:** save the OpenAPI doc to `./openapi.json` (or set `OPENAPI_PATH`); the
  schema-oracle test self-skips until it's present.
- Replace the `ADAPT-ME` example tests, endpoint constants and the `OrderBuilder` with the
  real OpenAPI surface and data model.
- **DB lane:** add your JDBC driver to `pom.xml` (see the commented `postgres` profile) and
  set `DB_URL`; the read-only check self-skips with a clear message until a driver is present.

## Ground rules baked in

- **Never modify the app under test** — tests only. The DB lane forces `setReadOnly(true)`.
- One command (`run-tests.sh`) + one aggregated report. **Determinism:** Surefire
  `rerunFailingTestsCount=0`, parallel execution off, no `Thread.sleep` (use Awaitility),
  unique data via `DataFactory`.
- **No Selenium anywhere** — UI is Playwright only.
- Gated lanes self-skip on an unset prerequisite (never a false red).
- Verify the current Playwright-Java / REST Assured API via context7 before heavy edits; bump
  the pinned versions in `pom.xml` when you want the newest.

## Parity with the TypeScript template — intentional scope notes

This JVM skeleton mirrors the TypeScript template's doctrine and lane layout. A few TS pieces
are **deliberately not built out here** — they are *adapt-in points* for an engagement, not
omissions to hide. The high-value `consoleGuard` (console-error + 5xx auto-guard on every UI
test) **is** ported, in `support/PlaywrightFixture` (`afterEach` fails the test on any
collected console error / 5xx). The deliberate reductions:

- **Accessibility (a11y) lane.** The TS template ships an axe-core/Playwright WCAG 2.2 AA smoke
  on critical pages. Not built here. *Adapt-in:* inject axe via Playwright-Java —
  `page.addScriptTag(new Page.AddScriptTagOptions().setUrl("https://unpkg.com/axe-core/axe.min.js"))`
  (or `.setPath(...)` for a vendored copy), then `page.evaluate("() => axe.run()")` and assert
  zero violations. A small `support/A11y` helper exercised by a `@Tag("a11y")` UI test is the
  natural shape.
- **Route-mocks fault injection.** The TS `src/api/route-mocks.ts` exposes `failNext` /
  `delayNext` / `abortNext` (via `page.route`) to force UI error/loading states. Not built here.
  *Adapt-in:* a `support/RouteMocks` helper wrapping `page.route(urlGlob, route -> ...)` with
  `route.fulfill(...)` (5xx body), `route.abort(...)`, or a delayed `route.resume()`, so UI
  smokes can deterministically assert the app's error and slow-network handling.
- **Explicit Page-Object layer.** The example UI test inlines `getByRole` / `getByLabel`
  locators. The TS template factors these into `src/pages/*.page.ts`. Not built here. *Adapt-in:*
  a `qa.pages.LoginPage` (constructed with a `Page`, exposing intent methods like
  `login(user, pass)` plus the success/error locators) is the first object to extract once the
  real screens are known — `PlaywrightFixture.ensureStorageState()` would then drive it instead
  of inline selectors.
- **Bug↔regression coverage gate.** The TS runner folds `scripts/bug-coverage.mjs` into its exit
  code to enforce that every confirmed `bugs/BUG-*` has a linked `@Tag("regression")` test. Not
  ported. *Maven equivalent:* a small script (or an `exec-maven-plugin` step) wired into
  `run-tests.sh` **before** `mvn test` — parse the `bugs/` files for `BUG-NNN` IDs, grep
  `src/test/java/qa/regression/` for each, and exit non-zero on any bug without a matching
  regression test, folding that exit code into the run.
