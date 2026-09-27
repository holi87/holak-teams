# Argus Surface-Derived Coverage Contract

Argus measures coverage against the target it discovered. It never uses a universal test-count, case-count, defect-count, or expected-bug target. Every coverage flag is derived from registered evidence; no contributor can declare one.

## Canonical inputs

- **Surface inventory** — Kalchas owns `solution/surface-inventory.json` (`argus/surface-inventory@1`). Every stable `SRF-*` item identifies a UI, API, event, or data surface and records its lane, risk basis, risk (`critical`, `high`, `medium`, `low`) and weight (1–5), applicable denominators (routes, operations, schemas, roles, states, devices, browsers, and risk categories), discovery evidence, accessibility, and optional case obligations. It is the only denominator; an observation cannot create one.
- **Coverage observations** — `solution/coverage-observations.json` (`argus/coverage-observations@2`) is a collection keyed by `observationId = <lane>:<surfaceId>`, one record per lane and surface. Execution owners contribute fragments and Kleio merges them. A record cites evidence only: `executions` (`{evidenceId, caseId?}`), `assertions` (`{id, oracleId, evidenceIds, controlEvidenceIds}`), outcome `evidenceIds`, `defectRefs` (ledger IDs or origin aliases), and optional `cases`. Assertion and control evidence must be disjoint, and an obligation may be observed only once across all records.
- **Evidence registry** — `solution/evidence-reference.json` (`argus/evidence-reference@3`). Each reference carries its `kind`, retained `source`, SHA-256 digest, and `relatedSurfaceIds`. Coverage credits nothing that is not registered.
- **Bug ledger** — `solution/bug-ledger.json` (`argus/bug-ledger@2`), the only source of defect outcomes.
- **Automation status** — `solution/automation-status.json` (`argus/automation-status@2`). A test may list the runner `caseIds` it executes and the `surfaceIds` those cases exercise; a test maps each of its cases to each of its surfaces.

`argus-assets coverage validate|calculate --inventory <json> --observations <json> [--evidence <json>] [--ledger <json>] [--automation-status <json>] [--root <dir>]` checks and computes `argus/coverage-result@2`; `calculate --output <json|->` writes it. Evidence sources resolve under `--root` (default: the working directory): absolute paths, `..` segments, and symbolic links that leave the root are refused. `sourceSchemas` lists the inventory, the observations, then the evidence registry and the bug ledger when present, in that order; `runnerCaseMapping` records whether the automation status was applied.

## Resolving an execution

An execution credits its surface only when it resolves:

- The `evidenceId` must be in the registry. Citing any evidence without a registry is an error (`coverage evidence registry required`).
- **`runner-result`** — the `caseId` is required. The registered source must be an `argus/runner-result@1` document with an event for that case whose `category` is `product` or `automation` and whose `status` is `pass` or `fail`; skipped, infrastructure, and policy events never prove execution. When an automation status is supplied, an `implemented`, `passed`, or `failed` test must list that `caseId` in `caseIds` and the surface in `surfaceIds`; otherwise the error is `runner case <caseId> is not mapped to <surfaceId> by automation-status`. Planned and skipped tests never map a case.
- **`http`, `har`, `trace`, `screenshot`, `video`, `dom-snapshot`, `log`, `metric`** — the `caseId` must be absent, the reference's `relatedSurfaceIds` must include the surface, and the ID must not be one of the surface's `discoveryEvidenceIds`.
- **`text`** — never proves execution.

Every violation is an error that names the observation, the reference, and the surface, and the calculation fails closed on any of them.

`reports/argus-runner-result.json` is overwritten by every runner invocation, so a runner result cited by coverage must be archived per run under its own path (for example under `reports/evidence/`) and registered as `runner-result` evidence with `mediaType: application/json`. The registry digest pins the archived bytes; a later overwrite cannot change what an earlier observation proved.

`runnerCaseMapping` is `not-applicable` when no execution, surface-level or case-level, cites runner-result evidence; `unverified` when runner cases were credited without an automation status; and `verified` when an automation status mapped every credited runner case to its surface. The canonical merge passes Atlas's automation status as soon as it has been merged, so from then on a runner case cannot be credited to a surface it does not map to.

## Derived dimensions

Per surface, aggregated across every lane's record for that surface:

- **executed** — at least one execution resolves.
- **asserted** — executed, and at least one assertion has a non-empty `oracleId`, non-empty registered `evidenceIds`, and non-empty registered `controlEvidenceIds` disjoint from them.
- **evidenced** — executed, and at least one outcome `evidenceIds` entry is registered.
- **automated** — executed, and at least one surface-level `runner-result` execution resolves to a runner document with `deliveryGate: true`.

Each lane and the overall result sum the risk weight of **testable** surfaces into `riskWeight.denominator`, `executed`, `asserted`, `evidenced`, and `automated`, and report:

