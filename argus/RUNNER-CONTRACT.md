# Argus Runner Modes and Outcome Contract

This contract removes the ambiguity between an intentionally reproduced product defect
and a failed delivery gate. Every framework runner accepts `--mode <name>`, writes
`reports/argus-runner-result.json`, and returns one of the exit codes below.

## Modes

| Mode | Test selection | Required input | Output and success rule |
|---|---|---|---|
| `baseline` | All applicable tests except cases carrying the framework-native `regression` marker. | Target URLs/config plus ordinary framework selectors. | Exit 0 only when the baseline has no unexpected product, automation, infrastructure, policy, or required-skip outcome. Known RED evidence is excluded, never counted as green. |
| `defect-evidence` | Tests carrying the framework-native `regression` marker only. | An adapter event file with at least one `product/fail/expected=true` event linked to `BUG-NNNN`. | Exit 0 only when every selected known defect reproduces and no unexpected outcome occurs. Missing events, unexpected failures, or a passing expected-RED case fail closed. |
| `candidate-regression` | Tests carrying the framework-native `regression` marker against a product-fix candidate. | Product fix candidate plus bug-linked cases. | Strict green: every failure remains unexpected even if it was historically known. Exit 0 proves the candidate closes the selected regressions. |
| `full-suite` | Baseline plus bug-linked regression tests and enabled conditional lanes. | Complete target/runtime configuration. | Strict green over the whole selected suite. Known RED is visible as a product failure and fails the gate; it is never converted to pass/skip. |

Extra framework-native selectors are passed after `--`. `baseline` and `full-suite` are
delivery gates; `defect-evidence` is evidence collection, not a green regression gate.
The separate `@bug:<canonical-or-origin>` token is provenance, not selection: it must
match either the canonical `id` or one `origin` value in `solution/bug-ledger.json`.
Every defect regression carries both the native `regression` marker and this provenance
token.

## Adapter event input

Framework adapters write tab-separated records to `reports/outcomes.raw.tsv` (or
`ARGUS_OUTCOME_FILE`). Each row has exactly seven fields:

```text
case_id  category  status  expected  lifecycle  bug_id  reason
```

The evaluator never invents an event. An empty event stream with a green native runner is a
broken adapter and fails closed as a contract error in every mode: a run that produced no
evidence cannot report a pass.

An approved skip is one that appears in the quarantine register by case id. `expected=true`
is written by the adapter about its own case, so it cannot also be the proof that the skip
was approved; a skip with no register row breaks the gate.

Outside `baseline` the caller must name the confirmed defects (`--expected-bugs <file>`, the
SD-4 list, empty when there are none): an omitted flag or a file that does not exist is a
contract error (exit 14), and every listed defect must appear as an event, otherwise the
run is a policy failure (exit 13). A selector that silently drops half the regression suite
otherwise looks identical to a suite that ran it.

The result carries `generatedAt`, `deliveryGate` and `missingExpectedBugs` so a reader
holding only that file can tell what it is evidence of. `deliveryGate` is true only for
`full-suite`; a `defect-evidence` result that overwrote a delivery-gate result is then
visible as what it is, and the last write no longer decides what the run looked like.

- category: `product`, `automation`, `infrastructure`, `skip`, or `policy`;
- status: `pass`, `fail`, `skipped`, or `denied`;
- expected: `true` only for an explicitly known product defect or approved skip;
- lifecycle: `discovered`, `reproduced`, `automated`, `fixed`, `closed`, or `n/a`;
- bug ID: `BUG-NNNN` for defect lifecycle events, otherwise `-`;
- every field is a safe machine token; detailed/redacted evidence stays in referenced reports.

Every runtime stores retained, redacted evidence below `reports/evidence/` and links it
through the canonical evidence-reference contract. Product lane semantics are `api`,
`ui`, `perf`, `security`, `db`, and `resilience`; the harness-only lanes are
`contract-smoke` and `setup`. Bug-linked tests select with `regression` and join the
canonical ledger through the runtime's provenance marker (`@bug:<canonical-or-origin>`
is the canonical spelling); target-independent scaffold validation uses
`contract-smoke` (framework-native spelling may be adapted, see SD-11 in
`TEMPLATE-CONTRACT.md`).

