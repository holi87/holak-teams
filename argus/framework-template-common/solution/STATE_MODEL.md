# State Model — lifecycle states, transitions, and invariants

> **Canonical owner: Ariadne.** Build this from Kalchas's inventory and cited business rules. Automation consumes forbidden transitions and invariants; Minos requires the violated row and oracle when validating a lifecycle defect.

## Domain object: `<name>`

### States
`<DRAFT · SUBMITTED · APPROVED · CANCELLED · …>`

### Allowed transitions
| From | To | Role | Preconditions | scope-varied (actor/entity/time) | Oracle |
|------|----|------|---------------|----------------------------------|--------|
| `<state>` | `<state>` | `<role>` | `<conditions>` | `<which dimensions were re-run against the documented scope>` | `ORC-BIZ-NNN` |

### Forbidden transitions
| From | To | Expected rejection/no-mutation outcome | Oracle |
|------|----|----------------------------------------|--------|
| `<state>` | `<state>` | `<outcome>` | `ORC-BIZ-NNN` |

### Invariants
- `<owner cannot change after approval>` → `ORC-BIZ-NNN`
- `<cancelled object cannot be modified>` → `ORC-BIZ-NNN`
- `<aggregate equals its parts; deleted records do not resurrect>` → `ORC-BIZ-NNN`

### Config-change invariants
Fill one row per rule, threshold, price table, quota, or product parameter that an operator can edit while entities are in flight.

| # | Invariant | Expected outcome after the change | Oracle |
|---|-----------|-----------------------------------|--------|
| i | `<decided/terminal entities are frozen>` | `<recorded terms of a decided entity do not change>` | `ORC-BIZ-NNN` |
| ii | `<in-flight entities are re-evaluated or flagged>` | `<an in-flight entity that no longer meets the new criteria is visibly marked>` | `ORC-BIZ-NNN` |
| iii | `<transition guards re-check current criteria>` | `<the commit transition is blocked or warned for an entity that fails the new rule>` | `ORC-BIZ-NNN` |

<Repeat for every stateful object discovered in the target; never import practice-app states.>
