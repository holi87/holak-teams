---
name: qa-coverage-reporting
description: Shared surface coverage, reconciliation, and final-report contract for Argus roles
user-invocable: false
---

# Argus Coverage and Reporting

Use this profile only for roles that plan, reconcile, judge, or report coverage.

- The stable surface inventory is the denominator. Reconcile discovery completeness,
  risk-weighted execution, meaningful assertion quality, evidence quality, automated
  execution, and scoped outcomes separately. Never infer coverage from test or defect
  counts.
- Every surface flag is derived from registered evidence, never declared. A runner case
  credits only the surfaces automation status maps it to (`runnerCaseMapping`). Name each
  `criticalUnexecuted` surface; any one degrades the final status.
- Every in-scope surface, requirement, risk, boundary-register row, journey, and funded
  technique is covered, explicitly out of scope with its missing requirement, or a named
  residual risk with owner and reason. Zero coverage in a funded category is visible.
- Trace requirements and risks to executable tests, evidence, canonical defects, runner
  outcomes, and final claims. Reject dangling IDs, duplicate identities, unsupported
  counts, and summaries that cannot be derived from canonical inputs.
- Take defect outcomes from the canonical ledger only: confirmed, suspected, needs-oracle,
  bounced, quarantined, duplicate, and rejected counts stay distinct, the headline is
  confirmed + suspected, a "Likely, unproven" section lists every suspected and needs-oracle
  row with what would confirm it, and a "Held back" section lists every bounced and
  quarantined row with its reasons. Severity and defect yield do not increase quality metrics. A no-findings
  result is acceptable only when the funded surface and oracle evidence are present.
- Publish delivered-versus-planned reconciliation, coverage gaps, runner-category totals,
  environment limitations, policy denials, and residual risks. Keep raw sensitive evidence
  out of reports; reference only authorized redacted derivatives.
- The final human report is rendered from validated, versioned machine contracts. If an
  input is stale, malformed, cross-engagement, or owner-invalid, block the claim instead of
  approximating it.

- Kalchas persists risk-derived `obligations` per surface (stable CASE id, dimensions, oracleId, applicability, weight) from Metis's plan. Critical combinations are explicit; other cases use justified representative selection. Execution owners return `cases` with outcome and distinct execution/control evidence IDs. An assertion-control probe must demonstrably fail for a deliberately wrong expected result; never alter the target to arrange it.
- Report `caseDepth` separately from surface breadth. Missing obligation plans mean unknown depth, never full coverage. Missing/blocked cases and missing assertion-control evidence remain gaps. Reconcile evidence registry entries and bytes before accepting verified depth.
