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
| Runner | **JUnit 5 (Jupiter)** | lanes via `@Tag`, enabled or disabled by `solution/test-lanes.tsv`; a missing prerequisite fails visibly, never a silent skip |
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
API_URL=... UI_URL=... ./run-tests.sh --mode baseline   # strict green, excludes @Tag("regression")
./run-tests.sh --mode defect-evidence      # known RED: live, repeat, and counterfactual passes
./run-tests.sh --mode candidate-regression # strict green over bug-linked tests
./run-tests.sh --mode full-suite           # the delivery gate: every enabled lane, no selectors
./run-tests.sh --mode baseline -- -Dtest=ExampleApiTest   # debugging narrow; full-suite refuses Maven args
mvn test -Papi                             # plain Maven run of one lane (no Argus contract)
open reports/summary.html                  # the human report
```

`run-tests.sh` defines only the Maven/JUnit hooks; the shared `scripts/runner-lib.sh` owns
the run. In order: template selection, the lane plan, `mvn test-compile` (a suite that
doesn't compile doesn't run — the Java analog of the TS typecheck gate) plus the optional
Playwright Chromium install when a browser lane is enabled (`PLAYWRIGHT_INSTALL=0` skips
it), readiness ("ENVIRONMENT NOT READY"), the environment baseline, a collect-only inventory
through JUnit Platform discovery (`reports/test-inventory.tsv`, `reports/expected-bugs.txt`,
`reports/counterfactual-plan.tsv`), the quarantine and inventory gates, the evidence
passes, and `reports/argus-runner-result.json`. Exit codes are 0 or 10-15 per
`RUNNER-CONTRACT.md`, never Maven's own. Maven arguments after `--` narrow a debugging run,
but every test the lane plan selects and the run leaves out is reported as not executed
(exit 15), and `full-suite` refuses them outright.

- **Lanes.** Each product lane (`api`, `ui`, `perf`, `security`, `db`, `resilience`) is a
  JUnit `@Tag`. `solution/test-lanes.tsv` enables or disables each one with an owner, its
  prerequisite variables, and a reason; Surefire selects only the enabled lanes (the tag
  expression `api | ui | …`), and `full-suite` refuses a lane still marked
  `not-yet-planned`. Tests never skip themselves on a missing prerequisite:
  `ArgusPrerequisiteError.requireEnv` reports it as `prerequisite-missing`.
- **Environment.** `solution/environment.tsv` declares a reset and a read-only verify
  script under `scripts/`. The reset runs only with `ARGUS_ENVIRONMENT_RESET=execute`
  (inside an engagement also with the destructive grant and the exclusive reset window);
  `full-suite` needs an executed reset or a passing verify.
- **Outcomes.** The Argus outcome adapter (`qa.support.argus.ArgusOutcomeListener`,
  registered next to `SummaryListener` through the JUnit Platform ServiceLoader) turns every
  test into one seven-field event in `reports/outcomes.raw.tsv`; tests never write events by
  hand. Known RED is accepted only in `defect-evidence` and always fails the candidate and
  full-suite gates.
- **Evidence.** Each pass (`live`, `repeat`, `cf-correct`, `cf-tamper-<k>`) keeps its
  `target/surefire-reports/` XML and `reports/summary.{json,html}` under
  `reports/evidence/passes/<pass>/`.
- **Cleanup.** `qa.support.CreatedResources` (`@ExtendWith` + a test parameter) DELETEs what
  a test registered, newest first; a status outside 200/202/204/404 or an exception fails
  the test as `cleanup-failed`.
- **Resilience.** `qa.support.argus.FaultInjector` records the restore before injecting,
  always restores, and verifies the restore; a failed restore stops the run as an
  infrastructure failure. A server-side fault additionally needs
  `ARGUS_FAULT_INJECTION=authorized`.

Reports: `target/surefire-reports/*.xml` (per class, CI-native) + `reports/summary.json`
(tooling) + `reports/summary.html` (humans). The aggregated summary is written in-process by
`qa.support.SummaryListener`, so it always matches the run Surefire just executed.

Kleio completes `solution/ACCESSIBILITY-REPORT.md` from Antigone's manual checks and
Daidalos's automated results. It records the manifest's WCAG version/level/exception,
tools, limitations, risk-derived browser/device/viewport matrix, and privacy-safe evidence.

**Before the engagement:** walk `ai_agents_internal/README.md` (the pre-engagement checklist
analog) top to bottom — JDK/Maven present, first run online so deps + the Playwright browser
download, stack up on the configured ports, accounts wired, OpenAPI doc saved.

## Framework layout (layered — tests never touch raw config/auth)

```
pom.xml                                  deps + Surefire (no rerun) + @Tag lane profiles
run-tests.sh                             ONE entry: Maven hooks for scripts/runner-lib.sh (compile gate, inventory, per-lane runs, per-pass evidence)
scripts/runner-lib.sh                    shared runner: lane plan, readiness, environment baseline, gates, evidence passes, result
src/test/resources/
  junit-platform.properties              determinism: parallel off, no retries, stable ordering
  META-INF/services/…TestExecutionListener  registers the aggregated-summary listener and the Argus outcome adapter
src/test/java/qa/
  support/Config.java                    URLs + accounts/roles — the SINGLE source of config
  support/ApiClient.java                 REST Assured request specs; endpoint paths in ONE place; apiAs(role) token helper
  support/SchemaOracle.java              OpenAPI component → JSON-schema matcher (executable oracle)
  support/PlaywrightFixture.java         JUnit extension: browser/context lifecycle + storageState auth-once + consoleGuard
  support/CreatedResources.java          JUnit extension: strict DELETE cleanup of what a test created
  support/DataFactory.java               unique, override-friendly builders (no shared records)
  support/SummaryListener.java           writes reports/summary.{json,html} on test-plan finish
  support/argus/                         Argus runner kit: outcome adapter, inventory, error classes + requireEnv,
                                         counterfactual stub, FaultInjector
  api/ExampleApiTest.java                @Tag("api") given/when/then + schema oracle (requires OPENAPI_PATH)
  ui/ExampleUiTest.java                  @Tag("ui") Playwright-Java, role/label locators (authenticated via storageState)
  perf/BudgetSmokeTest.java              @Tag("perf") — requires a stated PERF_BUDGET_MS
  security/AccessSmokeTest.java          @Tag("security") — requires SECURITY_ENABLED=1; role × operation DENY
  db/IntegritySmokeTest.java             @Tag("db") — requires DB_URL + a JDBC driver; read-only JDBC
  resilience/DegradationSmokeTest.java   @Tag("resilience") — UI error state under an injected API 503 (FaultInjector)
  contract/                              @Tag("contract-smoke") self-tests of the scaffold, the oracles and the runner kit
  regression/README.md                   README only: regressions live in their lane's package with @Tag("regression") + one bug tag
bugs/_TEMPLATE.md                        bug report template (replace with the target's verbatim if it ships one)
solution/                                reviewer-facing deliverables (strategy, architecture, ledger, lane plan, environment…) — stub
ai_agents_internal/                      internal working artifacts (not a deliverable) + pre-engagement checklist
```

Dependency direction: tests → `support/` (fixtures, api-client, oracle, factory) → `Config`.
The **skeleton owner** builds `support/` first; parallel writers import it and never edit it.

### Lanes (one package per lane, selected by `@Tag`)

| Lane | Tag | Default in `solution/test-lanes.tsv` | Prerequisite |
|---|---|---|---|
| api | `@Tag("api")` | enabled | `API_URL` |
| ui | `@Tag("ui")` | enabled (auth-once via storageState) | `UI_URL` |
| perf | `@Tag("perf")` | disabled, `not-yet-planned` | `PERF_BUDGET_MS` (a STATED budget) |
| security | `@Tag("security")` | disabled, `not-yet-planned` | `SECURITY_ENABLED=1` (target cleared) |
| db | `@Tag("db")` | disabled, `not-yet-planned` | `DB_URL` (+ a JDBC driver in `pom.xml`) |
| resilience | `@Tag("resilience")` | disabled, `not-yet-planned` | — (`ARGUS_FAULT_INJECTION=authorized` for server faults) |

Enabling or disabling a lane is a deliberate, recorded decision in
`solution/test-lanes.tsv`: a disabled lane carries a reason and is left out of the Surefire
selection, an enabled lane whose prerequisite variable is unset stops the run as a policy
denial before any test, and a test that still meets a missing prerequisite fails as
`prerequisite-missing`. `@Tag("regression")` is not a lane: a regression carries it next to
its lane tag.

## Configure for the app (at engagement start, from Kalchas's recon)

- **Ports/URLs:** env `API_URL`, `UI_URL`, `HELPER_URL`. `Config.java` defaults (3001, 3000,
  3002) serve plain `mvn test` runs; `run-tests.sh` requires every enabled lane's
  prerequisites in `solution/test-lanes.tsv` (e.g. `API_URL`) to be set explicitly.
- **Lanes and baseline:** decide every row of `solution/test-lanes.tsv` and
  `solution/environment.tsv`; `not-yet-planned` blocks `full-suite`.
- **Auth + accounts:** adapt `ApiClient.login()` (login path, token field, header scheme),
  `PlaywrightFixture.ensureStorageState()` (UI login selectors + success signal), and the
  account env vars (`ADMIN_USER`/`ADMIN_PASS`, `USER_USER`/`USER_PASS`).
- **Contract oracle:** save the OpenAPI doc and set `OPENAPI_PATH`; without it the
  schema-oracle test fails as `prerequisite-missing`. If the target publishes no spec, delete
  that test and record the residual risk.
- Replace the `ADAPT-ME` example tests, endpoint constants and the `OrderBuilder` with the
  real OpenAPI surface and data model.
- **DB lane:** add your JDBC driver to `pom.xml` (see the commented `postgres` profile) and
  set `DB_URL`; without a driver the read-only check fails as `prerequisite-missing`.

## Ground rules baked in

- **Never modify the app under test** — tests only. The DB lane forces `setReadOnly(true)`.
- One command (`run-tests.sh`) + one aggregated report. **Determinism:** Surefire
  `rerunFailingTestsCount=0`, parallel execution off, no `Thread.sleep` (use Awaitility),
  unique data via `DataFactory`, created data removed through `CreatedResources` when the
  app has no reset command.
- **No Selenium anywhere** — UI is Playwright only.
- Tests never skip themselves on a missing prerequisite: the lane plan decides what runs, and
  `ArgusPrerequisiteError.requireEnv` reports what is missing.
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
- **Route-mocks helpers.** The TS `src/api/route-mocks.ts` exposes `failNext` / `delayNext` /
  `abortNext` (via `page.route`) to force UI error/loading states. Here the resilience example
  drives `page.route` through `FaultInjector` with a verified restore. *Adapt-in:* a
  `support/RouteMocks` helper wrapping `page.route(urlGlob, route -> ...)` with
  `route.fulfill(...)` (5xx body), `route.abort(...)`, or a delayed `route.resume()` for more
  error and slow-network states.
- **Explicit Page-Object layer.** The example UI test inlines `getByRole` / `getByLabel`
  locators. The TS template factors these into `src/pages/*.page.ts`. Not built here. *Adapt-in:*
  a `qa.pages.LoginPage` (constructed with a `Page`, exposing intent methods like
  `login(user, pass)` plus the success/error locators) is the first object to extract once the
  real screens are known — `PlaywrightFixture.ensureStorageState()` would then drive it instead
  of inline selectors.

Bug↔regression coverage is not a reduction: the shared inventory gate
(`scripts/inventory-gate.sh`) requires every confirmed entry in `solution/bug-ledger.json` to
have an enabled, unquarantined `@Tag("regression")` test in an enabled lane whose single
`bug:` tag resolves to its canonical ID or origin, in every runtime.
