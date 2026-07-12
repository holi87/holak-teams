# Oracles — expected-behaviour registry

> **Canonical owner: Metis.** Seed from Kalchas's inventory and cited contracts or requirements. Hunters cite an `ORC-*` ID, automation encodes it, and Minos rejects unsupported defect claims. Missing truth is an oracle gap, not permission to guess.

ID convention: `ORC-<LANE>-NNN`, where lane is API, BIZ, SEC, DB, UI, A11Y, PERF, or another declared target surface.

| ID | Surface or rule | Expected behaviour | Authoritative source |
|----|-----------------|--------------------|----------------------|
| ORC-API-001 | `<operation>` status and schema | `<status and response/error contract>` | contract operation / requirement |
| ORC-BIZ-001 | `<business rule>` | `<allowed/forbidden transition, calculation, limit, ownership>` | requirement / acceptance criterion |
| ORC-SEC-001 | `<role × operation>` | `<authorisation and ownership outcome>` | role matrix / policy |
| ORC-DB-001 | `<constraint or invariant>` | `<unique/FK/cascade/transaction outcome>` | schema / recon |
| ORC-UI-001 | `<screen or control>` | `<visible state, validation, formatting, error state>` | product/design requirement |
| ORC-A11Y-001 | `<screen and state>` | `<applicable WCAG 2.2 AA outcome>` | WCAG criterion |
| ORC-PERF-001 | `<operation>` | `<stated budget, or characterisation-only basis>` | cited NFR / baseline |

## Unsourced or disputed
<Escalate each unresolved rule to Odysseus and name it as residual risk.>
