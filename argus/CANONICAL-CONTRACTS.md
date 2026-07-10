# Argus Canonical QA Contracts

This document assigns ownership for every machine-readable artifact introduced by the
engagement runtime. A role may propose data in an immutable fragment, but only the named
canonical owner can merge the document. The controller validates the schema and matching
`engagementId` before accepting a fragment.

## Contract registry

| Contract | Canonical path | Canonical owner | Required purpose |
|---|---|---|---|
| `argus/lane-plan@1` | `solution/lane-plan.json` | Odysseus | Lane phase, dependencies, expected outputs, audited state transitions. |
| `argus/bug-ledger@1` | `solution/bug-ledger.json` | Minos | Confirmed/suspected defects, stable bug IDs, severity, oracle, wiring, evidence links. |
| `argus/evidence-reference@1` | `solution/evidence-reference.json` | Kleio | Redacted evidence identity, source, integrity digest, collection metadata, defect links. |
| `argus/automation-status@1` | `solution/automation-status.json` | Atlas | Stable test ID, owner, runner result, covered bugs, evidence links. |
| `argus/runner-result@1` | `reports/argus-runner-result.json` | Atlas | Runner mode, strict gate status, standardized exit code, and separate outcome categories. |
| `argus/surface-inventory@1` | `solution/surface-inventory.json` | Kalchas | Discovered UI/API/event/data denominator, risk basis, accessibility, and discovery evidence. |
| `argus/coverage-observations@1` | `solution/coverage-observations.json` | Atlas | Execution, meaningful assertions, evidence, and defect outcomes linked to stable surface IDs. |
| `argus/coverage-result@1` | `solution/coverage-result.json` | Kleio | Traceable discovery, risk-weighted execution, assertion, evidence, scope, and defect-neutral calculations. |
| `argus/final-summary@1` | `solution/final-summary.json` | Kleio | Engagement outcome, counts, source contracts, final narrative. |

Every document has `schemaVersion: 1`, an exact `$schema` ID, and the active
`engagementId`. The generated human summary at `solution/FINAL-SUMMARY.md` is derived
only from `final-summary.json` and starts with its source schema ID.

## Field ownership and state transitions

| Record | Owner-controlled fields | Allowed state transitions | Evidence of transition |
|---|---|---|---|
| Lane plan | `lane`, `owner`, `phase`, `dependsOn`, `outputContracts`, `status`, `transitions` | `planned → running → completed`, or `planned/running → blocked` | Append-only transition record with `to`, `at`, `by`; phase barrier state remains in `engagement-state.json`. |
| Bug ledger | `id`, `origin`, `title`, `severity`, `priority`, `lane`, `oracleId`, `status`, `wired`, `testId`, `evidenceIds` | `needs-oracle → suspected → confirmed`; `wired: false → true` | Stable `BUG-NNNN` from Minos's identity allocation; oracle/test/evidence references. |
| Evidence reference | `id`, `kind`, `source`, `collectedBy`, `capturedAt`, `redaction`, `sha256`, `relatedBugIds` | Immutable after merge | Stable `EVD-NNNN`, redaction class, and SHA-256 of retained safe evidence. |
| Automation status | `testId`, `owner`, `runner`, `status`, `coversBugIds`, `evidenceIds`, `updatedAt` | `planned → implemented → passed/failed/skipped` | Stable `TST/REG-NNNN`, runner output reference, linked bugs/evidence. |
| Runner result | `mode`, `status`, `exitCode`, `categories`, `events` | Terminal `pass` or `fail` for one named mode | Raw adapter events classified by the portable evaluator. |
| Surface inventory | `items`, `discovery` | Discovery expands monotonically; accessibility changes require evidence | Stable `SRF-*` IDs, enumerated denominator dimensions, risk basis, and discovery evidence. |
| Coverage observations | `surfaceId`, `executed`, `assertions`, `evidenceIds`, `defects` | Append or replace one stable surface observation | Inventory link plus named oracle and evidence IDs. |
| Coverage result | `discovery`, `overall`, `lanes`, `scopedOutcomes`, `defectOutcomes` | Deterministically recalculated from canonical inputs | Exact input schema IDs and stable surface/evidence links; defect score contribution is always zero. |
| Final summary | `status`, `counts`, `runner`, `sourceSchemas`, `summary`, `generatedAt` | Terminal `completed`, `degraded`, or `blocked` | All linked source schemas, runner categories, and final barrier/merge evidence. |

Only the controller changes coordination state: worker allocation, barriers, exclusive
locks, checkpoint sequences, ID identity mappings, fragment records, and merge records.
Odysseus alone advances phase barriers; manifest-designated owners alone allocate a given
ID namespace or merge the corresponding canonical artifact.

## Compatibility and migration

The current reader/writer version is v1. It accepts only v1 documents and never guesses a
migration from a legacy array, Markdown, or unversioned JSON shape. A future version must:

1. add a new schema with valid and invalid fixtures;
2. preserve the previously installed schema while consumers migrate;
3. ship an explicit deterministic migration with a before/after fixture pair;
4. record the source version in generated human reports; and
5. update `policies/schema-compatibility.json` and this registry.

Run `argus-assets schema validate --kind <contract> --input <file>` before submitting a
structured fragment. Validation failure is a stop condition, not a warning.
