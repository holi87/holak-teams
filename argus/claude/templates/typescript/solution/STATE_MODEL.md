# STATE_MODEL — lifecycle states, transitions, invariants

> The deep-journey map. One block per stateful domain object: legal states, allowed/forbidden transitions, and invariants that must hold across the whole lifecycle. Drives Ariadne's hunt (every FORBIDDEN transition is a probe) and gives automation a concrete target.
>
> **Owner:** Ariadne (builds from Kalchas's recon + business rules). **Consumed by:** Ariadne (hunt), automation (encode forbidden transitions as RED), Minos (lifecycle/invariant bugs cite the violated row). Invariants here should map to `ORC-BIZ-*` in `ORACLES.md`.
>
> Discover states/rules from recon — never hardcode from a practice app.

## Domain object: `<name>`

### States
`<DRAFT · SUBMITTED · APPROVED · CANCELLED · …>`

### Allowed transitions
| From | To | Role | Preconditions |
|---|---|---|---|
| `<state>` | `<state>` | `<role>` | `<what must hold>` |

### Forbidden transitions (each = a probe → RED test)
| From | To | Expected on attempt | Maps to |
|---|---|---|---|
| `<state>` | `<state>` | `<rejected / 4xx / no mutation>` | `ORC-BIZ-NNN` |

### Invariants (hold in every state)
- `<e.g. owner cannot change after approval>` → `ORC-BIZ-NNN`
- `<e.g. cancelled object cannot be modified>` → `ORC-BIZ-NNN`
- `<e.g. total == sum(line items); no resurrection of soft-deleted rows>` → `ORC-BIZ-NNN`

<repeat the block per stateful object: enrollment, order, course, quiz attempt, review, …>
