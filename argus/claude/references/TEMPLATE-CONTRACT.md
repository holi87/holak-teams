# Argus Capability-Based Template Contract

This is the human view of `template-contract.json`. The JSON contract is authoritative;
the installed copy is `${CLAUDE_PLUGIN_ROOT}/capabilities/template-contract.json`.

## Detect, select, then scaffold

Run `argus-assets template detect --target <repo>` before any framework write. Detection
records languages, frameworks, test runners, package managers, existing source/test roots,
CI systems, confidence-bearing signals, and unsupported capabilities. It never invents a
`src/`, `tests/`, package-manager, or runner convention.

Selection requires an explicit operator choice. For an engagement the operator makes it on the
host, against the launch target path or the artifact root, and hands the record to the
launcher:

```bash
argus-assets template select --target <repo-or-artifact-root> --runtime <typescript|java|python> \
  --package-manager <npm|maven|pip> --test-root <path> --harness-root <path> \
  --output <operator-dir>/template-selection.json
argus-launch claude ... --template-selection <operator-dir>/template-selection.json
```

`argus-assets template verify` (read-only) and `template install` bind the record: a physical
file outside the target and artifact roots, schema- and contract-valid, whose `targetRoot`
names the target or the artifact root and whose `capabilitiesSha256` still matches that tree.
`install` copies the exact bytes to `<artifact-root>/ai_agents_internal/template-selection.json`
(mode 0600), never replaces a different record, and refuses once the engagement has started.
No agent writes that record, and the write guard denies both verbs inside an engagement.

Detected existing suites produce `action: adapt`; the target's framework, paths, package
manager, and CI entry point win, and `template scaffold` refuses to create a competing
harness. A greenfield target produces `action: build` only after runtime, package manager,
test root, and harness root are explicit and compatible. Scaffold consumes that selection,
copies into a new empty destination, and records the selection inside the generated framework.
Either root may keep, nest in, or swap the template's own `tests`/`src` (Java `src/test/java`)
roots; one that collides with another template path is refused.
Every shipped runner fails with policy exit 13 when that explicit selection record is
missing or names an incompatible runtime/package manager; low-level template copies are
not runnable engagement frameworks.

The installed template is a manifest-declared composition: one canonical common layer
(`templates/common`) plus exactly one runtime layer. Runtime layers never duplicate a
common file. `template scaffold` is the supported engagement interface and validates both
layer hashes before writing; it rejects symlinks, unsafe or case-colliding paths,
file/file and file/ancestor collisions, and non-empty destinations. The copy preserves
file and directory modes and creates each file exclusively. Maintainers edit
`framework-template-common/` for shared files, then run
`scripts/sync-argus-runtime-assets.mjs --write`; direct edits to generated common copies
inside the three complete source templates are drift.

## Shared minimum contract

All three templates implement the same four modes, `argus/runner-result@1`, seven-field
outcome events, category-specific exit codes, `reports/evidence/`, lane/regression/
quarantine/contract-smoke tags, no automatic retries, and an expiring quarantine ledger.
Framework-native selectors differ, but semantics do not. The native `regression` marker
is the only defect-test selection signal. A separate `@bug:<canonical-or-origin>` token
records provenance and lets the coverage gate join the test to
`solution/bug-ledger.json`; it never selects a runner mode. Every defect regression must
carry both markers.

`argus/template-contract@2` also pins the shared runner kit (`scripts/runner-lib.sh`,
`reports/test-inventory.tsv`, `reports/expected-bugs.txt`,
`reports/counterfactual-plan.tsv`, `reports/argus-adapter-status.txt`, and per-pass
artifacts below `reports/evidence/passes`), the evidence passes `live`, `repeat`,
`cf-correct`, and `cf-tamper`, the product lanes `api`, `ui`, `perf`, `security`, `db`,
and `resilience`, the harness lanes `contract-smoke` and `setup`, and each runtime's
outcome adapter, provenance marker, and lane marker. `RUNNER-CONTRACT.md` SD-1 to SD-7
define activation, case ids, inventory, the ledger join, classification, and product
events; SD-8 to SD-11 below define the target-owned declarations and markers.

`solution/quarantine.tsv` has five tab-separated fields with no header:
`case_id`, `owner`, safe reason token, ISO `expires_on`, and issue token. A quarantined
test is excluded only while a matching non-expired record exists; every valid entry emits
an approved skip. Missing, malformed, unowned, or expired entries are policy failures.
Quarantine is forbidden for regression tests (`quarantine.forbiddenFor`): a quarantined
regression is a policy failure, never an approved skip.

## Supported and unsupported capabilities

The shipped build adapters are intentionally finite: Playwright/TypeScript with npm,
JUnit 5 with Maven, and pytest with pip/venv. Detection still recognizes pnpm, Yarn, Bun,
Gradle, uv, Poetry, Jest, Vitest, TestNG, unittest, and other languages. Those are reported
as explicit adaptation requirements, never silently converted to a supported tool. Add a
template-specific adapter at the named extension point; do not duplicate shared doctrine.

