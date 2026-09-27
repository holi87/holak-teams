# Implementation Report — delivered versus designed

> **Canonical owner: Kleio.** Reconcile delivery honestly against `ARCHITECTURE.md` and `TEST-STRATEGY.md`. A named partial is better than a hidden gap.

## 1. Delivered versus designed architecture
| Architecture element | Status (delivered / partial / dropped) | Evidence / reason |
|----------------------|----------------------------------------|-------------------|
| <shared role-aware client or fixture> | | <paths> |
| <isolated browser authentication state> | | |

## 2. Strategy coverage
| Risk | Planned coverage | Delivered tests | Result |
|------|------------------|-----------------|--------|
| RISK-001 | <package> | <test IDs/paths> | <pass / expected RED BUG-NNNN / not done> |

## 3. Final suite state from a fresh run
- Command: `./run-tests.sh --mode <mode>` · exit code: `<n>`
- Totals: `<passed / product / automation / infrastructure / skip / policy>`
- Canonical runner result: `reports/argus-runner-result.json` with timestamp `<time>`
- Runtime-native reports: `<paths>`

## 4. Defects
Copy every count from `argus-assets engagement report-facts`; never hand-count.

- Filed: `<n>` origin files in `bugs/`; canonical rows: `<n>` in Minos's ledger.
- Defect headline (confirmed + suspected): `<n>` = confirmed `<n>` + suspected `<n>`
- Needs oracle: `<n>` · duplicate: `<n>` · rejected: `<n>`
- Every confirmed bug has native `regression` selection plus `@bug:<canonical-or-origin>` provenance: `<wired n; uncovered: none / BUG-IDs>`.

### Likely, unproven
<one line per suspected or needs-oracle row: BUG-NNNN (severity, status): title — would be confirmed by: missing proof — detail; `None.` when empty>

## 5. Automation review
- Aristarchus verdict (`argus-assets automation-review check`): `<APPROVE / BLOCK / STALE / ABSENT / NOT-APPLICABLE>` · review `<REV-NN>` · round `<n>` · blockers `<n>` · warnings `<n>`
- Reviewed corpus: `<sha256>` · reviewed commit: `<sha / none>`
- BLOCK, STALE, or ABSENT while Aristarchus was dispatchable makes the delivery NOT-GO.

## 6. Deviations, cuts, and debt
| Change from plan | Why | Work needed to finish |
|------------------|-----|-----------------------|

## 7. Residual risk
<Name uncovered surface IDs, scoped outcomes, and evidence gaps; do not use raw defect counts as coverage proof.>