- **Discovery completeness:** characterized candidates divided by discovered candidates.
- **Execution coverage:** executed weight divided by the denominator.
- **Assertion quality:** asserted weight divided by executed weight.
- **Evidence quality:** evidenced weight divided by executed weight.
- **Automated execution:** automated weight divided by executed weight.

A ratio with a zero denominator is `null`, never 100%. `surfaces` lists every inventory item with its derived flags and linked defect IDs, sorted by `surfaceId`. No aggregate may hide a weak dimension, and the canonical validator rejects a result whose flags or weights are inconsistent (asserted, evidenced, or automated without executed; automated execution with `runnerCaseMapping: not-applicable`).

Mode B has no automated execution. Its automated weight is zero, `automatedExecution` is reported as `0` (or `null` when nothing executed), and `runnerCaseMapping` is `not-applicable`. That is reported, not counted as a failure.

## No self-declared flags

Observations have no `executed`, `meaningful`, or `defects` fields; the schema rejects them. Execution, assertion strength, evidence, and automation are derived only from evidence that resolves against the registry and passes the checks above. Neither a declaration nor an evidence filename proves anything.

## Critical surfaces not executed

`criticalUnexecuted` lists, sorted, every testable surface with risk `critical` that is not executed. The canonical validator requires it to match the surfaces exactly. The final-summary merge copies it from the canonical coverage result and caps a `completed` engagement at `degraded` with the status reason `critical-surface-unexecuted` while it is non-empty.

## Defect outcomes

`defectOutcomes` is taken from the canonical bug ledger, never from observations: counts of `confirmed`, `suspected`, `needsOracle`, `duplicate`, and `rejected` rows; `headline = confirmed + suspected`; `linked`, the headline bugs that some observation references; and `unlinked`, the sorted IDs of the remaining headline bugs. Bounced and quarantined rows are in none of these counts. A defect reference resolves through a ledger ID or any origin alias; an unknown reference, or any reference without a ledger, is an error. Without a ledger every count is zero. `scoreContribution` is always `0`: a defect, duplicate, or low-quality filing cannot improve coverage or quality.

## Scope outcomes

Inaccessible and untestable items stay visible in the discovered inventory. They require a reason and discovery evidence and are emitted as explicit scoped outcomes. They are not silently deleted or represented as passed execution, and a scoped critical surface is never listed as unexecuted. The executable denominator contains only `testable` items; the result always reports both testable and scoped item counts.

## Proportionate targets

The denominator is the inventory, so small and large targets scale naturally. Risk weighting changes depth priority, not whether a discovered surface exists. Any threshold used by an engagement must be derived from its risk policy and recorded outside this calculation; the canonical evaluator intentionally returns measurements, not a universal pass/fail gate.

## Required-case depth (4.9.1)

The execution, assertion, evidence, and automation ratios describe surface breadth and evidence, not exhaustive behavioral coverage. Never label them case completeness.

Each testable inventory item can carry `obligations`: stable `CASE-*` IDs with `dimensions` (operation, role, state, boundary, device, browser, risk-category), a sourced `oracleId`, `applicability`, and risk `weight` (1–5). Kalchas persists Metis's risk plan before execution. Explicitly enumerate critical combinations; justify representative selection for lower risks rather than expanding an arbitrary Cartesian product.

Observations carry `cases` keyed by `obligationId`, the matching `oracleId`, an outcome (`passed`, `failed`, `blocked`), `evidenceIds`, distinct `controlEvidenceIds`, and an optional `execution` (`{evidenceId, caseId?}`). A blocked case needs a reason. Control evidence demonstrates that an independently wrong expected value makes the assertion fail, without modifying the target. A case counts as run only when its surface is executed; a `passed` or `failed` case on an unexecuted surface is an error. A case `execution` must resolve under the same rules as a surface execution, including the automation-status mapping, and a runner outcome must match the case outcome (`pass` → `passed`, `fail` → `failed`).

`overall.caseDepth` and each lane's `caseDepth` report planned, executed, and verified weights, verified/planned coverage, unplanned surfaces, and named gaps. Missing plans yield null depth, never 100%. Product failures count as executed tests; blocked, unexecuted, or unsupported cases remain gaps.

## Canonical merge

Before merging Kleio's `solution/coverage-result.json`, the runtime recalculates it from the canonical inventory and observations, the evidence registry when it exists, the bug ledger once Minos has merged it (required while Minos is dispatchable), and the automation status once Atlas has merged it. It applies the digest, capture-time, and content checks to every evidence ID the coverage inputs cite, including the inventory's discovery evidence, and rejects a result that differs from the recalculation in anything but `generatedAt`. Do not treat an unmerged calculation as reconciled evidence.
