# Argus QA Test Framework — pytest + Playwright + httpx (API + UI)

Prepped scaffold for an **Argus QA engagement** in Python. Do not copy it directly. Run
`argus-assets template detect`, make an explicit `template select` choice, and use
`template scaffold` only for `action=build`. The adapter relocates test/harness roots to
the selected paths and records pip/venv as the verified environment adapter. uv, Poetry,
and unittest are explicit extension requirements; `action=adapt` preserves the target's
existing environment, runner, and layout. One command, one aggregated report, a real
layered framework — not loose test files.

This is the Python sibling of the TypeScript template (`../framework-template/`): same doctrine, same lane layout, ported to pytest. **No Selenium — UI is Playwright only.**

## Why this stack
- **pytest** — one runner for every lane; lanes are just markers (`@pytest.mark.api/ui/perf/security/db/resilience`), enabled or disabled by `solution/test-lanes.tsv`; a missing prerequisite fails visibly, never a silent skip.
- **pytest-playwright + Playwright** — the UI lane. Browser fixtures, `storage_state` auth once per run, role/label locators, trace/screenshot/video evidence on failure. (No Selenium.)
- **httpx** — the API/contract lane. A small resource-oriented client keeps endpoint paths in ONE place.
- **jsonschema + referencing** — the OpenAPI/JSON-schema **oracle**: validate live responses against the spec instead of hand-rolled per-field asserts. Every mismatch is a contract-drift bug candidate.
- **pytest-html + pytest-json-report + JUnit XML** — one run, three aggregated reports: humans (HTML), tooling (JSON), CI (JUnit).
- **pytest-xdist** — optional parallelism, **off by default** (deterministic); set `WORKERS` to enable.

Determinism is a feature: **no retries, no rerun plugin**. Flakiness is fixed at the source, never hidden.

## Run

Shared contract: four runner modes, `argus/runner-result@1`, outcome TSV, retained
redacted evidence under `reports/evidence/`, pytest lane/regression/contract-smoke markers,
zero reruns, and expiring `solution/quarantine.tsv` records. `pytest.mark.quarantine`
without one valid ledger row is a policy failure, not a silent skip.
```bash
API_URL=... UI_URL=... ./run-tests.sh --mode baseline   # strict green, excludes pytest.mark.regression
./run-tests.sh --mode defect-evidence      # known RED: live, repeat, and counterfactual passes
./run-tests.sh --mode candidate-regression # strict green over bug-linked tests
./run-tests.sh --mode full-suite           # the delivery gate: every enabled lane, no selectors
./run-tests.sh --mode baseline -- -k bad_credentials   # debugging narrow; full-suite refuses pytest args
WORKERS=4 ./run-tests.sh --mode full-suite # opt-in parallelism (pytest-xdist)
.venv/bin/python -m pytest -m api          # plain pytest run of one lane (no Argus contract)
```
`run-tests.sh` defines only the pytest hooks; the shared `scripts/runner-lib.sh` owns the
run. In order: template selection, the lane plan, the local `.venv` (created once from
`requirements.txt`, with the Chromium download unless `PLAYWRIGHT_INSTALL=0`), the compile
gate (`python -m compileall` over the test root, `conftest.py`, and the harness root — a
suite that doesn't compile doesn't run), readiness ("ENVIRONMENT NOT READY"), the
environment baseline, a collect-only inventory through the outcome adapter
(`reports/test-inventory.tsv`, `reports/expected-bugs.txt`, `reports/counterfactual-plan.tsv`),
the quarantine and inventory gates, the evidence passes, and
`reports/argus-runner-result.json`. Exit codes are 0 or 10-15 per `RUNNER-CONTRACT.md`,
never pytest's own. pytest arguments after `--` narrow a debugging run, but every test the
lane plan selects and the run leaves out is reported as not executed (exit 15), and
`full-suite` refuses them outright.

- **Lanes.** Each product lane (`api`, `ui`, `perf`, `security`, `db`, `resilience`) is a
  pytest marker. `solution/test-lanes.tsv` enables or disables each one with an owner, its
  prerequisite variables, and a reason; pytest selects only the enabled lanes (the marker
  expression `api or ui or …`), and `full-suite` refuses a lane still marked
  `not-yet-planned`. Tests never skip themselves on a missing prerequisite:
  `qa.argus.errors.require_env` reports it as `prerequisite-missing`.
