# Traceability Matrix — risk to tests to defects

> **Canonical owner and merge authority: Kleio.** Metis submits risk/planning rows, automation engineers submit implemented-test rows, relevant hunters submit discovery rows, and Minos submits canonical defect links as immutable stable fragments through Odysseus. Only Kleio deterministically merges `solution/TRACEABILITY.md`; contributors never edit it directly.

| RISK / REQ | Why this path | Planned coverage | Implemented test ID/path and tag | Canonical defects | Status |
|------------|---------------|------------------|----------------------------------|-------------------|--------|
| RISK-001 / REQ-### | <target-specific L×I basis> | <surface and technique> | `<selected-test-root>/...` `@RISK-001` | BUG-0002 | covered, defect found |
| RISK-002 | <basis> | <package> | — | — | PLANNED, NOT IMPLEMENTED — <reason> |
| (unplanned) | discovered during exploration | — | <test or charter> | BUG-0005 | unplanned finding |

## Reconciliation rules
- A planned row without an implemented test is an honest gap carried into `IMPLEMENTATION-REPORT.md`.
- A canonical defect without a risk row gets an `(unplanned)` row; it does not inflate planned coverage.
- Use only: `covered, no defect`; `covered, defect found`; `partial — <gap>`; `PLANNED, NOT IMPLEMENTED — <reason>`; `unplanned finding`.
- Preserve fragment provenance in the engagement controller; the final document contains canonical IDs, not duplicate origin leads.
