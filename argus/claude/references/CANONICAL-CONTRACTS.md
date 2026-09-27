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
| `argus/bug-ledger@2` | `solution/bug-ledger.json` | Minos | Every defect candidate with its status (`confirmed`, `suspected`, `needs-oracle`, `bounced`, `quarantined`, `duplicate`, `rejected`), stable bug IDs, severity, oracle, wiring, causal merges, and evidence links. |
| `argus/evidence-reference@3` | `solution/evidence-reference.json` | Kleio | Deterministically ordered redacted evidence identities, kinds and media types, sources, integrity digests, collection metadata, second-agent reviews of binary captures, and defect and surface links. |
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

Argus 5 accepts only the current forms of these three collections: lane-plan and
automation-status `@2`, evidence-reference `@3`. The retired single-record `@1` schemas,
`argus/evidence-reference@2`, and their migrations are absent. Other solution contracts keep their
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
and checkpoint state before opening a new attempt in a new thread. Its signal enum lists
only worker-declared signals: the controller-observed `no-artifact` and `zero-candidates`
outcomes can never appear in a worker envelope. Two retries carry no checkpoint. A
pre-spawn `model-unavailable` retry uses the prior-decision/allocation availability binding
because no worker thread began. A controller-observed outcome (or an uncheckpointed
turn-limit) uses an outcome binding to the same prior decision and allocation, which also
records the accountable artifacts the controller observed.

Model-control records are likewise runtime controls, not mergeable solution fragments.
`argus/model-decision@3` is the immutable selected/blocked route under
`argus/model-policy@2`. Every decision carries exactly the lineage its route needs:
`escalationBinding` (a worker envelope with a non-null checkpoint reference and digest),
`availabilityBinding` (with `priorUnavailableRetries`), or `outcomeBinding` (with
`priorCheckpointlessRetries` and `observedArtifacts`). A selected automatic route
(`AUTO_CONTINUE_SELECTED` or `BACKOFF_RETRY_SELECTED`) also records a `continuation` with
its kind (`checkpoint-resume`, `fresh-restart`, or `backoff-retry`), sequence, per-attempt
native turn cap, cumulative turn budget, and backoff seconds; every other decision records
`continuation: null`. `AUTO_CONTINUATION_EXHAUSTED` blocks without an operator escalation.
Human frontier disposition uses `argus/model-operator-decision@1` under the distinct
operator trust purpose. Engagement state v3 persists the exact decision binding on every
current allocation. `engagement start-attempt` consumes the current lane capability,
atomically rotates it, and returns the next token once; telemetry for the completed
decision, `argus/model-telemetry-event@3`, must precede that transition. Codex routes are
currently blocked because the CLI lacks a native hard turn cap; signed metadata cannot
override that capability result.

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
| Bug ledger | `id`, `origin`, `title`, `severity`, `priority`, `lane`, `oracleId`, `status`, `wired`, `testId`, `evidenceIds`, `verification`, `merge`, `missingProof`, `repair`, `duplicateOf`, `rejection`, `quarantine` | `candidate → bounced/needs-oracle/suspected/confirmed`; `bounced → needs-oracle/suspected/confirmed`; `needs-oracle → suspected → confirmed`; `confirmed → quarantined → confirmed/suspected`; `suspected/needs-oracle → rejected`; `suspected/needs-oracle/confirmed → duplicate`; `wired: false → true` | Stable `BUG-NNNN` from Minos's identity allocation; oracle/test/evidence references. The canonical merge also quarantines any row whose cited evidence fails reconciliation. |
| Evidence reference | `references[]`: `id`, `kind`, `mediaType`, `source`, `collectedBy`, `capturedAt`, `redaction`, `sha256`, `relatedBugIds`, `relatedSurfaceIds`, and `review` exactly on binary kinds | Each reference is immutable after merge; a binary reference is registered only in its reviewer's own fragment | Unique, sorted `EVD-NNNN`, redaction class, SHA-256 of retained safe evidence re-checked at every merge, and for binary captures the reviewer plus the collector's audited `binary-evidence` allow timestamp. |
| Automation status | `tests[]`: `testId`, `owner`, `runner`, `status`, `coversBugIds`, `evidenceIds`, `updatedAt` | Per test: `planned → implemented → passed/failed/skipped` | Unique, sorted `TST/REG-NNNN`, runner output reference, linked bugs/evidence. |
| Runner result | `mode`, `status`, `exitCode`, `categories`, `events` | Terminal `pass` or `fail` for one named mode | Raw adapter events classified by the portable evaluator. |
| Surface inventory | `items`, `discovery` | Discovery expands monotonically; accessibility changes require evidence | Stable `SRF-*` IDs, enumerated denominator dimensions, risk basis, and discovery evidence. |
| Coverage observations | `surfaceId`, `executed`, `assertions`, `evidenceIds`, `defects` | Append or replace one stable surface observation | Inventory link plus named oracle and evidence IDs. |
| Coverage result | `discovery`, `overall`, `lanes`, `scopedOutcomes`, `defectOutcomes` | Deterministically recalculated from canonical inputs | Exact input schema IDs and stable surface/evidence links; defect score contribution is always zero. |
| Model escalation request | `engagementId`, `dispatchId`, `attempt`, `agent`, `signal`, `checkpointRef`, `resumable` | Worker stops; controller validates, routes, records prior-attempt telemetry, and rebinds the active allocation with `engagement start-attempt`; it replaces the consumed token with the returned token before opening the next thread | `argus/model-escalation-request@1`, current engagement state, the prior selected decision, and the referenced monotonic checkpoint. The signal is worker-declared only; `no-artifact` and `zero-candidates` are invalid here. Pre-spawn `model-unavailable` instead uses an availability binding, and a controller-observed outcome uses an outcome binding. |
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

