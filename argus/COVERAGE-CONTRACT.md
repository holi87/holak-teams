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

## Required-case depth (4.9.1)

The legacy execution/assertion/evidence ratios above describe surface breadth and presence, not exhaustive behavioral coverage. Never label them case completeness.

Each testable inventory item can carry `obligations`: stable `CASE-*` IDs with `dimensions` (operation, role, state, boundary, device, browser, risk-category), a sourced `oracleId`, `applicability`, and risk `weight` (1–5). Kalchas persists Metis's risk plan before execution. Explicitly enumerate critical combinations; justify representative selection for lower risks rather than expanding an arbitrary Cartesian product.

Observations carry `cases` keyed by `obligationId`, the matching `oracleId`, an outcome (`passed`, `failed`, `blocked`), `evidenceIds`, and distinct `controlEvidenceIds`. A blocked case needs a reason. Control evidence demonstrates that an independently wrong expected value makes the assertion fail, without modifying the target. Neither a self-declared meaningful flag nor an evidence filename alone proves assertion strength.

`overall.caseDepth` and each lane's `caseDepth` report planned, executed, and verified weights, verified/planned coverage, unplanned surfaces, and named gaps. Missing plans yield null depth, never 100%. Product failures count as executed tests; blocked/unexecuted or unsupported cases remain gaps. Legacy inputs remain readable with unknown depth. Before merging a canonical result the runtime recalculates it from canonical inputs and verifies case evidence paths and hashes against the current engagement's evidence registry. Do not treat an unmerged calculation as reconciled evidence.