## Retry and quarantine semantics

Automatic retries and reruns are disabled in every template (`maximumAttempts: 1`). A
failure is evidence to diagnose, not noise to hide.

Quarantine is an expiring, auditable exception. A quarantined test carries the runtime's
quarantine tag and has exactly one row in `solution/quarantine.tsv`:
`case_id`, `owner`, safe reason token, `expires_on`, and issue token. All modes exclude
that tag from native execution, while `scripts/quarantine-contract.sh` emits an approved
skip for each valid row. A malformed or duplicate row or an expired entry is a policy
failure (exit 13), never a silent skip. The portable quarantine evaluator is
byte-identical across TypeScript, Java, and Python templates. `--inventory
reports/test-inventory.tsv` is required (an omitted flag or an absent file is exit 14) and
joins by case id: a ledger row without a quarantined inventory row
(`quarantine-entry-orphaned`), a quarantined row without a ledger row
(`quarantine-unregistered`), and a quarantined regression (`regression-quarantine-forbidden`,
never an approved skip) are policy failures.

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

## Template contract v2 runner specification (SD-1 to SD-7)

These sections are normative for `argus/template-contract@2`. The result schema stays
`argus/runner-result@1`: lanes, inventory, coverage, and counterfactual evidence are
expressed as events and runner-kit artifacts, never as new result fields. SD-8 to SD-11
(lane plan, environment, counterfactual fixtures, markers) live in `TEMPLATE-CONTRACT.md`.

### SD-1 Activation and emission

- The outcome adapters (TypeScript `scripts/argus-playwright-reporter.mjs`, Java
  `qa.support.argus.ArgusOutcomeListener`, Python `qa.argus_plugin`) stay inert unless
  `ARGUS_RUNNER_MODE` is one of the four modes. Only `scripts/runner-lib.sh` exports it.
- `ARGUS_EVIDENCE_PASS` is `live`, `repeat`, `cf-correct`, or `cf-tamper-<k>`; the
  default is `live`. `ARGUS_INVENTORY_ONLY=1` is a collect-only pass that runs no test
  body and writes only the inventory artifacts (SD-3, SD-4, SD-10).
- Every event is appended through `bash <root>/scripts/outcome-event.sh <7 fields>` with
  an absolute `ARGUS_OUTCOME_FILE`. Adapters never write the TSV directly and never put
  titles, messages, URLs, or bodies into events. Raw native reports stay per pass below
  `reports/evidence/passes/<pass>/`.
- At the end of each native run the adapter writes `reports/argus-adapter-status.txt`
  containing `ok <events>` or `error <failures>`. A missing or `error` status after a
  green native run is an automation failure, never a pass.

### SD-2 Case id

`S(x)` replaces each run of characters outside `[A-Za-z0-9_.:-]` with `-` and strips
leading and trailing `-`. Above 200 characters it keeps the first 187 characters, then
`.`, then the first 12 hex digits of `sha256(x)`.

| Runtime | `x` |
|---|---|
| TypeScript | `<project>:<posix path relative to config.rootDir>:<describe/title path joined by " > ">` |
| Python | `item.nodeid` with `/` replaced by `.` |
| Java | `<fqcn>.<method>`, plus `(<param simple names>)` only for overloads; template and dynamic invocations become `<id>.i<N>` |

Collisions get `.2`, `.3`, … in declaration order over the full collection, so a mode- or
lane-filtered run never renumbers them: it reuses the inventory pass's ids (TypeScript
joins each test to `reports/test-case-ids.tsv`, `<sha256 of the raw identity><TAB><id>`,
and a test it cannot join fails the adapter status; only a run with no map at all, a plain
`playwright test` outside the runner, numbers its own suite). Pass suffixes are `.repeat`,
`.cf-correct`, `.cf-<tamperId>`, and `.cf` (exemption); a secondary cleanup event uses
`.cleanup`.

### SD-3 Inventory

`reports/test-inventory.tsv` has 8 tab-separated fields and no header. It covers the full
collection (never mode-filtered) and is written atomically through a temporary file plus
rename.

