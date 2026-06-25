# Test Strategy — <app name>

> **Owner: Metis (Test Strategist).** This document PLANS the testing: what gets tested, why, in what order, against which oracle. It contains NO implementation detail — how the framework is built lives in `ARCHITECTURE.md`; what actually got delivered lives in `IMPLEMENTATION-REPORT.md`.

## 1. Context & system under test
<2–4 sentences from Kalchas's recon: domain, stack (SPA + REST API + helper + DB), roles, where the spec/OpenAPI lives.>

## 2. Risk register (the heart of this document)
Score Likelihood × Impact (H/M/L), rank ruthlessly. Top risks earn the most coverage.

| ID | Risk area | L | I | Priority | Why it matters here |
|----|-----------|---|---|----------|---------------------|
| RISK-001 | <e.g. broken access control / IDOR (roles × endpoints)> | H | H | P1 | <reason from recon> |
| RISK-002 | <e.g. business-rule X violation (money/quantity math)> | | | | |
| RISK-003 | <e.g. contract drift: response ≠ OpenAPI schema> | | | | |

## 3. What we test, and in what order
Risk → planned coverage, in execution order. Each row is a work package someone can pick up.

| Order | Covers | Level (api/ui/regression) | Planned tests (kind, not code) | Oracle |
|-------|--------|---------------------------|--------------------------------|--------|
| 1 | RISK-001 | api | <role-matrix access checks on top endpoints> | OpenAPI + req §… |
| 2 | RISK-002 | api | <boundary + state-transition checks> | req §… |

## 4. Explicitly out of scope
Every exclusion gets a one-line reason. **No oracle → out of scope, never an invented threshold.**

| Excluded | Reason |
|----------|--------|
| <e.g. performance/load> | <no NFR stated — no oracle> |

## 5. Oracles & test data
- Where expected behaviour comes from: <OpenAPI spec path, requirements doc, business rules>.
- Test accounts/roles to use: <from recon — provided accounts ONLY>.
- Data isolation: <reset command between runs; unique generated data per test>.

## 6. Time-boxes & checkpoints
| Window | Goal | Cut rule |
|--------|------|----------|
| T+1.0–1.5h | <walking skeleton green + top-risk package started> | <what gets dropped first if late> |

## 7. Exit criteria (testing is "done" when…)
- <e.g. P1 risk packages executed; every confirmed bug has a linked regression test; suite runs clean via ./run-tests.sh>
- Found-vs-expected reconciliation done if a defect count is known or implied.