- **Environment.** `solution/environment.tsv` declares a reset and a read-only verify
  script under `scripts/`. The reset runs only with `ARGUS_ENVIRONMENT_RESET=execute`
  (inside an engagement also with the destructive grant and the exclusive reset window);
  `full-suite` needs an executed reset or a passing verify.
- **Outcomes.** The Argus outcome adapter (`qa.argus_plugin`, loaded by the root conftest)
  turns every test into one seven-field event in `reports/outcomes.raw.tsv`; tests never
  write events by hand. Known RED is accepted only in `defect-evidence` and always fails the
  candidate and full-suite gates.
- **Evidence.** Each pass (`live`, `repeat`, `cf-correct`, `cf-tamper-<k>`) writes its
  reports to `reports/evidence/passes/<pass>/`: `html/index.html` (humans, self-contained),
  `report.json` (tooling), `junit.xml` (CI), and the Playwright artifacts in
  `test-results/` (`ARGUS_BROWSER_ARTIFACTS` replaces that directory inside an engagement).
  A plain pytest run still writes `reports/html/index.html`, `reports/report.json`, and
  `reports/junit.xml`.
- **Cleanup.** `created_resources` DELETEs what a test registered, newest first; a status
  outside 200/202/204/404 or an exception fails the test as `cleanup-failed`.
- **Resilience.** `fault_injector` (`qa.argus.fault_injector`) records the restore before
  injecting, always restores, and verifies the restore; a failed restore stops trusting the
  environment as an infrastructure failure. A server-side fault additionally needs
  `ARGUS_FAULT_INJECTION=authorized`; inside an Argus engagement it runs only through
  `./run-tests.sh`, which grants it after the chaos authorization and the exclusive fault window.

`requirements.txt` pins version **floors** (lower bounds: `pytest>=8.2`, `playwright>=1.49,<2`, …), not exact versions — so two venvs built at different times can resolve different patch/minor releases. This is **not** byte-reproducible like the TS sibling's `npm ci` against a committed lockfile. For a reproducible install, freeze a lock once and install from it: `.venv/bin/python -m pip freeze > requirements.lock` (then `pip install -r requirements.lock`), or use `uv pip compile` / `uv.lock`. (Test-execution determinism — no retries, no rerun plugin — is separate and always holds.)

Kleio completes `solution/ACCESSIBILITY-REPORT.md` from Antigone's manual checks and
Daidalos's automated results. It records the manifest's WCAG version/level/exception,
tools, limitations, risk-derived browser/device/viewport matrix, and privacy-safe evidence.

### Lanes (one directory per lane, selected by marker)

| Lane | Marker | Default in `solution/test-lanes.tsv` | Prerequisite |
|------|--------|--------------------------------------|--------------|
| api | `pytest.mark.api` | enabled | `API_URL` |
| ui | `pytest.mark.ui` | enabled (auth-once via storage_state) | `UI_URL` |
| perf | `pytest.mark.perf` | disabled, `not-yet-planned` | `PERF_BUDGET_MS` (a STATED budget — never invent one) |
| security | `pytest.mark.security` | disabled, `not-yet-planned` | `SECURITY_ENABLED=1` (target cleared for security checks) |
| db | `pytest.mark.db` | disabled, `not-yet-planned` | `DB_URL` (direct DB access, **read-only**) |
| resilience | `pytest.mark.resilience` | disabled, `not-yet-planned` | — (`ARGUS_FAULT_INJECTION=authorized` for server faults) |

Enabling or disabling a lane is a deliberate, recorded decision in
`solution/test-lanes.tsv`: a disabled lane carries a reason and is left out of the marker
selection, an enabled lane whose prerequisite variable is unset stops the run as a policy
denial before any test, and a test that still meets a missing prerequisite fails as
`prerequisite-missing`. `pytest.mark.regression` is not a lane: a regression carries it
next to its lane marker (see `tests/regression/README.md`).

