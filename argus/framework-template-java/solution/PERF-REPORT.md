# Performance Report — <target>

> **Canonical owner: Hermes.** A stated budget permits verdicts; without one, report characterisation only. Hermes files confirmed performance defects as `bugs/HER-*`; Minos independently validates, deduplicates, and assigns canonical `BUG-NNNN` IDs.

## 1. Mode and oracle
- Mode: `BUDGET` with source `<requirement>` | `CHARACTERISATION` with no invented threshold.

## 2. Method and environment validity
- Tool and version: `<selected runtime probe>`
- Workload: `<targets, warm-up, samples, concurrency, data shape>`
- Environment: `<stack, machine, build>`; lab measurements are not production SLO evidence.

## 3. Results
| Target | p50 | p95 | p99 | errors/non-success | throughput |
|--------|-----|-----|-----|--------------------|------------|
| <operation> | | | | | |

Optional frontend sample: `<page and browser timing measurements>`.

## 4. Verdict or anomalies
- Budget mode: `<PASS/FAIL per cited threshold>`.
- Characterisation: `<distribution, sibling comparison, scaling slope, and reproducible anomalies>`.

## 5. Candidate handoff and canonical triage
| Origin finding | Evidence | Reproduction | Regression handoff | Minos disposition |
|----------------|----------|--------------|--------------------|-------------------|
| HER-NNN | <privacy-safe measurements> | <runtime-neutral command or script path> | Nike / pending | BUG-NNNN / rejected / pending |

## 6. Coverage and residual risk
- Coverage versus inventory: `<each structural/signature category filled or explicitly justified>`
- Not measured: `<scope and reason>`
- Recommended future budget: `<recommendation only, never a self-imposed gate>`
