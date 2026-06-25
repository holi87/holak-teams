# ORACLES — single source of expected behaviour

> The truth backbone of the run. Every accepted bug cites an `ORC-` id from here; every automated assertion encodes one. A finding with no oracle is an opinion, not a defect.
>
> **Owner:** Metis (consolidates). **Seeded from:** Kalchas's recon (`RECON`/inventory) + the spec/contract/requirements/role-matrix/NFR. **Consumed by:** hunters (cite `ORC-` in each bug), automation engineers (assert it), Minos (no `ORACLE-id` ⇒ not `ACCEPTED`).
>
> Built in the recon/strategy phase, kept terse. Discover every value from recon — never hardcode a number from a practice app. A row with no source is a gap to flag, not a guess.

ID convention: `ORC-<LANE>-NNN` — lane ∈ API · BIZ · SEC · DB · UI · A11Y · PERF.

| ID | Surface / rule | Expected behaviour (the oracle) | Source (spec / req / contract / recon) |
|---|---|---|---|
| ORC-API-001 | `<METHOD> /path` status + schema | `<code>` + body matches `<schema>`; error contract on bad input | OpenAPI op / recon |
| ORC-BIZ-001 | `<business rule>` | `<allowed/forbidden transition, calc, limit, ownership>` | requirement / AC |
| ORC-SEC-001 | `<role × operation>` / object ownership | non-owner ⇒ 403; role matrix enforced; token expiry honoured | role matrix / spec |
| ORC-DB-001 | `<constraint / invariant>` | `<unique/FK/cascade/transaction/consistency-after-failure>` | schema / recon |
| ORC-UI-001 | `<screen / control>` | `<visible state, validation, enabled/disabled, formatting, empty state>` | spec / design |
| ORC-A11Y-001 | `<screen>` WCAG | keyboard-only path · focus order · ARIA name/role · contrast ratio | WCAG 2.1 AA |
| ORC-PERF-001 | `<endpoint>` budget | p95 ≤ `<budget>` · payload ≤ `<ceiling>` · no N+1 / unbounded list | NFR / baseline |

## Unsourced / disputed (resolve or flag as residual risk)
<rules with no clear source of truth — escalate to Odysseus; an unresolved oracle is a named residual risk, never a silent guess>