## Framework layout (layered — tests never touch raw config/auth)
```
pyproject.toml             deps + pytest config: markers, addopts (reports), pythonpath
requirements.txt           dep mirror that run-tests.sh installs
run-tests.sh               ONE entry: pytest hooks for scripts/runner-lib.sh (venv + compile gate, inventory, per-lane runs, per-pass evidence)
scripts/runner-lib.sh      shared runner: lane plan, readiness, environment baseline, gates, evidence passes, result
conftest.py                root fixtures (DI): api_as(role), anon_client, created_resources, fault_injector,
                           storage_state (UI auth once per run), browser_context_args, console_guard
src/qa/config.py           URLs, accounts, roles — single source of config (from env)
src/qa/api_client.py       Endpoints (paths in ONE place) + login()/token cache + ResourceClient
src/qa/schema_oracle.py    SchemaOracle.assert_matches(body, '#/components/schemas/X') — OpenAPI as oracle
src/qa/oracles/            strict contract oracles (schema, REST status, idempotent replay)
src/qa/argus_plugin.py     Argus outcome adapter (pytest plugin): inventory + one event per test
src/qa/argus/              Argus runner kit: error classes + require_env, strict cleanup, fault_injector,
                           counterfactual stub
src/qa/pages/base_page.py  Page Object base: get_by_role/get_by_label, user-intent methods
src/qa/pages/login_page.py example Page Object (ADAPT-ME)
src/qa/data/factory.py     unique, override-friendly test-data builders
tests/setup/auth_setup.py  UI login once per run → storage_state (.auth/user.json, overwritten each run)
tests/api/                 API/contract tests (@pytest.mark.api) — one module per resource/tag
tests/ui/                  few critical-path UI smokes (@pytest.mark.ui); console_guard autouse here
tests/perf/                perf budget gate (@pytest.mark.perf) — requires a stated PERF_BUDGET_MS
tests/security/            access-control checks (@pytest.mark.security) — requires SECURITY_ENABLED=1
tests/db/                  read-only DB integrity (@pytest.mark.db) — requires DB_URL
tests/resilience/          UI error state under an injected API 503 (@pytest.mark.resilience, fault_injector)
tests/contract/            @pytest.mark.contract_smoke self-tests of the scaffold, the oracles and the runner kit
tests/regression/README.md README only: regressions live in their lane's directory with pytest.mark.regression + one bug marker
bugs/_TEMPLATE.md          bug report template (replace with the target's verbatim if it ships one)
solution/                  reviewer-facing deliverable docs (strategy, traceability, bug ledger, lane plan, environment…)
ai_agents_internal/        the AI crew's internal working artifacts (not a deliverable)
```
Dependency direction: tests → fixtures/pages/data → api_client → config. The **skeleton owner** builds `src/qa/` + `conftest.py` first; parallel writers import it and never edit it.

## Configure for the app (at engagement start, from Kalchas's recon)
- **Ports/URLs:** env `API_URL`, `UI_URL`, `HELPER_URL`. `src/qa/config.py` defaults (3001, 3000, 3002) serve plain pytest runs; `run-tests.sh` requires every enabled lane's prerequisites in `solution/test-lanes.tsv` (e.g. `API_URL`) to be set explicitly.
- **Lanes and baseline:** decide every row of `solution/test-lanes.tsv` and `solution/environment.tsv`; `not-yet-planned` blocks `full-suite`.
- **Auth + accounts:** adapt `qa.api_client.login()` (login path/payload/token field, header scheme), `tests/setup/auth_setup.py` (UI login + success signal) and `config.py` accounts to the real seeded roles. Keep secrets in env (`ADMIN_USER/ADMIN_PASS/…`), not in source.
- **Endpoints:** edit `Endpoints` in `qa.api_client` — the single registry of paths.
- **Schema oracle:** set `OPENAPI_PATH` to the spec Kalchas found (JSON; convert YAML first), then assert `oracle.assert_matches(body, '#/components/schemas/X')`. Without it the example contract test fails as `prerequisite-missing`; if the target publishes no spec, delete that test and record the residual risk.
- Replace the `ADAPT-ME` example tests, page object and factory with the real OpenAPI/UI surface.

## Ground rules baked in
- **Never modify the app under test** — tests only.
- One command (`run-tests.sh`) + one aggregated report set per evidence pass. Exit code reflects the contract outcome.
- **Determinism:** no retries, no rerun plugin, no `sleep`-to-pass; isolated unique data (factory), auth once per run via `storage_state` (re-authenticated and overwritten each run — never cached across runs), cleanup via `created_resources` when the app has no reset command.
- **No Selenium** anywhere — UI is Playwright only.
- Tests never skip themselves on a missing prerequisite: the lane plan decides what runs, and `require_env` reports what is missing.
- The OpenAPI/JSON schema is an **executable oracle**, not decoration.
- Verify the current Playwright / pytest API via context7 before heavy edits; bump versions in **both** `pyproject.toml` and `requirements.txt` together.