| # | Field | Values |
|---:|---|---|
| 1 | `case_id` | SD-2 id |
| 2 | `lane` | `api`, `ui`, `perf`, `security`, `db`, `resilience`, `contract-smoke`, `setup`, `-`, or `ambiguous` |
| 3 | `regression` | `true` or `false` |
| 4 | `quarantine` | `true` or `false` |
| 5 | `bug_ids` | comma-separated canonical `BUG-NNNN`, or `-` |
| 6 | `unresolved` | comma-separated raw provenance tokens, or `-` |
| 7 | `disabled` | `-`, `skip`, `fixme`, `expected-failure`, or `conditional` |
| 8 | `source` | `posix-path:line` or fqcn using `[A-Za-z0-9_./:-]`, or `-` |

### SD-4 Ledger join

Provenance tokens matching `^(BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4})$` resolve through the
`id` or `origin[]` of `solution/bug-ledger.json`. Resolution reads `bugs[].id` and
`bugs[].origin[]`, which have the same shape in every supported ledger version.
`reports/expected-bugs.txt` holds the sorted unique canonical ids whose `status` is
exactly `confirmed`; `suspected`, `needs-oracle`, and every other status are excluded.
The inventory pass writes it, one id per line, and leaves it empty when there are none.

- A missing ledger in `baseline` gives an empty file and no event. In every other mode it
  gives `bug-ledger policy denied false n/a - bug-ledger-missing`.
- An invalid ledger gives `bug-ledger policy denied false n/a - bug-ledger-invalid` in
  every mode. Invalid means: not JSON; a `$schema` other than a supported
  `argus/bug-ledger@<n>` (currently `@1` and `@2`); a `schemaVersion` that differs from
  that `<n>`; a duplicate `id`; or an alias that resolves to two ids.

### SD-5 Primary classification

The adapter classifies from the framework's own signal (step category, exception type,
phase), never from message text alone. The Argus error classes have exactly these names
in every runtime.

