# Argus Runner Modes and Outcome Contract

This contract removes the ambiguity between an intentionally reproduced product defect
and a failed delivery gate. Every framework runner accepts `--mode <name>`, writes
`reports/argus-runner-result.json`, and returns one of the exit codes below.

## Modes

| Mode | Test selection | Required input | Output and success rule |
|---|---|---|---|
| `baseline` | All applicable tests except bug-linked regression/evidence cases. | Target URLs/config plus ordinary framework selectors. | Exit 0 only when the baseline has no unexpected product, automation, infrastructure, policy, or required-skip outcome. Known RED evidence is excluded, never counted as green. |
| `defect-evidence` | Bug-linked tests only. | An adapter event file with at least one `product/fail/expected=true` event linked to `BUG-NNNN`. | Exit 0 only when every selected known defect reproduces and no unexpected outcome occurs. Missing events, unexpected failures, or a passing expected-RED case fail closed. |
| `candidate-regression` | Bug-linked tests against a product-fix candidate. | Product fix candidate plus bug-linked cases. | Strict green: every failure remains unexpected even if it was historically known. Exit 0 proves the candidate closes the selected regressions. |
| `full-suite` | Baseline plus bug-linked regression tests and enabled conditional lanes. | Complete target/runtime configuration. | Strict green over the whole selected suite. Known RED is visible as a product failure and fails the gate; it is never converted to pass/skip. |

Extra framework-native selectors are passed after `--`. `baseline` and `full-suite` are
delivery gates; `defect-evidence` is evidence collection, not a green regression gate.

## Adapter event input

Framework adapters write tab-separated records to `reports/outcomes.raw.tsv` (or
`ARGUS_OUTCOME_FILE`). Each row has exactly seven fields:

```text
case_id  category  status  expected  lifecycle  bug_id  reason
```

- category: `product`, `automation`, `infrastructure`, `skip`, or `policy`;
- status: `pass`, `fail`, `skipped`, or `denied`;
- expected: `true` only for an explicitly known product defect or approved skip;
- lifecycle: `discovered`, `reproduced`, `automated`, `fixed`, `closed`, or `n/a`;
- bug ID: `BUG-NNNN` for defect lifecycle events, otherwise `-`;
- every field is a safe machine token; detailed/redacted evidence stays in referenced reports.

If the underlying runner fails without adapter events, the wrapper emits an unexpected
`infrastructure` outcome. In `defect-evidence`, an absent/empty adapter file is a contract
failure rather than inferred success. This prevents an unrelated crash from being
misclassified as reproduced defect evidence.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Selected mode contract satisfied. |
| 10 | Product outcome violates the selected gate, including missing expected RED or an unfixed regression. |
| 11 | Automation/test-code defect. |
| 12 | Infrastructure/environment/runner failure. |
| 13 | Policy or authorization denial. |
| 14 | Invalid mode, event format, missing required evidence input, or incompatible result contract. |
| 15 | An unapproved skip leaves required coverage unexecuted. |

All categories remain in the machine result even when another category determines the
exit code. Final summaries must report product defects, automation defects,
infrastructure failures, skips, and policy denials separately.

## Defect lifecycle

`discovered → reproduced → automated → fixed → closed` is the complete lifecycle.
Discovery alone is not defect evidence. `reproduced` requires a linked expected RED event.
`automated` means a stable bug-linked test exists. `fixed` is observed only in
`candidate-regression` or `full-suite` when that case passes. `closed` additionally
requires the strict gate and the canonical bug/automation records to be reconciled.

The portable `scripts/runner-contract.sh` in every TypeScript, Java, and Python template
evaluates the same event format and exit-code rules. Framework-specific runners own only
test selection and raw-event production.
