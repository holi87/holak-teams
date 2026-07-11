---
name: qa-coverage-reporting
description: Shared surface coverage, reconciliation, and final-report contract for Argus roles
user-invocable: false
---

# Argus Coverage and Reporting

Use this profile only for roles that plan, reconcile, judge, or report coverage.

- The stable surface inventory is the denominator. Reconcile discovery completeness,
  risk-weighted execution, meaningful assertion quality, evidence quality, and scoped
  outcomes separately. Never infer coverage from test or defect counts.
- Every in-scope surface, requirement, risk, boundary-register row, journey, and funded
  technique is covered, explicitly out of scope with its missing requirement, or a named
  residual risk with owner and reason. Zero coverage in a funded category is visible.
- Trace requirements and risks to executable tests, evidence, canonical defects, runner
  outcomes, and final claims. Reject dangling IDs, duplicate identities, unsupported
  counts, and summaries that cannot be derived from canonical inputs.
- Report confirmed, suspected, duplicate, rejected, and unsupported candidates distinctly.
  Severity and defect yield do not increase quality metrics. A no-findings result is
  acceptable only when the funded surface and oracle evidence are present.
- Publish delivered-versus-planned reconciliation, coverage gaps, runner-category totals,
  environment limitations, policy denials, and residual risks. Keep raw sensitive evidence
  out of reports; reference only authorized redacted derivatives.
- The final human report is rendered from validated, versioned machine contracts. If an
  input is stale, malformed, cross-engagement, or owner-invalid, block the claim instead of
  approximating it.