## ADAPT: the runner kit

An `action: adapt` selection never scaffolds. To port the shared runner into the detected
suite, copy the runtime's runner kit into an empty staging directory:

```bash
argus-assets copy-runner-kit <typescript|java|python> <empty-destination>
```

`templates.<runtime>.runnerKit` lists the kit as composed-template relative paths. An entry
ending in `/` selects every file below that directory; any other entry names exactly one
file; there are no other globs. Every kit carries the shared runner (`scripts/runner-lib.sh`,
`runner-contract.sh`, `outcome-event.sh`, `quarantine-contract.sh`, `lane-plan.sh`, and the
environment, inventory, and evidence gates) and the target-owned declarations
(`solution/test-lanes.tsv`, `solution/environment.tsv`, `solution/quarantine.tsv`,
`solution/counterfactual/`). Each runtime adds its outcome adapter, runner-kit support
package, oracle library, and oracle self-tests:

| Runtime | Adds |
|---|---|
| TypeScript | `scripts/argus-playwright-reporter.mjs`, `src/argus/`, `src/oracles/`, the three `tests/contract/oracles-*.selftest.spec.ts`, `tests/contract/fixtures/` |
| Java | under `src/test/`: `java/qa/support/argus/`, `java/qa/support/oracles/`, `java/qa/support/CreatedResources.java`, the three `java/qa/contract/Oracles*SelfTest.java`, `resources/openapi.selftest.json`, `resources/META-INF/services/`, `resources/junit-platform.properties` |
| Python | `src/qa/argus_plugin.py`, `src/qa/argus/`, `src/qa/oracles/`, the three `tests/contract/test_oracles_*_selftest.py`, `tests/contract/fixtures/` |

The command validates both template layers, fails with `runner kit entry missing: <entry>`
when an entry selects no composed file, and refuses a non-empty or symlinked destination,
all before it writes. The copy keeps the composed layout and every byte and file mode, and
it passes the active-engagement write guard like `copy-template`.

The kit is not a runnable framework. Port each file into the existing suite's test and
harness roots, rewrite imports for those roots, wire the adapter into the suite's own
runner, and declare the libraries the kit imports in the suite's manifest (`copy-template`
shows the reference versions). The ported `scripts/runner-lib.sh` still requires the
ADAPT selection record at `ai_agents_internal/template-selection.json` and a suite entry
point that sets `ARGUS_RUNTIME`, `ARGUS_PACKAGE_MANAGER`, and `TEST_ROOT` and defines the
four `argus_native_*` hooks; the scaffold's `run-tests.sh` is the reference. The TypeScript
kit ships its counterfactual activation, and the port must wire it: the suite's `test`
extends `counterfactualTest` (`src/argus/playwright-fixtures.ts`); every API client resolves
its base URL at call time through `counterfactualApiURL()` (`src/argus/api-url.ts`), falling
back to the target URL, never from a constant captured at module load; and a ui lane is a
project named `ui` or `ui-<variant>` whose API calls match `ARGUS_API_ROUTE_PATTERN`
(default `<API_URL>/**`). A `cf-*` verdict of a regression that never ran through the
activation is `counterfactual-not-activated`, and one whose subject exchange the stub never
served is `counterfactual-subject-not-served`. The kit relies
on seams it does not ship: Java's
`qa.support.Config` (target URL), `qa.support.SchemaOracle` (one contract self-test), and
the `qa.support.SummaryListener` line of the launcher service file; Python's
`qa.schema_oracle` (one contract self-test) and the root-conftest
`pytest_plugins = ["qa.argus_plugin"]` registration. Map each seam to the suite's
equivalent or remove the reference; never leave one dangling.

Counterfactual passes need the kit's in-test wiring. The Java and Python adapters fail
closed without it: a pass or assertion verdict counts only for the variant the wiring loaded
for that test, and any other is an adapter failure. Java's
`ArgusCounterfactualExtension` runs only with
`junit.jupiter.extensions.autodetection.enabled=true`; merge that key from the kit's
`junit-platform.properties` into the suite's own file, because JUnit reads only one.
Python's `qa.argus_plugin` carries the `_argus_stub` and `_argus_counterfactual` fixtures, so
registering the adapter registers them. In every runtime the suite's API clients must use
`ARGUS_COUNTERFACTUAL_API_URL` (Java `argus.counterfactual.apiUrl`) as their base URL during
a `cf-*` pass, and a ui-lane test needs the browser route to the stub.

## Template contract v2 declarations (SD-8 to SD-11)

These sections are normative for `argus/template-contract@2`. SD-1 to SD-7 live in
`RUNNER-CONTRACT.md`. A safe token below matches `^[A-Za-z0-9_.:-]+$`.