`policies/schema-compatibility.json` (policy `schemaVersion` 4) owns versions per
contract. Contracts without an override stay at v1. Every override accepts exactly its
current version: lane-plan, automation-status, and the bug ledger read only v2, and
evidence-reference and the preflight report read only v3. The runtime loads the policy against one table of expected
contract versions and refuses to start when an override is missing, drifts, or names an
unknown contract.

Argus 5 reads only current versions. Unknown, unversioned, or retired shapes, including an
`argus/bug-ledger@1` document, fail closed; there is no in-place migration of an active
engagement's artifacts. A 4.x engagement finishes on the 4.9.x runtime that started it.
A future version must:

1. add a new schema with valid and invalid fixtures;
2. bump its row in the expected-version table and in `policies/schema-compatibility.json`
   in the same change, and move every packaged consumer and fixture to it;
3. state in the release notes that the retired version fails closed;
4. record the source version in generated human reports; and
5. update this registry.

Run `argus-assets schema validate --kind <contract> --input <file>` before submitting a
canonical structured fragment. Validation failure is a stop condition, not a warning.
The same command has the explicitly separate `preflight-report` report-only reader described
above; successful validation does not make a report eligible for fragment submission or merge.

## Finding quality and case depth in 4.9.1

The release repairs previously permissive validation of the existing proof requirements. A `confirmed` ledger entry now needs nonempty evidence and `verification`: build identity, a conditional sourced oracle (kind/sourceRef/evidenceId/applicability/exceptions), reproduction (initialState/steps/attempts/occurrences/evidenceIds), disputedOracle, and independent verification (status/executor/evidenceIds/reason). Multiple origin IDs require a causal merge (in bug-ledger@2, `merge.causalEvidence`). Hypotheses cannot confirm defects. Intermittent reproduction may record fewer occurrences than attempts; never fabricate a second success.

Critical/Blocker or disputed-oracle findings require either a different executor's independently collected reproduction evidence, or an explicit unavailable limitation. Unavailable independence is reported honestly and does not invent an independent pass. Similar class/entity keys identify related candidates, not proven identical causes. The same requirement applies to an intermittent (occurrences < attempts) or single-attempt (attempts = 1) confirmation: validation rejects its `not-required` independent status.

Hunters submit immutable evidence-reference fragments as they collect proof. Minos validates those digest-bound contributions when merging the ledger; he does not wait for Kleio's later final registry merge. A foreign engagement registry fails the merge; since 5.0 an unresolved, changed, missing, or out-of-boundary evidence file quarantines the rows that cite it (see "Bug ledger v2 in 5.0"). The oracle citation and runtime proof must be archived as redacted evidence inside the boundary; a remote URL alone is not a reproducible proof artifact.

Never auto-fill historical proof. The 4.9.1 patch kept contract identifiers at their versions because it enforced documented validity requirements; Argus 5 replaces the ledger identity with `argus/bug-ledger@2`, so a 4.x ledger is finished on 4.9.x rather than resumed.

Mode B without funded automation can use `runner: null` in its final summary with zero automated tests. Other modes cannot merge a null runner. The rendered report explicitly says no framework runner was executed.

## Bug ledger v2 in 5.0

`argus/bug-ledger@2` records every defect candidate Minos triages, not only confirmed ones.
Each status carries its own block:

| Status | Required block | Meaning |
|---|---|---|
| `confirmed` | `verification`, non-empty `evidenceIds`, string `oracleId` | Proven defect; the only status that may be wired to a regression (`wired`, `testId`). |
| `suspected` | `missingProof` {`elements`, `detail`, `owner`}, string `oracleId` | Likely defect; `detail` states what would confirm it. Without evidence, `elements` includes `evidence`. |
| `needs-oracle` | `missingProof` whose `elements` include `oracle`, `oracleId: null` | Observed behavior with no cited oracle yet; routed to the oracle desk. |
| `bounced` | `repair` {`round` 0–3, `missing`, optional `assignedTo`, `note`} | Returned to its lane for a proof repair round. |
| `quarantined` | `quarantine` {`reasons`} | Frozen by an integrity failure; it keeps its submitted blocks and never counts as confirmed. |
| `duplicate` | `duplicateOf`, `merge`, string `oracleId` | Same cause as a live row (`confirmed`, `suspected`, `needs-oracle`, or `quarantined`); never another duplicate or itself. |
| `rejected` | `rejection` {`reason`, `rationale`, `evidenceIds`} | Not a defect; evidence is required unless the reason is `out-of-scope`. |

