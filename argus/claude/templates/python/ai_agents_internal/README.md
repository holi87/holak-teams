# ai_agents_internal/

**Not a deliverable.** This folder holds the AI crew's internal working
artifacts so the repo root stays clean for the reviewers — top level is ONLY what the
agreed brief requires.

## What lives here (internal)

- `campaign-state.json` — orchestration phase/state (Odysseus)
- `event-log*` / intermediate run logs — per-wave run trail
- `bug-ledger.json` — coverage-gate tooling input (the evaluated ledger is `solution/BUG-LEDGER.md`)
- `PRE-EVENT-CHECKLIST.md` — pre-engagement readiness checklist
- crew coordination / doctrine scratch

## What stays at the top (deliverables — reviewer-facing)

`README.md` · `solution/` (ARCHITECTURE, TEST-STRATEGY, IMPLEMENTATION-REPORT,
BUG-LEDGER.md, PERF-REPORT, TRACEABILITY) · `bugs/` (one file per bug + `_TEMPLATE.md`) ·
`tests/` · `src/` · `conftest.py` · `run-tests.sh` · `pyproject.toml` · final report.

## Rule

Code paths NEVER move here (`src/`, `tests/`, `conftest.py`, `run-tests.sh`, configs) —
moving them breaks imports. Only documents and run-state. The "how we used AI" evidence the
brief asks for is consolidated into `solution/ARCHITECTURE.md` §10; this folder is the raw
trail behind it, kept tracked (not gitignored) in case a reviewer wants to see the working.
