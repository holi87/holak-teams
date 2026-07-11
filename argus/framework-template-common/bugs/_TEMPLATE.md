# <FILING-ID>: <concise title>

> PLACEHOLDER — at the start of an engagement, REPLACE this file with the target's own bug template verbatim if the repo ships one.
> FILING-ID = your per-hunter prefix + number (e.g. `ATA-007`, `ORI-003`, `LYN-012`, `PER-001`, `TIR-004`). One file per bug, collision-safe per agent. Minos assigns the canonical `BUG-NNNN` at final triage (recorded in Canonical-ID below); the lane is metadata, never the filename.

- **Severity:** Blocker | Critical | Major | Minor | Trivial   <!-- impact (consequence) -->
- **Priority:** P1 | P2 | P3 | P4   <!-- fix-order; first-pass draft, Minos sets authoritative at triage. Never a P-token in Severity. -->
- **Status:** Confirmed | Suspected
- **Canonical-ID:** <BUG-NNNN — Minos assigns at final triage; leave blank when filing>
- **Lane:** ui | api | perf | security | a11y | db   <!-- metadata; not the filename prefix -->
- **Detected by:** automated suite (spec path / @tag) | agent exploratory/manual (charter or probe) | recon
- **Component / Endpoint:** <path or screen>
- **Environment:** <build/commit, browser if UI, date>
- **Oracle-id:** <ORC-### from solution/ORACLES.md — the source of truth this violates; required for ACCEPTED. If none exists yet, request it from Metis, do not invent the rule.>
- **Links:** test native `regression` marker + `@bug:<canonical-or-origin>` provenance · REQ-### · RISK-###

## Preconditions
<state, account/role, data>

## Reproduction
```
<one copy-pasteable command for the selected runtime and target>
```
1. <step>
2. <step>

## Expected (oracle)
<what should happen — cite the Oracle-id above (contract operation / requirement clause / business rule it maps to)>

## Actual
<what happened — status code, response body, error>

## Evidence
<response snippet / screenshot / report link>

## Notes
<repeatability (x/y), business impact, workaround>