`missingProof`, `rejection`, `duplicateOf`, and `quarantine` are valid only on their own
status, `repair` never on a confirmed row, and a justified-invariant oracle names its
`invariantClass` (`server-error`, `crash`, `data-loss`, `authz-breach`, or
`layer-disagreement`), which no other oracle kind may carry. Every origin ID belongs to one
row. A row with several origins, and every duplicate, carries `merge` {`rationale`,
`causalEvidence`}: one entry per origin (plus the duplicate target) with its own disjoint
evidence IDs; it replaces the 4.x `verification.mergeRationale`.

The canonical merge reconciles every row's cited evidence (row, proof, merge, and rejection
IDs) against the digest-bound evidence fragments. A merge across lanes must cite evidence
collected by each merged lane, and an independent executor may not be the collector of the
reproduction evidence it re-checks. A foreign registry, a tampered ledger fragment, or a
tampered evidence fragment still fails the merge. Any other failure is per row: the merge
sets that row to `quarantined` with the failures as `quarantine.reasons`, re-validates the
document, records the quarantined IDs in the merge record, and snapshots the post-quarantine
ledger. The immutable fragment keeps the submitted status, so restoring the evidence and
merging again restores it.

## Evidence reference v3 in 5.0

`argus/evidence-reference@3` stays a collection keyed by `id`. Every reference names its
`kind`, its `mediaType`, and the `relatedSurfaceIds` (`SRF-*`) it proves beside the related
bug IDs. The schema fixes the media types per kind:

| Kind | Media types | Redaction |
|---|---|---|
| `text` | `text/plain`, `text/markdown` | `redacted`, `synthetic`, `public` |
| `http` | `text/plain`, `application/json`, `message/http` | `redacted`, `synthetic`, `public` |
| `har` | `application/json` | `redacted`, `synthetic`, `public` |
| `metric` | `text/plain`, `application/json`, `text/csv` | `redacted`, `synthetic`, `public` |
| `log` | `text/plain`, `application/json`, `application/x-ndjson` | `redacted`, `synthetic`, `public` |
| `dom-snapshot` | `text/html`, `application/xhtml+xml`, `text/yaml` | `redacted`, `synthetic`, `public` |
| `runner-result` | `application/json` | `redacted`, `synthetic`, `public` |
| `trace` | `application/json`, `text/plain` | `redacted`, `synthetic`, `public` |
| `trace` | `application/zip` (binary) | `masked`, `synthetic` |
| `screenshot` | `image/png`, `image/jpeg`, `image/webp` (binary) | `masked`, `synthetic` |
| `video` | `video/webm`, `video/mp4` (binary) | `masked`, `synthetic` |

A binary reference, and only a binary reference, carries `review` {`reviewer`,
`reviewedAt`, `method` (`region-mask` or `synthetic-content`), `auditTimestamp`}. The
reviewer differs from `collectedBy`, reviews no earlier than the capture, and
`auditTimestamp` is no later than the capture. The fragment that registers a binary
reference must be written under the reviewer's own lane lease; the collector's fragment is
refused. See `AUTHORIZATION-POLICY.md` section 5 for the capture and review procedure.

Every merge that reads evidence re-validates the retained bytes after the digest check:

- binary media must start with the signature of its declared media type (PNG, JPEG, WebP,
  WebM, MP4 `ftyp`, or ZIP);
- textual evidence must not be binary and must be a fixed point of the packaged redactor,
  applied as `argus-assets redact` applies it: JSON by value (each NDJSON line for
  `application/x-ndjson`), any other text by pattern;
- a HAR must hold `log.entries`, and every `Authorization`, `Proxy-Authorization`,
  `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token`, and `X-XSRF-Token`
  header, every cookie value, and every `token`, `access_token`, `api_key`, `apikey`, or
  `session` query parameter must hold a `[REDACTED...]` placeholder;
- an HTML DOM snapshot must not contain a password input with a non-empty value; and
- a runner result must satisfy `argus/runner-result@1` and its category semantics.

Kleio's registry merge applies these checks to every reference and also requires, for each
binary reference, one `allow` event for `binary-evidence` in the authorization audit named
by `ai_agents_internal/authorization.json` (`audit.path`, default
`authorization-audit.jsonl`) with this engagement, `lane == collectedBy`, and
`timestamp == review.auditTimestamp`. Any failure aborts that merge with `evidence registry
verification failed`. Minos's ledger merge applies the same checks, including the reviewer
registration and the audit binding, to the evidence each row cites; a failure there
quarantines the citing rows. Case-depth coverage re-validates the content of the evidence
its cases cite.
