# Traceability Matrix — risk → tests → defects

> **Living artifact, three owners in sequence.** Metis SEEDS it from `TEST-STRATEGY.md` (risk + why + planned coverage), Talos FILLS the implemented-tests column as specs land, Atalanta/Minos LINK defects as bugs are confirmed, Kleio RECONCILES it at finalisation (statuses + gaps into `IMPLEMENTATION-REPORT.md`). One glance answers: WHY was this path tested, WHAT covers it, WHAT did it catch.

| RISK / REQ | Why this path (from strategy) | Planned coverage (level + kind) | Implemented tests (spec path / @tag) | Defects found (BUG-ID · severity) | Status |
|------------|-------------------------------|----------------------------------|--------------------------------------|-----------------------------------|--------|
| RISK-001 / REQ-### | <e.g. top L×I risk: broken access control on orders> | api: role-matrix checks on top endpoints | <tests/api/orders/authz.spec.ts @RISK-001> | <BUG-002 (Critical)> | covered, defect found |
| RISK-002 | <…> | <…> | — | — | PLANNED, NOT IMPLEMENTED — <reason> |
| (unplanned) | discovered during exploration, no strategy row | — | <spec or charter> | <BUG-005 (Major)> | unplanned finding |

## How to read it
- **Empty "Implemented tests" on a planned row** = an honest gap — Kleio carries it into `IMPLEMENTATION-REPORT.md` as residual risk; never delete the row to hide it.
- **A defect with no risk row** = unplanned finding — ADD a row marked `(unplanned)`; incidental finds must not silently inflate planned coverage.
- **Status vocabulary:** `covered, no defect` · `covered, defect found` · `partial — <what's missing>` · `PLANNED, NOT IMPLEMENTED — <reason>` · `unplanned finding`.
