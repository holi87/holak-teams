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
| `argus/automation-status@2` | `solution/automation-status.json` | Atlas | Deterministically ordered stable test IDs, owners, runner results, covered bugs, evidence links, and the runner case IDs and surfaces each test maps. |
| `argus/runner-result@1` | `reports/argus-runner-result.json` | Atlas | Runner mode, strict gate status, standardized exit code, and separate outcome categories. |
| `argus/surface-inventory@1` | `solution/surface-inventory.json` | Kalchas | Discovered UI/API/event/data denominator, risk basis, accessibility, and discovery evidence. |
| `argus/coverage-observations@2` | `solution/coverage-observations.json` | Kleio | Deterministically ordered per-lane observations keyed by `<lane>:<surfaceId>`: cited execution (runner-result evidence with a `caseId`, or a direct capture that names the surface), assertion and control, outcome, and case evidence plus ledger defect references; no `executed`, `meaningful`, or `defects` flag exists, so execution and assertion quality are derived, never declared. |
| `argus/coverage-result@2` | `solution/coverage-result.json` | Kleio | Traceable discovery, evidence-derived per-surface flags (`executed`, `asserted`, `evidenced`, `automated`), risk-weighted execution, assertion, evidence, and automated-execution ratios, unexecuted critical surfaces, the automation-status runner-case mapping state (`verified`, `unverified`, `not-applicable`), scope, and ledger-derived defect outcomes that never score. See `COVERAGE-CONTRACT.md`. |
| `argus/final-summary@2` | `solution/final-summary.json` | Kleio | Engagement outcome with sorted `statusReasons`, per-status bug counts with a confirmed + suspected headline, regression wiring, the likely-but-unproven findings, the automation-review verdict, the runner outcome, required surface-derived coverage, source contracts, and Kleio's narrative; the merge derives every fact. |
| `argus/automation-review@1` | `solution/automation-review.json` | Aristarchus | Append-only APPROVE/BLOCK review rounds (`REV-NN`), each bound to the digest of the test corpus it judged, with blockers, warnings, resolved blockers, uncovered confirmed bugs, and evidence commands. |

Every solution document has an exact `$schema` ID, its matching `schemaVersion`, and the
active `engagementId`; the runner-owned report has its exact schema/version and is bound
through the final summary. The generated human summary at `solution/FINAL-SUMMARY.md` is derived
only from `final-summary.json` and starts with its source schema ID.

Lane-plan, evidence-reference, automation-status, and coverage-observations documents are
multi-record collections. Contributors may submit independently valid collection fragments;
the named owner merges them by stable key (`lane`, `id`, `testId`, or `observationId`).
Automation-status tests and coverage observations are owned records: a test belongs to its
`owner` and an observation to its `lane`, and only that lane or the canonical's merging owner
(Atlas, Kleio) may write it, so a foreign record is refused when the fragment is written. A
later fragment of the same key (a higher write `sequence`) supersedes the earlier record, so a
lane updates a test status or re-records an observation in a later pass; a key never changes
owner. Lane-plan and evidence-reference records are immutable: a key repeated across
fragments fails closed. The canonical arrays are sorted by key so fragment arrival order
cannot change the resulting bytes.

Bug-ledger, surface-inventory, coverage-result, final-summary, and automation-review
documents are single documents. Only the registry owner submits their fragments, and a newer fragment (a higher
write `sequence`) supersedes the earlier ones: the merge validates every fragment but
publishes only the latest. Each fragment must keep its contract's stability invariants
against the one it supersedes. The bug ledger keeps every earlier `BUG-NNNN` ID and each of
its earlier origins, so IDs stay stable once assigned while their status changes; the surface
inventory keeps every earlier `SRF-*` ID and never lowers `discovery.candidates`; the
automation review repeats every earlier round unchanged and only appends new rounds. Coverage
result and final summary carry no supersession invariant. See `ENGAGEMENT-POLICY.md`
"Canonical machine contracts".

