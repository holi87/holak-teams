# Test Strategy — <target>

> **Canonical owner: Metis.** Plan what gets tested, why, in what order, and against which oracle. Runtime implementation belongs in `ARCHITECTURE.md`; delivered-versus-designed reconciliation belongs in `IMPLEMENTATION-REPORT.md`.

## 1. Context and system under test
<Domain, surfaces, roles, entry points, contracts, data/reset capability, and constraints from Kalchas's inventory.>

## 2. Risk register
Rank likelihood × impact using target evidence rather than generic completeness.

| ID | Risk area | Likelihood | Impact | Priority | Target-specific basis |
|----|-----------|------------|--------|----------|-----------------------|
| RISK-001 | <authorisation / state / contract / UI risk> | H | H | P1 | <inventory or requirement evidence> |

## 3. Ordered coverage packages
| Order | Risk | Surface | Planned technique or checks | Oracle |
|-------|------|---------|-----------------------------|--------|
| 1 | RISK-001 | <surface> | <role matrix / boundary / transition / journey> | ORC-*-NNN |

## 4. Explicitly out of scope
Every exclusion needs a reason. No performance oracle means no invented pass/fail budget.

| Excluded scope | Reason | Residual risk |
|----------------|--------|---------------|

## 5. Oracles and test data
- Sources of truth: `<contracts, requirements, policies, observed invariants>`
- Accounts and roles: `<authorised engagement data only>`
- Data isolation: `<reset or unique-data strategy>`

## 6. Runtime and lane wiring
| Lane | Selected framework/adapter | Why | Top-level runner integration |
|------|----------------------------|-----|------------------------------|
| <lane> | <runtime-neutral name/version> | <target-specific rationale> | `./run-tests.sh` |

## 7. Time boxes and checkpoints
| Window | Goal | Cut rule |
|--------|------|----------|
| <window> | <risk package and evidence> | <lowest-value scope dropped first> |

## 8. Exit criteria
- Top risks have scoped outcomes and evidence, or named residual gaps.
- Every confirmed bug has a native `regression` test and `@bug:<canonical-or-origin>` provenance, unless a justified technical exception is named.
- One command emits the canonical runner result; expected RED evidence is never encoded green.
- Surface-derived coverage is reconciled; defect counts remain descriptive, not coverage proof.