### SD-8 Lane plan

`solution/test-lanes.tsv` has 5 tab-separated fields; `#` starts a comment. Each product
lane (`api`, `ui`, `perf`, `security`, `db`, `resilience`) appears exactly once.

| Field | Values |
|---|---|
| `lane` | one product lane |
| `state` | `enabled` or `disabled` |
| `owner` | `^[a-z][a-z0-9-]*$` |
| `prerequisites` | `-`, or comma-separated environment variable names matching `^[A-Z][A-Z0-9_]*$` |
| `reason` | a safe token, required when `disabled`; `not-yet-planned` means undecided |

A disabled lane is removed from native selection, never skipped at runtime. Tests never
self-skip on prerequisites: a missing prerequisite of an enabled lane is a runner-level
gate outcome, not a skipped test.

### SD-9 Environment

`solution/environment.tsv` has 3 tab-separated fields; `#` starts a comment. It holds
exactly one `reset` row and one `verify` row.

| Field | Values |
|---|---|
| `kind` | `reset` or `verify` |
| `command` | `-`, or a path matching `^scripts/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*[.]sh$` that exists and is executable; it runs without arguments and is never `eval`'d |
| `note` | a safe token; `not-yet-planned` means undecided |

Reset runs only with `ARGUS_ENVIRONMENT_RESET=execute`. It is a `destructive` target
action: inside an engagement the calling lane (`ARGUS_ENGAGEMENT_LANE`) needs its own
`destructive` authorization allow, and the exclusive reset window must be held by its
manifest owner, Odysseus (see `RUNNER-CONTRACT.md`, engagement opt-ins). Verify is
read-only.

### SD-10 Counterfactual fixture

`solution/counterfactual/BUG-NNNN.json` proves that a regression distinguishes correct
from defective behaviour without contacting the target. It carries `$schema`
`argus/counterfactual-fixture@1`, `schemaVersion` 1, `bugId`, and then exactly one of two
shapes.

- Fixture: `oracle` `{kind: requirement | contract | justified-invariant, sourceRef}`; an
  optional `contract` `{operationId, status}`; `exchanges`, each
  `{id: ^[a-z0-9-]{1,40}$, request: {method (uppercase), path (starting with "/"),
  optional query map}, response: {status, headers (lowercase names), body}}`; `subject`
  (an exchange id); and `tampers` `[{id, response}]` with at least one entry, unique ids,
  and a required `observed-defect` tamper. A tamper replaces the subject response
  entirely.
- Exemption: `exemption` `{reason, justification}` where `reason` is one of
  `front-end-logic`, `timing-or-load`, `data-layer`, `fault-injection`, or
  `non-http-protocol`, and `justification` has 1 to 500 characters.

`schemas/counterfactual-fixture.schema.json` encodes both shapes. The tamper id `correct`
is reserved, because `.cf-correct` already names the correct pass. The loaders also require
`bugId` to equal the file name, unique exchange and tamper ids, and a `subject` that names an
exchange. With `contract`, the correct subject response must have `contract.status` and pass
the strict schema oracle for `contract.operationId`. That oracle, in every runtime, reads the
`responses` key for the exact status, else its `1XX`..`5XX` range, else `default` (OpenAPI
3.x), and a status none of them covers is RED. A range or `default` key only selects the
schema: the status oracles still assert one exact code. Files named `*.example.json` are never
loaded.

Matching compares method and path exactly, plus any listed query parameters. An
unmatched request gets `501 {"argusStub": "unmatched"}` and raises
`ArgusCounterfactualError`.

The inventory pass writes `reports/counterfactual-plan.tsv`: one row per expected bug with
4 tab-separated fields.

| Field | Values |
|---|---|
| `bug_id` | canonical `BUG-NNNN` |
| `status` | `fixture`, `exempt`, `missing`, or `invalid` |
| `tamper_ids` | comma-separated tamper ids, or `-` |
| `reason` | the exemption reason; for `invalid` one of `schema-invalid`, `missing-observed-defect`, or `correct-violates-contract`; otherwise `-` |

### SD-11 Markers

| Runtime | Provenance | Lane | Repetition (SD-6) |
|---|---|---|---|
| TypeScript | tag `@bug:<token>` | the Playwright project | tag `@repetition:<n>` |
| Java | `@Tag("bug:<token>")` | exactly one lane `@Tag("<lane>")` | `@Tag("repetition:<n>")` |
| Python | `@pytest.mark.bug("<token>")` | exactly one lane marker (`contract_smoke` maps to `contract-smoke`) | `@pytest.mark.repetition(<n>)` |

Each regression test carries exactly one provenance token. The repetition marker is
optional, at most one per test, and absent means `n = 1`; it is the only place a test
declares repetition and never enables a runner retry. The `contract-smoke` lane runs only
under `ARGUS_CONTRACT_SMOKE=1`, and then exclusively. The `setup` lane is harness-only.
