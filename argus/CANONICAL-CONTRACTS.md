# Argus Canonical QA Contracts

This document assigns ownership for every machine-readable artifact introduced by the
engagement runtime. A role may propose data in an immutable fragment, but only the named
canonical owner can merge the document. The controller validates the schema and matching
`engagementId` before accepting a fragment.

The complete machine-readable RACI, including non-schema artifacts and every state
transition, is `raci.json`; its generated human view is `RACI-CONTRACT.md`. Where this
document summarizes ownership, `scripts/sync-argus-raci.mjs --check` requires an exact
match with the engagement manifest.

## Contract registry

| Contract | Canonical path | Canonical owner | Required purpose |
|---|---|---|---|
| `argus/lane-plan@2` | `solution/lane-plan.json` | Odysseus | Deterministically ordered lane phases, dependencies, expected outputs, and audited state transitions. |
| `argus/bug-ledger@1` | `solution/bug-ledger.json` | Minos | Confirmed/suspected defects, stable bug IDs, severity, oracle, wiring, evidence links. |
| `argus/evidence-reference@2` | `solution/evidence-reference.json` | Kleio | Deterministically ordered redacted evidence identities, sources, integrity digests, collection metadata, and defect links. |
| `argus/automation-status@2` | `solution/automation-status.json` | Atlas | Deterministically ordered stable test IDs, owners, runner results, covered bugs, and evidence links. |
| `argus/runner-result@1` | `reports/argus-runner-result.json` | Atlas | Runner mode, strict gate status, standardized exit code, and separate outcome categories. |
| `argus/surface-inventory@1` | `solution/surface-inventory.json` | Kalchas | Discovered UI/API/event/data denominator, risk basis, accessibility, and discovery evidence. |
| `argus/coverage-observations@1` | `solution/coverage-observations.json` | Atlas | Execution, meaningful assertions, evidence, and defect outcomes linked to stable surface IDs. |
| `argus/coverage-result@1` | `solution/coverage-result.json` | Kleio | Traceable discovery, risk-weighted execution, assertion, evidence, scope, and defect-neutral calculations. |
| `argus/final-summary@1` | `solution/final-summary.json` | Kleio | Engagement outcome, counts, source contracts, final narrative. |

Every solution document has an exact `$schema` ID, its matching `schemaVersion`, and the
active `engagementId`; the runner-owned report has its exact schema/version and is bound
through the final summary. The generated human summary at `solution/FINAL-SUMMARY.md` is derived
only from `final-summary.json` and starts with its source schema ID.

Lane-plan, evidence-reference, and automation-status documents are multi-record
collections. Contributors may submit independently valid collection fragments; the named
owner merges them by stable key (`lane`, `id`, or `testId`). Duplicate keys fail closed,
and the canonical arrays are sorted by that key so fragment arrival order cannot change
the resulting bytes.

Argus 3 accepts only the current `@2` forms of these three collections. Their retired
single-record `@1` schemas and migrations are absent. Other solution contracts keep their
current version. Active older engagements must finish with their original runtime before
upgrading.

## Runtime report schema registry

`ai_agents_internal/preflight.json` is an immutable runtime report owned by Odysseus, not
a canonical solution fragment and never an input to `engagement fragment` or `engagement
merge`. New reports identify the actual writer schema URL
`https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/preflight-report.schema.json`
and `schemaVersion: 2`. The report-only reader accepts only v2 and exposes
`readCompatible=2` rather than inventing an `argus/<contract>@<version>` identity.

Run `argus-assets schema validate --kind preflight-report --input ai_agents_internal/preflight.json`
to validate the current report. Successful output includes the version and report-only
identity; an unknown or retired version fails closed.

`argus/model-escalation-request@1` is a controller-bound stop envelope, not a canonical
solution artifact. A worker returns it after persisting a monotonic checkpoint. Odysseus
validates its exact fields, current engagement/dispatch/attempt binding, declared signal,
and checkpoint state before opening a new attempt in a new thread. A pre-spawn
`model-unavailable` retry is the explicit exception: it uses the prior-decision/allocation
availability binding and may have no checkpoint because no worker thread began.

Model-control records are likewise runtime controls, not mergeable solution fragments.
`argus/model-decision@2` is the immutable selected/blocked route. Human frontier disposition uses
`argus/model-operator-decision@1` under the distinct operator trust purpose. Engagement
state v2 persists the exact decision binding on every current allocation.
`engagement start-attempt` consumes the current lane capability, atomically rotates it, and
returns the next token once; telemetry for the completed decision must precede that
transition. Codex routes are currently blocked because the CLI lacks a native hard turn cap;
signed metadata cannot override that capability result.

