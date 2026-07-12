# Defect Ledger — triaged and ranked

> **Canonical owner: Minos.** This is the normalised, deduplicated view of every filed bug in `bugs/`. Severity is impact; priority is fix order. The machine twin is `bug-ledger.json`.

## Ranked defects
| Rank | BUG-ID | Origin IDs | Title | Severity | Priority | Detected by | REQ/RISK | Status |
|------|--------|------------|-------|----------|----------|-------------|----------|--------|
| 1 | BUG-00N | `<PREFIX>-NNN` | <title> | Critical | P1 | automated / exploratory / recon | RISK-001 | Confirmed |

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
- <BUG-00N Critical/P4 — constrained reachability and business impact basis>

## Detection source split
| Source | Count | BUG-IDs |
|--------|-------|---------|
| automated suite | | |
| agent exploratory/manual | | |
| recon/other | | |

Counts: <N total> | Blocker x · Critical x · Major x · Minor x · Trivial x | duplicates merged: x | bounced back: x
