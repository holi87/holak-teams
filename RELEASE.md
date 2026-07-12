# Release validation

The repository has one release gate for local development and CI:

```bash
scripts/validate-release.sh
```

It installs locked validation dependencies, validates both plugin manifests, rejects
representative marketplace drift, compiles every canonical Argus JSON Schema, runs the
contract suites, verifies generated-document synchronization and prompt regressions,
then clean-installs the previous Argus release and updates it to the current release.
The installed marketplace-lifecycle smoke covers the successful install/update path: it
provisions distinct `runtime-attestation` and `operator-approval` public anchors, pins their
stable IDs, reruns current preflight, seals the dispatchable normal attempt-1 decisions,
allocates the Odysseus controller first, authenticates two exact decision-bound specialist
leases, and verifies their release without third-party services. Dedicated repository model
and engagement smokes cover the negative purpose/key, late-normal, lane/controller-token,
authorization replay, retry-rebind, token rotation, and exactly-once telemetry cases. The
installed lifecycle is the install/update happy path; it does not claim installed telemetry
coverage. A release is not ready until the complete gate passes.

## Argus 2.0 contract migration

Argus 2.0 changes the canonical lane plan, evidence reference, and automation status
documents from single records to deterministic collections. Their current IDs are
`argus/lane-plan@2`, `argus/evidence-reference@2`, and
`argus/automation-status@2`. The packaged reader preserves the three shipped `@1`
schemas, validates either version, and migrates legacy fragments to sorted `@2`
collections before persistence and merge. Other canonical contracts remain at `@1`.
The genuine 1.18 lane fixture's direct `planned → completed` transition remains readable;
its v2 migration inserts `running` at the deterministic timestamp midpoint.
For equal, reversed, or sub-millisecond legacy timestamps without such a midpoint, the
migration emits a fixed millisecond-spaced synthetic timeline instead of rejecting v1.

The preflight report moves to `schemaVersion: 2` because model-runtime selection and the
bound orchestration projection changed its required shape. The exact Argus 1.18 validator
is preserved as `preflight-report-v1.schema.json`; historical reports remain readable and
immutable, while every new preflight writes and validates v2. `argus-assets schema list`
exposes this as a report-only URL/schemaVersion registry entry, and
`schema validate --kind preflight-report` dispatches v1/v2 without admitting either report to canonical
fragment or merge handling.

Separately, the internal resumable engagement state moves from `schemaVersion: 1` to
`schemaVersion: 2`. The packaged runtime preserves `engagement-state-v1.schema.json`,
derives allocation IDs and legacy checkpoint execution bindings deterministically under
the state lock, records a source-bound migration audit, and preserves the active lease for
resume and cleanup. The marketplace lifecycle gate now installs the genuine previous Git
revision, creates an active v1 allocation and checkpoint with that installed CLI, updates
the plugin, and verifies v2 migration and cleanup.
Current state also seals the preflight dispatchable projection before allocation. Barrier
participants are the manifest phase members inside that immutable projection, worker
`success` cleanup requires every declared arrival, and heartbeat records bind progress to
the active allocation, dispatch, and attempt generation.
New manifests persist physical target and artifact-root paths. During this upgrade, a
genuine legacy manifest that stored a lexical macOS alias such as `/tmp` or `/var` remains
readable only when its resolved physical path equals the current root; validation retains
the original hashed manifest rather than rewriting it in place.

The runtime adapter contract also moves to `argus/runtime-adapters@3` so an executable
Codex route can require a short-lived Ed25519-signed runtime attestation bound to the exact
engagement, dispatch, attempt, agent, configuration, adapter, and enforcement set. The
host trust store contains distinct public anchors for the dispatch wrapper's
`runtime-attestation` and the human boundary's `operator-approval`; `model trust` pins both
stable IDs from one immutable snapshot. Neither private key nor a generic signing endpoint
is available to the controller, workers, or their OS user. The wrapper emits immutable
route attestations only for configurations it can enforce, then emits a separate fresh JIT
dispatch authorization immediately before it applies the exact model, effort, and turn cap; the operator signer alone
authorizes frontier continuation or abort. Revocation requires aborting the current
snapshot-bound engagement and starting a new one. Pinning requires a fresh preflight bound
to the new manifest digest. Normal attempt-1 decisions for Odysseus and every currently
dispatchable selected role precede allocation; deferred, skipped, and blocked roles are not
part of that sealed set.
Odysseus is allocated first against its exact decision; its controller token authenticates
each worker's exact decision-bound allocation. Model requests and exactly-once telemetry
require the lane token, routes after allocation require the controller token, and retries
reuse the original dispatch and active allocation through an explicit `engagement
start-attempt` rebind. Telemetry for the completed attempt precedes that rebind;
`start-attempt` consumes the current lane token, atomically rotates it, and returns the next
token once, so the stale attempt token cannot authorize the retry. Every Codex allocation,
resume, or retry rebind verifies a fresh
`argus/model-dispatch-authorization@1` that binds the selected decision and config, parent
session, random allocation ID, and nonce. Resume/retry keeps the active allocation identity;
a post-release replacement must use a new allocation ID, and bounded history prevents reuse
of prior MDA digests, nonces, or allocation identities. The CLI verifies and persists that binding; the
external wrapper remains responsible for pairing the successful operation with the actual
exact-config spawn because the CLI cannot prove an external process launch. The
canonical output changes, state migration, and adapter contract expansion together make
this a major rather than minor release.

For Argus role changes, regenerate both runtimes before the release gate:

```bash
scripts/sync-argus-role-variants.mjs --write
```

CI runs the same command in check mode and loads the generated files through both Claude
Code's strict plugin validator and Codex's native config loader.

For Hephaestus role changes, regenerate Codex from the flat Claude sources:

```bash
scripts/sync-hephaestus-codex-variants.mjs --write
```

The release gate validates exact model mapping, descriptions, source hashes, full runtime
role bodies, sandbox policy, README rows, and the HTML roster for all 49 agents. Argus also
enforces the exact 15-field provenance schema, source/config/instruction hashes, and strict
per-file and corpus byte budgets for its non-runtime Codex Markdown stubs.

## Reproducible version bump

Prepare a semver release with the repository helper:

```bash
node scripts/release-plugin.mjs --plugin argus --bump minor --write
```

Use `patch`, `minor`, or `major` according to `AGENTS.md`. The helper changes the plugin
manifest, its marketplace entry, and the marketplace's top-level release version as one
operation. Verify the synchronized result with:

```bash
node scripts/release-plugin.mjs --plugin argus --check
claude plugin tag --dry-run argus/claude
```

## Prompt regression approval

`argus/prompt-budgets.json` records the approved total and per-agent prompt corpus. Any
agent increase fails validation even when the broad maximum remains satisfied. A deliberate
increase requires a reviewed `regressionApproval` object containing the exact current corpus
SHA-256, issue number, approver, reason, and exact per-agent increases. After approval lands,
replace `approvedCorpus` with the reviewed corpus and remove the one-release approval.