## Field ownership and state transitions

| Record | Owner-controlled fields | Allowed state transitions | Evidence of transition |
|---|---|---|---|
| Lane plan | `lanes[]`: `lane`, `owner`, `phase`, `dependsOn`, `outputContracts`, `status`, `transitions` | Per lane: `planned → running → completed`, or `planned/running → blocked` | Unique, sorted `lane`; append-only transition records with `to`, `at`, `by`; phase barrier state remains in `engagement-state.json`. |
| Bug ledger | `id`, `origin`, `title`, `severity`, `priority`, `lane`, `oracleId`, `status`, `wired`, `testId`, `evidenceIds` | `needs-oracle → suspected → confirmed`; `wired: false → true` | Stable `BUG-NNNN` from Minos's identity allocation; oracle/test/evidence references. |
| Evidence reference | `references[]`: `id`, `kind`, `source`, `collectedBy`, `capturedAt`, `redaction`, `sha256`, `relatedBugIds` | Each reference is immutable after merge | Unique, sorted `EVD-NNNN`, redaction class, and SHA-256 of retained safe evidence. |
| Automation status | `tests[]`: `testId`, `owner`, `runner`, `status`, `coversBugIds`, `evidenceIds`, `updatedAt` | Per test: `planned → implemented → passed/failed/skipped` | Unique, sorted `TST/REG-NNNN`, runner output reference, linked bugs/evidence. |
| Runner result | `mode`, `status`, `exitCode`, `categories`, `events` | Terminal `pass` or `fail` for one named mode | Raw adapter events classified by the portable evaluator. |
| Surface inventory | `items`, `discovery` | Discovery expands monotonically; accessibility changes require evidence | Stable `SRF-*` IDs, enumerated denominator dimensions, risk basis, and discovery evidence. |
| Coverage observations | `surfaceId`, `executed`, `assertions`, `evidenceIds`, `defects` | Append or replace one stable surface observation | Inventory link plus named oracle and evidence IDs. |
| Coverage result | `discovery`, `overall`, `lanes`, `scopedOutcomes`, `defectOutcomes` | Deterministically recalculated from canonical inputs | Exact input schema IDs and stable surface/evidence links; defect score contribution is always zero. |
| Model escalation request | `engagementId`, `dispatchId`, `attempt`, `agent`, `signal`, `checkpointRef`, `resumable` | Worker stops; controller validates, routes, records prior-attempt telemetry, and rebinds the active allocation with `engagement start-attempt`; it replaces the consumed token with the returned token before opening the next thread | `argus/model-escalation-request@1`, current engagement state, the prior selected decision, and the referenced monotonic checkpoint. Pre-spawn `model-unavailable` instead uses an availability binding. |
| Final summary | `status`, `counts`, `runner`, `sourceSchemas`, `summary`, `generatedAt` | Terminal `completed`, `degraded`, or `blocked` | All linked source schemas, runner categories, and final barrier/merge evidence. |

Only the controller changes coordination state: worker allocation, token generation,
immutable dispatchable projection, barriers, exclusive locks, checkpoint sequences, ID
identity mappings, fragment records, and merge records. Barrier participants are the
manifest phase members contained in that sealed projection; worker `success` cleanup
requires all of its declared arrivals. Heartbeat records bind progress to allocation,
dispatch, and attempt generation. Odysseus alone advances phase barriers;
manifest-designated owners alone allocate a given ID namespace or merge the corresponding
canonical artifact.

## Compatibility and migration

`policies/schema-compatibility.json` owns versions per contract. Contracts without an
override keep their current v1 definition. The three collection contracts and preflight
report accept only v2. Unknown, unversioned, or retired shapes fail closed.
A future version must:

1. add a new schema with valid and invalid fixtures;
2. preserve the previously installed schema while consumers migrate;
3. ship an explicit deterministic migration with a before/after fixture pair;
4. record the source version in generated human reports; and
5. update `policies/schema-compatibility.json` and this registry.

Run `argus-assets schema validate --kind <contract> --input <file>` before submitting a
canonical structured fragment. Validation failure is a stop condition, not a warning.
The same command has the explicitly separate `preflight-report` report-only reader described
above; successful validation does not make a report eligible for fragment submission or merge.
