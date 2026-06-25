# Defect Ledger — triaged & ranked

> **Owner: Minos (Bug Triage / QA Lead).** Normalised, deduplicated, ranked view of every bug in `bugs/`. Updated rolling, finalised before submission. Severity = impact, Priority = fix-order — never conflated.

## Ranked defects
| Rank | BUG-ID | Title | Severity | Priority | Detected by | REQ/RISK | Status |
|------|--------|-------|----------|----------|-------------|----------|--------|
| 1 | BUG-00N | <title> | Critical | P1 | automated suite / agent exploratory | RISK-001 | Confirmed |

## Severity × Priority matrix
Cells contain BUG-IDs. Off-diagonal cells (high severity + low priority, or the reverse) require a one-line justification below the table — they are evidence of deliberate triage, not an error.

|              | P1 | P2 | P3 | P4 |
|--------------|----|----|----|----|
| **Blocker**  |    |    |    |    |
| **Critical** |    |    |    |    |
| **Major**    |    |    |    |    |
| **Minor**    |    |    |    |    |
| **Trivial**  |    |    |    |    |

Off-diagonal justifications:
- <BUG-00N Critical/P4 — edge case reachable only via …, business impact low because …>

## Detection source split
| Source | Count | BUG-IDs |
|--------|-------|---------|
| automated suite (failing spec) | | |
| agent exploratory / manual | | |
| recon / other | | |

Counts: <N total> | Blocker x · Critical x · Major x · Minor x · Trivial x | duplicates merged: x | bounced back: x
