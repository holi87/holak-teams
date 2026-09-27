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
| `argus/coverage-observations@1` | `solution/coverage-observations.json` | Kleio | Execution, meaningful assertions, evidence, and defect outcomes linked to stable surface IDs. |
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

`argus/native-launch-authorization@1` is the externally signed, five-minute maximum
launcher request and authorization. `argus/native-launch-receipt@1` is the verifier-owned
receipt under `ai_agents_internal/`. Both bind the engagement, target kind and identity,
workspace, artifact root, runtime/model/effort/turn cap, launcher and Claude hashes,
sandbox and environment policy, runtime trust key, and inherited launch-capability digest.
The signed sandbox probe also binds its physical device, inode, owner, and `0700` mode;
preflight requires that exact empty directory to become non-writable while the artifact root
remains writable.
They are runtime controls, never solution fragments. The signer owns only the signature;
the launcher owns request coordinates, and `argus-assets launch verify` owns the receipt.
Any field drift, stale time, revoked key, unsafe path, missing supervisor at verification,
or absent inherited capability fails closed.

`ai_agents_internal/preflight.json` is an immutable runtime report owned by Odysseus, not
a canonical solution fragment and never an input to `engagement fragment` or `engagement
merge`. New reports identify the actual writer schema URL
`https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/preflight-report.schema.json`
and `schemaVersion: 3`. The report-only reader accepts only v3 and exposes
`readCompatible=3` rather than inventing an `argus/<contract>@<version>` identity.
Every v3 agent record carries `stopsEngagement`. A blocked Odysseus, essential lane
(`essentialLanes` in the orchestration plan), or mandatory lane of the mode stops the
engagement; any other blocked lane is recorded as `deferred` with `downgradedFrom=blocked`
and is never dispatched. `summary.downgraded` counts those lanes, and `residualRisks` names
every selected lane that is not `ready` or `degraded`.

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

## Recon capability evidence

`argus/capability-evidence@1` at `solution/discovery/capability-evidence.json` records
Kalchas's verdict on each recon-provable target gate. Kalchas is its single writer by RACI
and writes it directly under the allowed `solution/discovery` artifact root. Like
`solution/discovery/contract-drift.json`, it is non-canonical: never an `engagement fragment`
input and never merged. Its consumer is `argus-assets engagement resolve-gates`, the
conditional-lane gate resolver, which validates the file and its `engagementId` and treats
every verdict as recon evidence to re-check, not as authority.

The document holds exactly one gate for each capability-matrix capability of kind `target`.
Each gate has a verdict (`proven`, `absent`, or `unverified`), a summary, and `EVD-NNNN`
evidence IDs. `proven` requires at least one evidence ID and a proof whose `kind` matches
the capability:

| Capability | Proof kind | Proof fields |
|---|---|---|
| `db-access` | `db-select` | `client`, `host`, `port`, `database`, and the `observed` result of a read-only `SELECT 1` |
| `source-access` | `source-root` | absolute `path`, `language`, and an absolute `fileRead` inside `path` |
| `existing-suite` | `suite-root` | absolute `path`, `runner`, and an absolute `testFile` inside `path` |
| `non-rest-surface` | `protocol-surface` | `protocols` (`graphql`, `grpc`, `websocket`, `sse`, `messaging`, `webhook`) and surface-inventory `surfaceIds` |
| `multi-service` | `service-map` | two or more `services`, each `{name, origin}`, with distinct names and origins |

The file carries no secrets. Every proof shape is closed, the `db-select` proof has no field
that can hold a password, and database hosts and service origins reject `user:password@`
credentials. Keep credentials, tokens, and connection strings out of `summary` and
`observed` as well. Validate before writing with
`argus-assets schema validate --kind capability-evidence --input <file>`.

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
immutable dispatchable projection, barriers, recorded phase skips, exclusive locks,
checkpoint sequences, ID identity mappings, fragment records, merge records, and ledger
snapshots. Barrier participants and standby lanes are the members of the manifest's derived
phase plan contained in that sealed projection; worker `success` cleanup waits until no
participant or standby phase is pending. Heartbeat records bind progress to allocation,
dispatch, and attempt generation. Odysseus alone advances phase barriers and records
deep-hunt skips; a proof phase advances only after Minos's bug-ledger merge records its
snapshot. Manifest-designated owners alone allocate a given ID namespace or merge the
corresponding canonical artifact.

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

## Finding quality and case depth in 4.9.1

The release repairs previously permissive validation of the existing proof requirements. A `confirmed` ledger entry now needs nonempty evidence and `verification`: build identity, a conditional sourced oracle (kind/sourceRef/evidenceId/applicability/exceptions), reproduction (initialState/steps/attempts/occurrences/evidenceIds), disputedOracle, and independent verification (status/executor/evidenceIds/reason). Multiple origin IDs require a causal mergeRationale. Hypotheses cannot confirm defects. Intermittent reproduction may record fewer occurrences than attempts; never fabricate a second success.

Critical/Blocker or disputed-oracle findings require either a different executor's independently collected reproduction evidence, or an explicit unavailable limitation. Unavailable independence is reported honestly and does not invent an independent pass. Similar class/entity keys identify related candidates, not proven identical causes. The same requirement applies to an intermittent (occurrences < attempts) or single-attempt (attempts = 1) confirmation: validation rejects its `not-required` independent status.

Hunters submit immutable evidence-reference fragments as they collect proof. Minos validates those digest-bound contributions when merging confirmed findings; he does not wait for Kleio's later final registry merge. The merge rejects unresolved, changed, missing, or out-of-boundary files and foreign engagement registries. The oracle citation and runtime proof must be archived as redacted evidence inside the boundary; a remote URL alone is not a reproducible proof artifact.

Existing unconfirmed records remain readable. When resuming a pre-4.9.1 ledger, supply real verification evidence before confirming; otherwise keep it suspected or finish it with the original runtime. Never auto-fill historical proof. Contract identifiers stay at their current versions because this patch enforces documented validity requirements and adds optional depth fields rather than replacing artifact identities.

Mode B without funded automation can use `runner: null` in its final summary with zero automated tests. Other modes cannot merge a null runner. The rendered report explicitly says no framework runner was executed.