Argus 5 accepts only the current forms of these four collections: lane-plan,
automation-status, and coverage-observations `@2`, evidence-reference `@3`. The retired
single-record `@1` schemas, `argus/evidence-reference@2`, and their migrations are absent.
`argus/coverage-result@1` is retired with them; coverage-result is read only at `@2`.
`argus/final-summary@1` is retired as well; the final summary is read only at `@2`.
Other solution contracts keep their current version. Active older engagements must finish
with their original runtime before upgrading.

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
| Automation status | `tests[]`: `testId`, `owner`, `runner`, `status`, `coversBugIds`, `evidenceIds`, `updatedAt`, optional `caseIds` and `surfaceIds` | Per test: `planned → implemented → passed/failed/skipped` | Unique, sorted `TST/REG-NNNN`, runner output reference, linked bugs/evidence. An `implemented`, `passed`, or `failed` test maps each of its runner `caseIds` to each of its `surfaceIds`; once merged, coverage credits a runner case only to a surface it maps. |
| Runner result | `mode`, `status`, `exitCode`, `categories`, `events` | Terminal `pass` or `fail` for one named mode | Raw adapter events classified by the portable evaluator. |
| Surface inventory | `items`, `discovery` | Discovery expands monotonically; accessibility changes require evidence | Stable `SRF-*` IDs, enumerated denominator dimensions, risk basis, and discovery evidence. |
| Coverage observations | `observations[]`: `observationId`, `lane`, `surfaceId`, `executions`, `assertions`, `evidenceIds`, `defectRefs`, `cases` | One record per lane and surface, written by that lane and superseded by its later fragment of the same `observationId` | Inventory link; every execution, assertion, control, outcome, and case citation resolves to a registered `EVD-NNNN`, every runner-result execution to an executed runner case (mapped to the surface by the merged automation status), and every defect reference to a ledger ID or origin. |
| Coverage result | `discovery`, `overall`, `lanes`, `surfaces`, `criticalUnexecuted`, `runnerCaseMapping`, `scopedOutcomes`, `defectOutcomes` | Deterministically recalculated from canonical inputs, including the merged automation status | Exact input schema IDs (inventory, observations, and the evidence registry and bug ledger when present) and stable surface/evidence links; `runnerCaseMapping` is `verified` only when a merged automation status mapped every credited runner case; defect score contribution is always zero. |
| Model escalation request | `engagementId`, `dispatchId`, `attempt`, `agent`, `signal`, `checkpointRef`, `resumable` | Worker stops; controller validates, routes, records prior-attempt telemetry, and rebinds the active allocation with `engagement start-attempt`; it replaces the consumed token with the returned token before opening the next thread | `argus/model-escalation-request@1`, current engagement state, the prior selected decision, and the referenced monotonic checkpoint. The signal is worker-declared only; `no-artifact` and `zero-candidates` are invalid here. Pre-spawn `model-unavailable` instead uses an availability binding, and a controller-observed outcome uses an outcome binding. |
| Final summary | Kleio: `status`, `summary`, `generatedAt`. Merge-derived and overwritten: `statusReasons`, `counts`, `unproven`, `held`, `automationReview`, `runner`, `coverage`, `sourceSchemas` | Terminal `completed`, `degraded`, or `blocked`, never better than the derived status ceiling | `headline` = confirmed + suspected; `unproven` lists exactly the suspected and needs-oracle rows and `held` the bounced and quarantined rows; `completed` carries no status reason; every fact re-derived from the merge-verified canonical inputs and `reports/argus-runner-result.json`. |
| Automation review | `reviews[]`: `reviewId`, `round`, `supersedes`, `verdict`, `reviewedAt`, `corpus`, `reviewedCommit`, `blockers`, `warnings`, `resolved`, `uncoveredConfirmedBugs`, `evidenceCommands` | `pending → approved/blocked`, `blocked → approved`, and `approved → blocked` when a stale corpus is re-reviewed; a published round never changes | Contiguous `REV-NN` rounds, each superseding its predecessor; `corpus.sha256` equals `argus-assets automation-review digest` at merge time; each round's `resolved` accounts for every blocker of the round before it. |

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
quarantines the citing rows. Kleio's coverage-result merge applies the digest, capture-time,
and content checks to every evidence ID the coverage inputs cite, including the inventory's
discovery evidence, and aborts on any failure.

## Automation review in 5.0

`argus/automation-review@1` at `solution/automation-review.json` persists Aristarchus's
verdicts. Aristarchus stays read-only on tests and the target and has no Write tool: he
submits each cumulative document as one inline single-line `engagement fragment --json`
object (no apostrophes, newlines, or `;&|>` characters, which the write guard refuses) and
merges it as the canonical owner. Every round in `reviews` carries:

- `reviewId` `REV-NN` and `round` equal to its suffix; rounds run contiguously from 1 and
  `supersedes` names the previous round (`null` only for round 1);
- `verdict` `BLOCK` if and only if `blockers` is non-empty; blockers and warnings are
  findings {`id` `ARB-NNN`, `file`, `line`, `category`, `pattern`, `consequence`,
  `ownerLane`, `direction`} whose IDs are unique across the whole document;
