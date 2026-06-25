# Performance Report — <app name>

> **Owner: Hermes (Performance Probe).** Optional deliverable. Mode is decided by the oracle: a STATED budget → verdicts; no budget → characterisation only (distributions and comparisons — never an invented pass/fail threshold). Defects found here are filed by Atalanta in `bugs/`; this file records the measurement.

## 1. Mode & oracle
- **Mode:** BUDGET (source: <req §… / OpenAPI description / platform note>) | CHARACTERISATION (no stated budget — pass/fail performance listed as out-of-scope in `TEST-STRATEGY.md`).

## 2. Method & environment validity
- Tool: autocannon via `npm run perf` (<N> connections, <D>s per target, warmup pass discarded), raw JSON in `reports/perf/`.
- Targets: <endpoints + why these — from the risk register / endpoint map>.
- Environment: local docker stack (`docker compose up -d`), test machine. **Lab numbers** — valid for comparisons between endpoints on this machine, not as production SLO evidence.

## 3. Results
| Endpoint | p50 ms | p97.5 ms | p99 ms | err+non2xx | RPS |
|----------|--------|----------|--------|------------|-----|
| <path> | | | | | |

Frontend sample (optional, lab-only): <page → navigation/paint timings>.

## 4. Verdict / anomalies
- Budget mode: <PASS/FAIL per stated threshold, numbers quoted>.
- Characterisation: <anomalies — endpoint ≥10× sibling median, errors under light concurrency, growth with data volume — each with repro command>.

## 5. Candidate defects handed to Atalanta
| Finding | Evidence (numbers) | Repro command | Filed as |
|---------|--------------------|---------------|----------|
| <slow outlier / 5xx under light load> | <p97.5 vs sibling median> | <PERF_TARGETS=... npm run perf> | BUG-NNN / pending |

## 6. Residual & recommendations
- <what was NOT measured and why; recommended budget for the owner to adopt if none stated — a recommendation, not a self-imposed gate>.
