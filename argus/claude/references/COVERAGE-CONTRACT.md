# Argus Surface-Derived Coverage Contract

Argus measures coverage against the target it discovered. It never uses a universal test-count, case-count, defect-count, or expected-bug target.

## Canonical inputs

Kalchas owns `solution/surface-inventory.json` (`argus/surface-inventory@1`). Every stable `SRF-*` item identifies a UI, API, event, or data surface and records its lane, risk basis and weight, applicable denominators (routes, operations, schemas, roles, states, devices, browsers, and risk categories), discovery evidence, and accessibility.

Execution owners contribute `solution/coverage-observations.json` (`argus/coverage-observations@1`). Each observation links one inventory item to execution state, meaningful oracle-backed assertions, evidence IDs, and defect outcomes. An observation cannot create its own denominator.

`argus-assets coverage calculate` produces `solution/coverage-result.json` (`argus/coverage-result@1`). Inputs and calculations remain machine-readable and traceable by stable IDs.

## Independent dimensions

- **Discovery completeness:** characterized candidates divided by discovered candidates.
- **Execution coverage:** risk weight of executed testable items divided by risk weight of all testable items, per lane and overall.
- **Assertion quality:** executed risk weight backed by at least one meaningful, named oracle divided by executed risk weight.
- **Evidence quality:** executed risk weight backed by evidence divided by executed risk weight.
- **Defect outcomes:** unique confirmed, duplicate, and unsupported outcomes are reported separately with `scoreContribution: 0`.

No aggregate may hide a weak dimension. A defect, duplicate, or low-quality filing cannot improve coverage or quality. Counts remain descriptive only.

## Scope outcomes

Inaccessible and untestable items stay visible in the discovered inventory. They require a reason and discovery evidence and are emitted as explicit scoped outcomes. They are not silently deleted or represented as passed execution. The executable denominator contains only `testable` items; the result always reports both testable and scoped item counts.

## Proportionate targets

The denominator is the inventory, so small and large targets scale naturally. Risk weighting changes depth priority, not whether a discovered surface exists. Any threshold used by an engagement must be derived from its risk policy and recorded outside this calculation; the canonical evaluator intentionally returns measurements, not a universal pass/fail gate.