- `resolved`: for round 2 onward, exactly the previous round's blocker IDs, each with its
  `previousReviewId` and a `resolution`; a blocker that persists gets a new ID in the new
  round;
- `uncoveredConfirmedBugs`: a non-empty list requires an `uncovered-confirmed-bug` blocker;
- `reviewedAt` strictly later than the previous round, `reviewedCommit` (or `null`), and at
  least one `evidenceCommands` entry {`command`, `exitCode`, `outputSha256`};
- `corpus` {`sha256`, `fileCount`, `roots`} copied from `argus-assets automation-review
  digest --manifest <engagement.json>`.

The corpus roots are `testRoot` and `harnessRoot` from a valid
`ai_agents_internal/template-selection.json`, otherwise the existing directories among
`writePolicy.generatedTestRoots`, plus `run-tests.sh`, `scripts/`, the target-owned runner
declarations (`solution/test-lanes.tsv`, `solution/environment.tsv`, `solution/quarantine.tsv`,
`solution/counterfactual/`), Maven `src/test/resources/`, and the runner and dependency
configuration files at the artifact root (`playwright.config.*`, `package.json`,
`package-lock.json`, `tsconfig*.json`, `pyproject.toml`, `conftest.py`, `pytest.ini`,
`setup.cfg`, `tox.ini`, `requirements*.txt`, `pom.xml`), all resolved against the artifact
root. Path segments `node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, and
`.pytest_cache` and the packaged hunt-driver files under `scripts/` are excluded. Build and
report output (`reports/`, `test-results/`, `target/`) lives at the artifact root outside every
corpus root, so a test below an output-named directory such as `tests/api/reports/` stays in
the corpus. A symbolic link fails closed. `sha256` covers the sorted lines `<relative path>\0<file sha256>\n`, so any added,
removed, or edited corpus file changes it.

A newer fragment must repeat every earlier round unchanged, and the merge publishes only a
document whose latest round judged the current corpus. `argus-assets automation-review check
--manifest <engagement.json> [--emit-gate <path>] [--json]` reads the merged record, verified
against its merge digest, and exits 0 for `APPROVED` (the latest round APPROVEs the current
corpus) or `NOT-APPLICABLE` (Aristarchus is not dispatchable and nothing is merged). It exits
13 for `BLOCKED`, for `STALE` (an APPROVE whose corpus has since changed), and for `ABSENT`
(Aristarchus is dispatchable and nothing is merged), each requiring a new round. It exits 14
for an invalid manifest, state, review record, or corpus. `--emit-gate` writes
`verdict=<status>`, `reviewId=<id|->`, and `corpusSha256=<reviewed digest|->` lines through the
active-engagement write guard; it never writes a lease token.

## Final summary in 5.0

`argus/final-summary@2` at `solution/final-summary.json` is Kleio's canonical record, but Kleio
owns only its narrative (`summary`, `generatedAt`) and the status she proposes. She builds her
fragment from `argus-assets engagement report-facts --manifest <engagement.json> [--output
<json|->]`, which is read-only, takes no lease token, and prints the derived fields plus their
`statusCeiling`. The merge derives the same facts again, overwrites `counts`, `unproven`, `held`,
`automationReview`, `runner`, `coverage`, `sourceSchemas`, and `statusReasons`, and sets the
status to the worse of Kleio's status and the ceiling (`completed` < `degraded` < `blocked`); it
never raises a status. Because Kleio may supersede her fragment, re-running the merge after a
late ledger, coverage, runner, or corpus change re-derives every fact.

Each input counts only once merged and only while its file matches its merge digest:

- `counts.bugs` from `solution/bug-ledger.json` (required while Minos is dispatchable;
  otherwise every bug count is 0): one count per ledger status (`confirmed`, `suspected`,
  `needsOracle`, `bounced`, `quarantined`, `duplicate`, `rejected`) and `headline` =
  confirmed + suspected;
- `unproven`: every `suspected` and `needs-oracle` row, sorted by ID, with its
  `missingProof.elements` as `missing` and its `missingProof.detail`, so no likely finding is
  dropped from the report;
- `held`: every `bounced` row with its `repair.missing` elements and every `quarantined` row
  with its `quarantine.reasons`, sorted by ID, as `reasons`; neither counts in the headline;
- `counts.regression`: `wired` counts the confirmed bugs covered by an `implemented`,
  `passed`, or `failed` automation-status test; `uncovered` lists the rest; `counts.automated`
  counts those tests and `counts.evidence` the canonical evidence references (0 when unmerged);
- `automationReview` from `argus-assets automation-review check` semantics;
- `runner`: mode, status, exit code, categories, and `deliveryGate` copied from a valid
  `reports/argus-runner-result.json`, which a non-null runner requires, and `evidenceId`, the
  `runner-result` reference in the merged evidence registry whose SHA-256 equals that file's
  bytes (none fails the merge, so an unregistered or since-overwritten result never counts);
  `runner: null` is valid only in Mode B with no automated test;
- `coverage` (required) from the merged `argus/coverage-result@2`: discovery completeness, the
  overall ratios including `automatedExecution`, the scoped-outcome count,
  `criticalUnexecuted`, and `caseDepth` when recorded. Its merge record keeps the digest of each
  canonical coverage input (surface inventory, observations, evidence registry, bug ledger,
  automation status); if any of them changed since, the coverage result is stale and the
  summary fails until it is merged again;
- `sourceSchemas` in the order ledger, evidence, automation status, runner result, coverage
  result, automation review, for the inputs present.

| Status reason | Ceiling | Condition |
|---|---|---|
| `automation-review-blocked`, `automation-review-stale`, `automation-review-absent` | `blocked` | The review is BLOCK, an APPROVE of a changed corpus, or missing while Aristarchus is dispatchable. |
| `confirmed-bug-without-regression` | `blocked` | A runner ran and a confirmed bug has no wired regression. |
| `bounced-findings`, `quarantined-findings` | `degraded` | A ledger row is still bounced (its proof repair did not land) or quarantined (its evidence failed reconciliation). |
| `critical-surface-unexecuted` | `degraded` | `coverage.criticalUnexecuted` is non-empty. |
| `case-depth-gaps` | `degraded` | Case depth is missing, not fully planned, or has gaps or unplanned surfaces. |
| `runner-not-delivery-gate` | `degraded` | A runner result exists but is not a delivery gate. |
| `runner-exit-11` … `runner-exit-15` | `degraded` | The runner exited with an automation-defect, infrastructure, policy-denial, invalid-input, or unapproved-skip code (`RUNNER-CONTRACT.md`). |
| `deep-hunt-skipped:<reason>` | `degraded` | A deep-hunt pass was skipped for a reason other than `converged`, for example `controller-budget`. |

`solution/FINAL-SUMMARY.md` prints the status with one `Status reason:` line per reason, the
defect headline and per-status counts, a "Likely, unproven" section (`None.` when empty), the
review verdict (`APPROVE`, `BLOCK`, `STALE`, `ABSENT`, or `NOT-APPLICABLE`) with its round,
the runner outcome, and the coverage section with automated re-execution (`n/a` when automation
is unfunded) and one line per unexecuted critical surface.

## Lane outcomes in 5.0

`argus/lane-outcomes@1` at `ai_agents_internal/lane-outcomes.json` is a count-only runtime
report, not a canonical solution fragment: it is never an `engagement fragment` input and never
merged. After the final merges and before cleanup, Odysseus runs
`argus-assets engagement lane-outcomes --manifest <engagement.json> --controller-token <odysseus-token>`.
The command accepts only the active Odysseus controller token (checked against the live lease,
never persisted, never written into the report) and recomputes the report from:

- every `argus/model-decision@3` file under `ai_agents_internal/model-decisions/`, each a
  single-link regular file whose name, path, engagement, and integrity digest agree;
- every `argus/model-telemetry-event@3` line in `ai_agents_internal/model-telemetry.jsonl`,
  each bound to one of those decisions;
- the merged `solution/bug-ledger.json` (per `lane`) and `solution/automation-status.json`
  (per `owner`), each only while its file matches its merge digest.

It has one row per selected lane, in manifest order, with integer counts only:
`decisions` (total, normal, turn-limit, every non-normal signal as `escalations`,
`no-artifact`, `zero-candidates`, `AUTO_CONTINUE_SELECTED`, `BACKOFF_RETRY_SELECTED`, blocked),
`telemetry` (events, successes, failures, total tokens, reported cost or null), `ledger` (one
count per bug-ledger@2 status, `reported`, `wired`, and `severe` = confirmed or suspected
Blocker/Critical rows), and `automation` (tests, tests covering a bug, failed tests). `sources`
records the merged ledger and automation-status digests (null when unmerged), the decision and
event counts, and ledger rows or tests attributed to an unselected lane. No title, path, URL,
target, token, or evidence is recorded. A decision or event that fails validation fails the whole
report instead of undercounting it. Recomputation is idempotent and atomically replaces the file
(mode `0600`).
