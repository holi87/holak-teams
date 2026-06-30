# Argus QA Test Framework — pytest + Playwright + httpx (API + UI)

Prepped scaffold for an **Argus QA engagement** in Python. Copy into the target repo (or run standalone) and adapt to the app under test at engagement start. One command, one aggregated report, a real layered framework — not loose test files.

This is the Python sibling of the TypeScript template (`../framework-template/`): same doctrine, same lane layout, ported to pytest. **No Selenium — UI is Playwright only.**

## Why this stack
- **pytest** — one runner for every lane; lanes are just markers (`@pytest.mark.api/ui/perf/security/db/regression`), so `-m api` or `-m "ui or regression"` selects exactly what you want.
- **pytest-playwright + Playwright** — the UI lane. Browser fixtures, `storage_state` auth once per run, role/label locators, trace/screenshot/video evidence on failure. (No Selenium.)
- **httpx** — the API/contract lane. A small resource-oriented client keeps endpoint paths in ONE place.
- **jsonschema + referencing** — the OpenAPI/JSON-schema **oracle**: validate live responses against the spec instead of hand-rolled per-field asserts. Every mismatch is a contract-drift bug candidate.
- **pytest-html + pytest-json-report + JUnit XML** — one run, three aggregated reports: humans (HTML), tooling (JSON), CI (JUnit).
- **pytest-xdist** — optional parallelism, **off by default** (deterministic); set `WORKERS` to enable.

Determinism is a feature: **no retries, no rerun plugin**. Flakiness is fixed at the source, never hidden.

## Run
```bash
./run-tests.sh                      # every lane (api + ui + regression; perf/security/db self-skip unless gated)
./run-tests.sh -m api               # API lane only
./run-tests.sh -m "ui or regression"
PERF_BUDGET_MS=300 ./run-tests.sh -m perf      # enable the perf gate with a STATED budget
SECURITY_ENABLED=1 ./run-tests.sh -m security  # enable the security lane (target must be cleared)
DB_URL=postgres://… ./run-tests.sh -m db       # enable direct-DB integrity checks (read-only)
WORKERS=4 ./run-tests.sh            # opt-in parallelism
```
The first run creates a local `.venv`, installs `requirements.txt`, and pre-downloads the Chromium browser. The runner **fail-fasts on a dead environment** (`ENVIRONMENT NOT READY`) before any test runs.

`requirements.txt` pins version **floors** (lower bounds: `pytest>=8.2`, `playwright>=1.49,<2`, …), not exact versions — so two venvs built at different times can resolve different patch/minor releases. This is **not** byte-reproducible like the TS sibling's `npm ci` against a committed lockfile. For a reproducible install, freeze a lock once and install from it: `.venv/bin/python -m pip freeze > requirements.lock` (then `pip install -r requirements.lock`), or use `uv pip compile` / `uv.lock`. (Test-execution determinism — no retries, no rerun plugin — is separate and always holds.)

Reports after every run:
- `reports/html/index.html` — human report (self-contained).
- `reports/report.json` — machine-readable (tooling/aggregation).
- `reports/junit.xml` — CI ingestion.

Extra args pass straight through to pytest (`-k`, `-x`, `-m`, `--lf`, …). Exit code reflects pass/fail.

### Lane gating (perf / security / db)
The gated lanes **self-skip** unless their prerequisite env var is set, so an unset run shows them *skipped* (not failed) and the exit code stays `0`:

| Lane | Enable with | Unset behaviour |
|------|-------------|-----------------|
| `perf` | `PERF_BUDGET_MS=<ms>` (a STATED budget — never invent one) | skipped |
| `security` | `SECURITY_ENABLED=1` (target cleared for security checks) | skipped |
| `db` | `DB_URL=<dsn>` (direct DB access, **read-only**) | skipped |

## Framework layout (layered — tests never touch raw config/auth)
```
pyproject.toml             deps + pytest config: markers, addopts (reports), pythonpath
requirements.txt           dep mirror that run-tests.sh installs
run-tests.sh               single entry: venv + readiness gate + every lane + aggregated reports
conftest.py                root fixtures (DI): api_as(role), anon_client, created_resources,
                           storage_state (UI auth once per run), browser_context_args, console_guard
src/qa/config.py           URLs, accounts, roles — single source of config (from env)
src/qa/api_client.py       Endpoints (paths in ONE place) + login()/token cache + ResourceClient
src/qa/schema_oracle.py    SchemaOracle.assert_matches(body, '#/components/schemas/X') — OpenAPI as oracle
src/qa/pages/base_page.py  Page Object base: get_by_role/get_by_label, user-intent methods
src/qa/pages/login_page.py example Page Object (ADAPT-ME)
src/qa/data/factory.py     unique, override-friendly test-data builders
tests/setup/auth_setup.py  UI login once per run → storage_state (.auth/user.json, overwritten each run)
tests/api/                 API/contract tests (@pytest.mark.api) — one module per resource/tag
tests/ui/                  few critical-path UI smokes (@pytest.mark.ui); console_guard autouse here
tests/perf/                perf budget gate (@pytest.mark.perf, skipif PERF_BUDGET_MS unset)
tests/security/            access-control checks (@pytest.mark.security, skipif SECURITY_ENABLED unset)
tests/db/                  read-only DB integrity (@pytest.mark.db, skipif DB_URL unset)
tests/regression/          bug-linked RED tests (@pytest.mark.regression) — red = evidence; see its README
bugs/_TEMPLATE.md          bug report template (replace with the target's verbatim if it ships one)
solution/                  reviewer-facing deliverable docs (strategy, traceability, bug ledger…)
ai_agents_internal/        the AI crew's internal working artifacts (not a deliverable)
```
Dependency direction: tests → fixtures/pages/data → api_client → config. The **skeleton owner** builds `src/qa/` + `conftest.py` first; parallel writers import it and never edit it.

## Configure for the app (at engagement start, from Kalchas's recon)
- **Ports/URLs:** env `API_URL` (default `http://localhost:3001`), `UI_URL` (default `http://localhost:3000`), `HELPER_URL` (3002). Defaults live in `src/qa/config.py`.
- **Auth + accounts:** adapt `qa.api_client.login()` (login path/payload/token field, header scheme), `tests/setup/auth_setup.py` (UI login + success signal) and `config.py` accounts to the real seeded roles. Keep secrets in env (`ADMIN_USER/ADMIN_PASS/…`), not in source.
- **Endpoints:** edit `Endpoints` in `qa.api_client` — the single registry of paths.
- **Schema oracle:** set `OPENAPI_PATH` to the spec Kalchas found (JSON; convert YAML first), then assert `oracle.assert_matches(body, '#/components/schemas/X')`. The example contract test self-skips until the spec is present.
- Replace the `ADAPT-ME` example tests, page object and factory with the real OpenAPI/UI surface.

## Ground rules baked in
- **Never modify the app under test** — tests only.
- One command (`run-tests.sh`) + one aggregated report set. Exit code reflects pass/fail.
- **Determinism:** no retries, no rerun plugin, no `sleep`-to-pass; isolated unique data (factory), auth once per run via `storage_state` (re-authenticated and overwritten each run — never cached across runs), cleanup via `created_resources` when the app has no reset command.
- **No Selenium** anywhere — UI is Playwright only.
- Gated lanes self-skip on a missing prerequisite (never a false red).
- The OpenAPI/JSON schema is an **executable oracle**, not decoration.
- Verify the current Playwright / pytest API via context7 before heavy edits; bump versions in **both** `pyproject.toml` and `requirements.txt` together.