| Primary outcome | Event (`category status`, reason) |
|---|---|
| Assertion. TS: the terminal error matches the error of an `expect`-category step found depth-first in `result.steps`. Java: `instanceof AssertionError`, including opentest4j. Python: a call-phase `AssertionError`. | `product fail`, see SD-6 |
| Test-level timeout. TS `timedOut` or Playwright `TimeoutError`; `httpx.TimeoutException`; Java `TimeoutException`, `SocketTimeoutException`, or Awaitility `ConditionTimeoutException`. | `automation fail`, `test-timeout` |
| Fixture, hook, or setup failure. | `automation fail`, `fixture-failed` or `hook-failed` |
| Java: a failed container (a class or template whose `@BeforeAll`, argument source, or factory failed), whose tests therefore never report. Each case under it that never reported gets the event under its own case id, pass suffix, and bug; a container whose cases all reported (a failed `@AfterAll`) gets it under the container id. | `automation fail`, `container-failed` |
| Playwright API error. | `automation fail`, `playwright-api-failed` |
| Refused, unknown-host, or reset connection. TS: `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `net::ERR_`. Java: `ConnectException`, `UnknownHostException`, or `NoRouteToHostException` in the cause chain. Python: `httpx.ConnectError`, `ConnectTimeout`, or `ConnectionError`. | `infrastructure fail`, `target-unreachable` |
| Interrupted test. | `infrastructure fail`, `test-interrupted` |
| `ArgusCleanupError` | `automation fail`, `cleanup-failed` |
| `ArgusPrerequisiteError` | `infrastructure fail`, `prerequisite-missing` |
| `ArgusRestoreError` | `infrastructure fail`, `fault-restore-failed` |
| `ArgusCounterfactualError` | `automation fail`, `counterfactual-unmatched-request` |
| TS: `ArgusCounterfactualSubjectError` (the stub never served the subject exchange, or a per-test `baseURL` override would bypass it) | `automation fail`, `counterfactual-subject-not-served` |
| Any other error. | `automation fail`, `uncaught-error` |
| Runtime skip. | `skip skipped false n/a`, `test-skipped`; for a regression test `policy denied`, `regression-skipped` |
| `test.fail`, xfail, or xpass. | `policy denied`, `expected-failure-forbidden` |

A teardown failure alongside a different primary outcome adds
`<case>.cleanup automation fail false n/a <bug|-> cleanup-failed`.

### SD-6 Product events

A non-regression test gives `product pass false n/a - passed` or
`product fail false n/a - assertion-failed`. A regression test for bug `B` gives:

| Mode and pass | Test fails on its assertion | Test passes |
|---|---|---|
| `defect-evidence`, `live` | `product fail true reproduced B expected-red` | `product pass true automated B expected-red-passed` |
| `defect-evidence`, `repeat` | `product fail true reproduced B expected-red-repeat` | `automation fail false n/a B flaky-red` |
| `cf-correct` | `automation fail false n/a B counterfactual-correct-red` | `product pass false reproduced B counterfactual-correct-pass` |
| `cf-tamper-<k>` | `product fail true reproduced B counterfactual-tamper-red` | `automation fail false n/a B counterfactual-tamper-survived` |
| `candidate-regression`, `full-suite` | `product fail false automated B regression-red` | `product pass false fixed B regression-green` |

Non-product outcomes of a regression test carry `B` with `expected=false` and
`lifecycle=n/a`. TypeScript credits a `cf-correct` or `cf-tamper-<k>` row only when the
counterfactual activation recorded the variant the stub served (the
`argus-counterfactual-variant` test annotation); otherwise the regression gives
`automation fail false n/a B counterfactual-not-activated`. A counterfactual exemption (SD-10) gives
`<case>.cf policy pass false n/a B counterfactual-exempt.<reason>` in `cf-correct`; a
tamper pass whose variant is exempt or not applicable emits nothing for that test.

Intermittent defects have one definition. A regression declares its repetition `n`
(SD-11), derived from the ledger entry's `verification.reproduction`: with
`p = occurrences / attempts`, `n = 1` when `p = 1` or the entry has no reproduction
record, otherwise
`n = min(200, ceil(ln 0.05 / ln(1 - p)))`, raised at most once to the 99% bound
`min(200, ceil(ln 0.01 / ln(1 - p)))` after an unreproduced run. One test invocation
repeats the reproduction from fresh state up to `n` times and fails at the first oracle
violation; this is not a retry, and a failure is never re-run to green. The table above
applies unchanged to `n = 1` (deterministic) regressions, and `flaky-red` applies only
to them. For `n > 1` the defect-evidence pass is RED for `B` when any of its `live` or
`repeat` invocations shows the violation; an invocation that completes all `n`
repetitions without a violation gives `product pass false n/a B intermittent-unreproduced`
instead of `expected-red-passed` or `flaky-red`. A bug whose defect-evidence
invocations are all `intermittent-unreproduced` has no RED evidence and fails the gate as
a missing expected RED. Counterfactual passes run against deterministic stubs, so their
rules do not depend on `n`. A repetition declaration that is not a single integer in
`1..200`, that is below the 95% bound for the ledger's `p`, or that exceeds 1 for a
deterministic entry gives `policy denied false n/a B repetition-invalid`. That event takes
the place of the invocation's product event; non-product outcomes are reported unchanged.

### SD-7 Closed reason vocabulary

The reason field of an adapter event comes only from SD-4, SD-5, and SD-6
(`passed`, `assertion-failed`, `test-timeout`, `fixture-failed`, `hook-failed`,
`container-failed`, `playwright-api-failed`, `target-unreachable`, `test-interrupted`, `cleanup-failed`,
`prerequisite-missing`, `fault-restore-failed`, `counterfactual-unmatched-request`,
`counterfactual-subject-not-served`, `uncaught-error`, `test-skipped`, `regression-skipped`, `expected-failure-forbidden`,
`expected-red`, `expected-red-passed`, `expected-red-repeat`, `flaky-red`,
`intermittent-unreproduced`, `repetition-invalid`, `counterfactual-correct-pass`,
`counterfactual-correct-red`, `counterfactual-tamper-red`,
`counterfactual-tamper-survived`, `counterfactual-not-activated`,
`counterfactual-exempt.<reason>`, `regression-green`,
`regression-red`,
`bug-ledger-missing`, `bug-ledger-invalid`) plus the gate tokens that
`scripts/runner-lib.sh`, `scripts/runner-contract.sh`, and the portable lane-plan,
environment, inventory, evidence, and counterfactual gates emit. No other reason token
is valid.

### Runner library and gates

`scripts/runner-lib.sh` owns the run. A runtime `run-tests.sh` sets `ARGUS_RUNTIME`,
`ARGUS_PACKAGE_MANAGER`, and `TEST_ROOT`, defines the hooks `argus_native_prepare`,
`argus_native_inventory`, `argus_native_run <baseline|full|regression> <lanes-csv> <pass>
[passthrough...]`, `argus_native_collect <pass>`, and optionally `argus_native_post
<mode>`, sources the library, and calls `argus_main "$@"`. Hooks run with errexit
suspended, report their own failures through `scripts/outcome-event.sh`, and return a
status; they never `exit`. Any unexpected stop is `wrapper infrastructure fail
wrapper-command-failed`.

The steps run in this order; a denial finishes the run through `scripts/runner-contract.sh`.

1. Mode parsing (an invalid mode exits 14 without a result), removal of stale events,
   inventory, expected-bugs, counterfactual-plan, and adapter-status files, and an absolute
   `ARGUS_OUTCOME_FILE`.
2. Template selection, before any other event: `template-selection-missing-or-incompatible`.
3. `full-suite` with framework selectors: `runner-selection` `full-suite-narrowing-forbidden`.
4. The lane plan (SD-8) through `scripts/lane-plan.sh validate`: `lane-plan-invalid`,
   `lane-plan-empty`, `lane.<lane>` `lane-prerequisite-missing`, and in `full-suite`
   `lane-decision-missing`; each disabled lane records `lane.<lane> policy pass
   lane-disabled.<reason>`. Under `ARGUS_CONTRACT_SMOKE=1` the run instead records
   `contract-smoke-mode`, selects only the `contract-smoke` lane, skips the lane plan,
   readiness, and environment steps, and its result has `deliveryGate: false` in every mode.
5. The engagement fault-injection opt-in (below), then `argus_native_prepare`.
6. Readiness: `ARGUS_READINESS_URLS` (space-separated; an explicitly empty value probes
   nothing), otherwise `API_URL` for an enabled api, perf, security, or resilience lane and
   `UI_URL` for an enabled ui lane: `readiness infrastructure fail target-not-ready`.
7. The engagement reset opt-in (below), then `scripts/environment-gate.sh` (SD-9). A
   declared reset runs only with `ARGUS_ENVIRONMENT_RESET=execute` and within
   `ARGUS_RESET_TIMEOUT_SECONDS` (default 300): `environment-reset-executed`, or
   `environment-reset-failed` (exit 12); without the opt-in it records
   `environment-reset-not-requested`. A declared verify always runs within
   `ARGUS_VERIFY_TIMEOUT_SECONDS` (default 120): `environment-baseline-verified`, or
   `environment-not-at-baseline` (exit 12). Policy denials (exit 13):
   `environment-plan-invalid`, `environment-timeout-invalid`, and in `full-suite`
   `environment-decision-missing` or `environment-baseline-unproven` (no executed reset and
   no passing verify).
8. The collect-only inventory pass: a failure or an empty inventory is `test-inventory
   automation fail test-inventory-failed`.
9. `scripts/quarantine-contract.sh --inventory`, then `scripts/inventory-gate.sh static` (below).
10. The evidence passes. `baseline`, `full-suite`, and `candidate-regression` run one `live`
    pass (selecting baseline, full, and regression). `defect-evidence` runs `live`, `repeat`,
    then `cf-correct` when any plan row is a fixture or an exemption, then `cf-tamper-1..N`
    for the largest tamper count among the fixtures, all selecting regression; the pass list
    comes from `scripts/evidence-gate.sh --list-passes`, and a missing or damaged plan runs no
    counterfactual pass. Each pass stores native artifacts in its own `reports/evidence/passes/<pass>/`
    through `argus_native_collect` (`evidence-collect.<pass>` `evidence-collect-failed` on
    failure). A green native run without an adapter status is `adapter automation fail
    outcome-adapter-missing`; an `error` or malformed status is `outcome-adapter-failed`.
11. `argus_native_post`, whose status counts as a native status.
12. In `baseline` and `full-suite`, `scripts/lane-plan.sh verify`: an enabled lane executed
    when a product, automation, or infrastructure event's case id equals, or extends with
    `.<suffix>`, an inventory row of that lane (`lane.<lane> policy pass lane-executed`);
    otherwise `lane.<lane> skip skipped lane-not-executed` (exit 15). Then, in every mode,
    `scripts/inventory-gate.sh executed`, and in `defect-evidence` `scripts/evidence-gate.sh`
    (below).
13. In `full-suite`, except under a contract smoke, the automation review gate (below).
14. `scripts/runner-contract.sh` with `--quarantine` when the register exists,
    `--expected-bugs reports/expected-bugs.txt` when the inventory pass wrote it, and
    `--contract-smoke` under a contract smoke. Outside `baseline` an absent list is replaced
    by an empty one only when the run already recorded why: it stopped before the inventory
    pass produced an inventory, or step 9 recorded `expected-bugs expected-bugs-missing`.
    That recorded outcome then decides the exit code; any other absence leaves the flag out
    and is a contract error (exit 14).

**Inventory and evidence gates.** `scripts/inventory-gate.sh static` checks the inventory
(SD-3) against the confirmed-defect list (SD-4) and appends one event per violation; only an
unusable inventory (missing, empty, malformed, or a duplicate case id: `test-inventory
automation fail test-inventory-invalid`) stops the run. Automation failures (exit 11):
`lane-undeclared` (lane `-` or unknown), `lane-ambiguous`, `multiple-bug-provenance`,
`bug-provenance-without-regression`, `regression-without-provenance`, and
`focus-scan focus-scan-failed`. Policy denials (exit 13): `bug-provenance-unresolved`,
`regression-disabled.<kind>`, `regression-in-disabled-lane` (not under a contract smoke),
`regression-for-unconfirmed-bug`, `expected-bugs expected-bugs-invalid`, `focus-scan
focused-test-forbidden` for `test.only(`, `describe.only(`, or `it.only(` in a `*.ts`,
`*.tsx`, `*.js`, `*.jsx`, `*.mjs`, or `*.cjs` file below `TEST_ROOT` (outside
`node_modules`), and outside `baseline` `expected-bugs expected-bugs-missing` and
`bug-coverage.<B> bug-uncovered` for a confirmed bug without a regression row that carries
exactly `B`, runs in an enabled lane, and is neither quarantined nor disabled.
`scripts/inventory-gate.sh executed` gives every selected row (an enabled product lane, or
only `contract-smoke` under a contract smoke; not quarantined; only regressions in
`defect-evidence` and `candidate-regression`, none in `baseline`) that has no event under its
case id or that id extended with `.<suffix>` (the longest inventory id wins)
`<case> skip skipped <B|-> selected-test-not-executed` (exit 15). `scripts/evidence-gate.sh`
requires for every confirmed bug `B` an `expected-red` and an `expected-red-repeat` (one of
the two for an intermittent defect, SD-6), else `evidence.<B> policy denied
evidence-live-red-missing` or `evidence-repeat-red-missing`, and a usable plan row (SD-10),
else `counterfactual.<B> policy denied counterfactual-plan-missing`; a plan with an
unparseable row or two rows for one bug is unusable. A `missing` row gives
`counterfactual-missing`, an `invalid` row `automation fail
counterfactual-fixture-invalid.<reason>`. A `fixture` needs a
`counterfactual-correct-pass`, at most one per case id (each invocation of a template or
parametrized regression is its own case), and a `counterfactual-tamper-red` whose case id
ends in `.cf-<t>` for every tamper `t`; an `exempt` row needs `counterfactual-exempt.<reason>`
with the plan's reason; otherwise `counterfactual-incomplete`. A missing proof is not denied when
the same pass (by SD-2 case-id suffix) already gave `B` a failing verdict such as `flaky-red`
or `counterfactual-tamper-survived`, so that verdict keeps its own exit code.

**Automation review gate.** The last step of a `full-suite` run reads Aristarchus's
`solution/automation-review.json` (`argus/automation-review@1`, see `CANONICAL-CONTRACTS.md`
"Automation review in 5.0") when it exists, and its latest round decides. `BLOCK` gives
`automation-review.<REV-NN> policy denied automation-review-blocked` (exit 13), and the
runner prints the blocking round and its blocker count. `APPROVE` records
`automation-review.<REV-NN> policy pass automation-review-approved` and leaves the exit code
unchanged. An absent record changes nothing, so a suite delivered without it runs as before.
The gate fails closed with `automation-review policy denied automation-review-invalid`
(exit 13) for a record that is a symbolic link or not a regular file, is not JSON, is not an
`argus/automation-review@1` document, or has rounds that do not run contiguously from
`REV-01` with an `APPROVE` or `BLOCK` verdict that is `BLOCK` exactly when blockers remain.
It reads the record with `node`, or with `python3` when `node` is absent; both apply the same
checks, and with neither a present record is invalid. The gate judges only the persisted
verdict: the corpus binding (`STALE`) and a missing review (`ABSENT`) need the engagement
manifest and belong to `argus-assets automation-review check`. Other modes and contract
smokes skip the gate: only a `full-suite` result carries `deliveryGate: true`, and
`defect-evidence` and `candidate-regression` runs are the repair loop a `BLOCK` asks for.

**Engagement opt-ins.** Inside an Argus engagement, `ARGUS_ENVIRONMENT_RESET=execute` and
`ARGUS_FAULT_INJECTION=authorized` are requests, not permissions. The library locates the
engagement manifest the way `argus-assets` does, because `argus-launch` never exports
`ARGUS_ENGAGEMENT_MANIFEST`: a non-empty `ARGUS_ENGAGEMENT_MANIFEST`, the `engagement.json`
next to the launch receipt (`ARGUS_NATIVE_LAUNCH_RECEIPT`), and the first
`ai_agents_internal/engagement.json` at or above the physical harness root. A named
manifest that does not exist, or two sources that name different files, refuse the
opt-in. When the reset opt-in is set, before the environment gate (action
`destructive`, exclusive window `reset`), and when the fault opt-in is set, before any
native hook (action `chaos`, exclusive window `fault`), the library reads
`argus-assets engagement status` and requires the window to be held by the lane the
engagement manifest names as its owner (`resourcePolicy.exclusiveOperations`; a lock held by
any other lane, or a manifest that names no owner, refuses), then requires an
`allow` from `argus-assets authorization check` with `--lane "$ARGUS_ENGAGEMENT_LANE"`,
`--target` from `ARGUS_AUTHORIZATION_TARGET` (default `API_URL`, then `UI_URL`),
`--manifest` from `ARGUS_AUTHORIZATION_MANIFEST` (default `authorization.json` next to the
engagement manifest), `--source-trust` from `ARGUS_AUTHORIZATION_SOURCE_TRUST` (default
`manifest`), and, when set, `ARGUS_AUTHORIZATION_ACCOUNT`, `_NAMESPACE`, `_MUTATION`
(default `environment:reset` for a reset), `_RATE`, `_CONCURRENCY`, `_TOTAL_REQUESTS`, and
`_DURATION`. A missing CLI, lane, target, window, or decision refuses the run with
`environment policy denied environment-reset-unauthorized` or `fault-injection policy
denied fault-injection-unauthorized` (exit 13) before anything destructive starts. An
allowed fault opt-in exports `ARGUS_FAULT_INJECTION_GRANT` (the authorized lane) to the
native hooks, after the library has cleared any inherited value. Inside an engagement the
packaged fault injectors refuse a server fault without that grant as `prerequisite-missing`,
so a native run started with the opt-in but without the library never injects. The packaged
`PreToolUse` guard (`GUARD-ENGAGEMENT-OPT-IN`) admits a Bash command that names either opt-in
only as one standalone invocation of the engagement's `run-tests.sh` that sets
`ARGUS_ENGAGEMENT_LANE` to the calling lane and names no other engagement's manifests, and it
refuses every command that names `ARGUS_FAULT_INJECTION_GRANT`. Outside an engagement the
opt-in of the operator who owns the target stands. Only a window's manifest owner
(`resourcePolicy.exclusiveOperations`: `reset` Odysseus, `fault` Tyche) claims it, with
`argus-assets engagement claim --resource <reset|fault>`, and releases it after the run; the
lane that runs the suite sets `ARGUS_ENGAGEMENT_LANE` to its own slug.
