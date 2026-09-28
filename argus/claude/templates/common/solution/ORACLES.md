# Oracles — expected-behaviour registry

> **Canonical owner: Metis.** Seed from Kalchas's inventory and cited contracts or requirements. Hunters cite an `ORC-*` ID, automation encodes it, and Minos rejects unsupported defect claims. Missing truth is an oracle gap, not permission to guess.

ID convention: `ORC-<LANE>-NNN`, where lane is API, BIZ, SEC, DB, UI, A11Y, PERF, or another declared target surface.

Class: `requirement` | `contract` | `justified-invariant` | `consistency` | `hypothesis`. Only requirement, contract, and justified-invariant rows can confirm a defect; consistency and hypothesis rows support Suspected only.

| ID | Surface or rule | Expected behaviour | Authoritative source | Class |
|----|-----------------|--------------------|----------------------|-------|
| ORC-API-001 | `<operation>` status and schema | `<status and response/error contract>` | contract operation / requirement | contract |
| ORC-BIZ-001 | `<business rule>` | `<allowed/forbidden transition, calculation, limit, ownership>` | requirement / acceptance criterion | requirement |
| ORC-SEC-001 | `<role × operation>` | `<authorisation and ownership outcome>` | role matrix / policy | requirement |
| ORC-DB-001 | `<constraint or invariant>` | `<unique/FK/cascade/transaction outcome>` | schema / recon | justified-invariant |
| ORC-UI-001 | `<screen or control>` | `<visible state, validation, formatting, error state>` | product/design requirement | requirement |
| ORC-A11Y-001 | `<screen and state>` | `<applicable WCAG 2.2 AA outcome>` | WCAG criterion | requirement |
| ORC-PERF-001 | `<operation>` | `<stated budget, or characterisation-only basis>` | cited NFR / baseline | requirement |

## Consistency oracles (suspected-only)

Each row records a Minos-routed divergence where siblings, layers, actors, or representations of the same logical rule disagree and no source pins the expected value. Consistency-class IDs share the `ORC-<LANE>-NNN` sequence. When a source pins the rule, add the sourced row to the table above with its new class and mark this row `sourced`; otherwise refute it with evidence or keep it as a named residual.

| ID | Compared paths | Rule both must honour | Evidence IDs | Resolution |
|----|----------------|-----------------------|--------------|------------|
| ORC-API-002 | `<path A>` vs `<path B>` | `<shared logical rule>` | `<EVD-NNNN, EVD-NNNN>` | open / sourced / refuted / residual |

## Unsourced or disputed
<Escalate each unresolved rule to Odysseus and name it as residual risk.>
