# State Model — lifecycle states, transitions, and invariants

> **Canonical owner: Ariadne.** Build this from Kalchas's inventory and cited business rules. Automation consumes forbidden transitions and invariants; Minos requires the violated row and oracle when validating a lifecycle defect.

## Domain object: `<name>`

### States
`<DRAFT · SUBMITTED · APPROVED · CANCELLED · …>`

### Allowed transitions
| From | To | Role | Preconditions | Oracle |
|------|----|------|---------------|--------|
| `<state>` | `<state>` | `<role>` | `<conditions>` | `ORC-BIZ-NNN` |

### Forbidden transitions
| From | To | Expected rejection/no-mutation outcome | Oracle |
|------|----|----------------------------------------|--------|
| `<state>` | `<state>` | `<outcome>` | `ORC-BIZ-NNN` |

### Invariants
- `<owner cannot change after approval>` → `ORC-BIZ-NNN`
- `<cancelled object cannot be modified>` → `ORC-BIZ-NNN`
- `<aggregate equals its parts; deleted records do not resurrect>` → `ORC-BIZ-NNN`

<Repeat for every stateful object discovered in the target; never import practice-app states.>
