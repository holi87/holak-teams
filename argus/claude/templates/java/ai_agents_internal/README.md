# ai_agents_internal/

**Not a deliverable.** This folder holds the AI crew's internal working artifacts so the
repo root stays clean for the reviewers — top level is ONLY what the agreed brief requires.

## Pre-engagement checklist (the analog of the TS template's `PRE-EVENT-CHECKLIST.md`)

Walk this top to bottom before the engagement starts:

- [ ] **JDK 17+** on `PATH` (`java -version`) and **Maven 3.9+** (`mvn -version`).
- [ ] First `mvn` run is **online** so dependencies + the Playwright driver download; after
      that the local `~/.m2` cache makes runs offline-capable.
- [ ] **Playwright Chromium** pre-installed (`./run-tests.sh` does this, or run the
      `exec:java … install chromium` goal once). On Linux CI add OS deps.
- [ ] Target stack reachable on **`API_URL`** (default `http://localhost:3001`) and
      **`UI_URL`** (default `http://localhost:3000`) — the runner fail-fasts otherwise.
- [ ] Real seeded **accounts/roles** wired into `Config` (env: `ADMIN_USER`/`ADMIN_PASS`,
      `USER_USER`/`USER_PASS`).
- [ ] **OpenAPI doc** saved (default `./openapi.json` or `OPENAPI_PATH`) so the schema oracle
      runs instead of self-skipping.
- [ ] Decide which **gated lanes** to enable: `PERF_BUDGET_MS` (a STATED budget),
      `SECURITY_ENABLED=1` (target cleared for security checks), `DB_URL` (+ a JDBC driver
      added to `pom.xml`).
- [ ] Argus agents + skill installed; free ports / docker confirmed.

## What lives here (internal)

- `campaign-state.json` — orchestration phase/state (Odysseus)
- `event-log*` / intermediate run logs per wave
- `bug-ledger.json` — coverage-gate tooling input (the evaluated ledger is `solution/BUG-LEDGER.md`)
- this `PRE-EVENT-CHECKLIST` analog + crew coordination / doctrine scratch

## What stays at the top (deliverables — reviewer-facing)

`README.md` · `solution/` · `bugs/` (one file per bug + `_TEMPLATE.md`) ·
`src/test/java/qa/**` · `run-tests.sh` · `pom.xml` · `reports/summary.html`.

## Rule

Code paths NEVER move here (`src/`, `run-tests.sh`, `pom.xml`, configs) — moving them breaks
the build. Only documents and run-state. Kept tracked (not gitignored) in case a reviewer
wants to see the working.
