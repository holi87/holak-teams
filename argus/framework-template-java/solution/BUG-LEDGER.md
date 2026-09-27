# Defect Ledger — triaged and ranked

> **Canonical owner: Minos.** This is the normalised, deduplicated view of every filed bug in `bugs/`. Severity is impact; priority is fix order. The machine twin is `bug-ledger.json` (`argus/bug-ledger@2`): every filing keeps a row in its current status, and no row is ever deleted or re-pointed.

## Status summary
| Status | Count | BUG-IDs |
|--------|-------|---------|
| confirmed | | |
| suspected | | |
| **Headline (confirmed + suspected)** | | |
| needs-oracle | | |
| bounced (proof repair open) | | |
| quarantined (evidence integrity failed) | | |
| duplicate | | |
| rejected | | |

## Ranked defects
Confirmed and suspected rows only, in rank order.

| Rank | BUG-ID | Origin IDs | Title | Severity | Priority | Detected by | REQ/RISK | Status |
|------|--------|------------|-------|----------|----------|-------------|----------|--------|
| 1 | BUG-000N | `<PREFIX>-NNN` | <title> | Critical | P1 | automated / exploratory / recon | RISK-001 | confirmed |

## Severity × priority matrix
Cells contain canonical BUG-IDs. Justify every off-diagonal placement.

|              | P1 | P2 | P3 | P4 |
|--------------|----|----|----|----|
| **Blocker**  |    |    |    |    |
| **Critical** |    |    |    |    |
| **Major**    |    |    |    |    |
| **Minor**    |    |    |    |    |
| **Trivial**  |    |    |    |    |

Off-diagonal justifications:
- <BUG-000N Critical/P4 — constrained reachability and business impact basis>

## Likely, unproven
Every suspected and needs-oracle row, from its `missingProof`. Write `None.` when there are none.

| BUG-ID | Title | Status | Missing proof | What would confirm it | Owner |
|--------|-------|--------|---------------|-----------------------|-------|
| BUG-000N | <title> | suspected / needs-oracle | oracle / reproduction / independent-reproduction / evidence / environment-access / authorization | <missingProof.detail> | <lane> |

## Duplicates
| BUG-ID | Duplicate of | Origin IDs | Causal evidence (EVD-IDs per origin) |
|--------|--------------|------------|--------------------------------------|
| BUG-000N | BUG-000M | `<PREFIX>-NNN` | `<PREFIX>-NNN`: EVD-NNNN · BUG-000M: EVD-NNNN |

## Rejected
| BUG-ID | Origin IDs | Reason | Rationale | Evidence |
|--------|------------|--------|-----------|----------|
| BUG-000N | `<PREFIX>-NNN` | not-reproducible / oracle-contradicts / expected-behavior / out-of-scope / test-artifact / environment-fault / insufficient-evidence | <why this is not a defect> | EVD-NNNN (optional only for out-of-scope) |

## Detection source split
| Source | Count | BUG-IDs |
|--------|-------|---------|
| automated suite | | |
| agent exploratory/manual | | |
| recon/other | | |

Counts: headline <c + s> = confirmed c + suspected s | needs-oracle x · bounced x · quarantined x · duplicate x · rejected x | Blocker x · Critical x · Major x · Minor x · Trivial x
