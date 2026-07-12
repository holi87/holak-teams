# Argus Engagement Ownership, Immutability, and Concurrency Policy

This is the canonical runtime contract for safe parallel Argus engagements. The installed
copy is `${CLAUDE_PLUGIN_ROOT}/references/ENGAGEMENT-POLICY.md`.

## One manifest and one state file

`argus-assets preflight` creates or loads `ai_agents_internal/engagement.json` before
specialists run. The manifest fixes the target and artifact roots, selected workers,
phase participants, canonical owners, allowed write roots, isolated resource policy,
exclusive-operation owners, ID allocators, cleanup obligations, and the resumable state
path. The manifest is operator-owned and is never modified by target, repository, issue,
fetched, tool, or agent content.
Its only post-creation mutation is external pre-dispatch `model trust`: select two distinct
active Ed25519 public anchors by stable key ID from one secure host trust-store snapshot
before any model decision or allocation. The `runtime-attestation` anchor belongs to a
trusted dispatch wrapper that alone can authorize and apply the exact model configuration; the
`operator-approval` anchor belongs to a separate human-controlled approval boundary.
Rerun preflight so every later decision binds the new manifest digest. Command-supplied,
target-supplied, same-key, same-fingerprint, wrong-purpose, or first-use trust is forbidden.
Neither private key nor a generic signing interface may enter the target, artifact root,
controller/worker tool boundary, or the OS user that runs those agents.

The pinned bundle is an immutable trust-store snapshot, not a live revocation feed. If
either source key is revoked after pinning, abort and clean the current engagement; start a
new engagement and pin a current snapshot. Never reinterpret a still-pinned key as current
trust merely because its signature remains cryptographically valid.

`ai_agents_internal/engagement-state.json` is the only mutable coordination record. Every
state transition uses an atomic filesystem lock and atomic rename. Workers never edit the
state file directly. Lock recovery checks owner PID liveness and never reclaims a live lock
only because it is old; contenders wait up to 60 seconds. Cleanup/archive I/O is still
serialized under that lock, so the controller must not schedule competing heartbeat or
checkpoint writes during a large cleanup.

## Packaged target-immutability hook

The installed plugin ships `hooks/hooks.json`. Its `PreToolUse` handler evaluates
`Write`, `Edit`, `MultiEdit`, and `Bash` calls through `argus-assets guard` before the
tool executes. The guard activates only when an engagement manifest exists. It resolves
absolute, relative, traversal, and symlinked paths against their physical parent before
policy evaluation.

This lexical hook is a policy control, not an OS sandbox: it cannot prove the side effects
of arbitrary target-owned executables. Use a read-only mount or equivalent host sandbox
when hard source immutability is required, and treat unknown scripts as untrusted.

Target-source writes, deletes, moves, copies, permission changes, shell redirections,
patches, write-capable subprocesses, and filesystem-link creation are denied unless the
bounded operation is explicitly owned by the controller and every destination is safe.
Canonical artifacts are always denied to
direct tools; their owner must merge immutable fragments through the controller. Each
denial returns a `GUARD-*` rule and appends a redacted event to
`ai_agents_internal/immutability-audit.jsonl`. Audit records contain a command digest,
never raw command or file content.

The default generated-test allowlist is deliberately conservative: unambiguous test
directories plus the exact isolated-driver files. It never broadly allows `src/`, all of
`scripts/`, or root build configuration because those are application source/config in
many repositories. After read-only recon, the operator may add the target's proven test
roots to the manifest; an agent or fetched file may not infer or broaden them.

The hook does not replace host sandboxing or permissions. Managed Claude Code settings
may disable non-managed plugin hooks; preflight detects a missing packaged hook and blocks
the engagement rather than claiming protection.

## Explicit bypass

A bypass is exceptional and must be operator-authored in `writePolicy.bypass`: enabled,
named approver, reason, future expiry, exact allowed paths, and SHA-256 of a secret token.
The host must provide the matching token in `ARGUS_IMMUTABILITY_BYPASS_TOKEN`. Target or
agent content can never create or broaden a bypass. Bypass use is audited with the rule
`GUARD-EXPLICIT-BYPASS` and does not bypass the separate authorization policy.

## Single-writer artifacts and immutable fragments

Each `writePolicy.canonicalArtifacts` entry has exactly one owner. No agent writes a
canonical file directly. Workers submit immutable fragments:

```bash
argus-assets engagement fragment --manifest ai_agents_internal/engagement.json \
  --lane <slug> --token <lease> --canonical <path> --id <stable-id> --input <file|->
```

Creation is exclusive and idempotent only when the existing content digest matches. The
canonical owner then runs `engagement merge` with its lease. The controller sorts
fragments by stable filename, acquires the single merge lock, writes a temporary file,
and atomically renames it over the canonical path. Repeated merges of the same fragments
produce byte-identical output.

## Isolated resources and leases

Before allocation, the controller persists a normal attempt-1 selected model decision for
Odysseus and every projection-selected worker whose current preflight record is `ready` or
`degraded` with `dispatchAllowed=true`. This exact dispatchable set is sealed; deferred,
skipped, and blocked roles cannot allocate. The controller then runs `engagement allocate` for Odysseus
against that exact decision and retains the returned lease token as the controller token.
Every worker allocation is bound to its own exact selected decision and authenticated with
that controller token. The controller passes a worker only its own token and public resource
and decision coordinates; workers never allocate and never receive the controller token.
A new normal attempt-1 dispatch after any allocation is forbidden. Retries reuse the same
dispatch and active allocation, increment the model-decision attempt, and use `engagement
start-attempt` to atomically rebind that allocation. The command consumes the current lane
token, rotates it inside the same state transition, and returns the next token once. The
controller must replace the stale token before a new thread starts; the previous attempt
token is immediately invalid.

`model request` authenticates the requesting lane with its exact active lane token. Once
any allocation exists, `model route` authenticates the controller with the active Odysseus
token. `model telemetry` again requires the decision-owning lane token and atomically
accepts exactly one sanitized event for each selected immutable decision. Values are
lane-reported operational observability, not authoritative billing, benchmark, or outcome
evidence. Emit it before `start-attempt` or cleanup changes the lane's active decision/token
binding. A Codex runtime attestation is
checked when the immutable route is selected. Every later Codex allocation, authenticated
resume, or retry rebind requires a fresh `argus/model-dispatch-authorization@1`, bound to the
exact decision, configuration digest, parent session, random allocation ID, and nonce. It
expires within 15 minutes. The CLI verifies and persists this binding but cannot prove that
an external process spawned the agent; the enforcing wrapper must pair a successful CLI
operation with the exact-config spawn. Route-proof expiry does not force all waves into one
window. Resume and retry retain the active allocation ID while consuming a new MDA digest,
nonce, and issue time. A replacement after release must use a never-before-consumed
allocation ID; bounded per-lane history and cross-lane validation reject reuse of any prior
allocation ID, MDA digest, or nonce.

The controller form is `engagement allocate --manifest <manifest> --lane odysseus
--decision <decision>`. Codex also adds `--dispatch-authorization <MDA-file>`. A worker adds its own `--lane` and `--decision` plus
`--controller-token <odysseus-token>`; resume additionally supplies `--token
<current-lane-token>`. A retry uses `engagement start-attempt --manifest <manifest> --lane
<worker> --decision <next-decision> --token <current-lane-token> --controller-token
<odysseus-token>`; Codex also supplies a fresh `--dispatch-authorization <MDA-file>`. The
controller captures the returned `token`, replaces its stored lane capability, and only then
spawns the retry.

Each allocation returns a lease token once plus deterministic unique resources: managed
browser profile, browser-artifact directory, auth directory, temporary directory, output
directory, synthetic account alias, data namespace, and port. State stores only the token
SHA-256; the mode-0600 `.lease` file stores only an allocation-ID marker, never the token.
Resume, recovery, cleanup, or repeated allocation therefore requires the caller to retain
and resubmit the current lane token and the same exact decision binding. A successful retry
rebind returns a replacement token once and revokes its predecessor. Agents use only their
own allocation. Each browser-artifact directory contains dedicated `downloads/`,
`traces/`, `videos/`, and `screenshots/` roots. A lane may reuse
its own profile during the engagement; different lanes never share one unless the
manifest's `browserPolicy` contains an explicit, unexpired shared-session authorization
naming all lanes, shared account alias, approver, reason, authorization rule, and expiry.

Lane and controller tokens are bearer capabilities, not a claim of secrecy from every
same-user process. Keep them out of artifacts, logs, shell history, worker prompts, and
cross-lane environments, and use an OS/process isolation boundary when same-UID process
inspection is in scope.

`engagement heartbeat` requires that lane's active token and live lease file. Every runtime
record carries the active allocation ID, dispatch ID, and attempt; `start-attempt` begins a
new heartbeat generation on the same allocation/dispatch, and a generation may advance only
by one attempt. Progress within one generation is event-driven and monotonic by timestamp,
phase, completed units, and terminal status;
cross-lane tokens, missing allocations, regressions, malformed logs, symlinks, and
multi-link files fail closed. Preflight alone may create the initial Odysseus record before
the controller lease exists, and a resumed preflight never rewrites it. Heartbeat paths are
controller-only even when a resumed legacy manifest still lists that directory as a generic
artifact root; direct `Write`, `Edit`, or shell redirection is denied.

Every controller-managed state, lease, checkpoint, heartbeat, audit, and report writer
rejects symbolic links and existing regular files with more than one hard link before any
write or permission change. Atomic replacement uses a private single-link temporary file,
so a target-source inode cannot be mutated through an aliased control path.

The same manifest records the default `WCAG 2.2 AA` accessibility policy and a
browser/device/viewport matrix derived from declared target support and risk signals.
An older accessibility target is valid only with an explicit project-requirement source,
reason, and approver. Unknown browser support produces a recorded conservative matrix,
not a silent single-browser assumption.

Reset and fault-injection windows are exclusive resources. `engagement claim` permits
only the manifest owner and rejects a second holder. `engagement release` closes the
window. No destructive or fault operation starts without both this exclusive lease and
the separate authorization decision.

## Phase barriers, IDs, checkpoints, and resume

The ordered phases are preflight, discovery, hunting, automation, verification,
reporting, and complete. Before allocation, model-control sealing copies the exact
dispatchable preflight projection into engagement state. That projection is immutable and
filters each manifest phase's participants, so deferred/skipped/blocked roles create no
false barrier and late capability changes cannot silently alter quorum. A projected
participant records `engagement barrier arrive`; only Odysseus can advance after every
declared projected participant has arrived. Dispatch for the next phase is forbidden before
a successful advance. This phase dispatch uses the already selected decision and allocation;
it does not mint a late normal dispatch or replacement lease.

Canonical IDs come from `engagement id --identity <stable-key>`; allocation is serialized,
owner-restricted, and identity-deduplicated. Replaying the same identity across a resume
returns the original ID, while a distinct identity receives the next ID. `engagement
checkpoint` accepts a monotonic sequence per worker. Replaying the same sequence and
content is idempotent; different content at an existing sequence is rejected.
`engagement status` exposes the last durable phase, arrivals, allocations, locks,
checkpoints, ID identities, and merges for resume.

A declared worker escalation requires the current monotonic checkpoint and binds the next
attempt to its path and SHA-256. `start-attempt` validates that exact checkpoint before
rotating the token. A pre-spawn `model-unavailable` route is different: it binds the prior
selected decision and active allocation directly and may retry without a checkpoint because
no worker thread began.

New state is `schemaVersion: 2`. A genuine v1 state is read through the preserved v1
schema and migrated once under the state lock: allocation IDs and legacy checkpoint
execution bindings are derived deterministically from immutable v1 fields, the migration
source digest, field origins, and exact active allocation IDs are audited, and the original
active lease token remains valid for resume and cleanup. A missing historical preflight
heartbeat is tolerated only while Odysseus still has that exact migrated allocation; a
replacement allocation must have the normal initial record. Any unrecognized or malformed
shape is rejected rather than guessed.

New manifests persist physical target and artifact-root paths. A legacy manifest may keep a
lexical alias such as `/tmp` or `/var`; it remains valid only when resolving that stored path
proves physical equivalence to the current root. Compatibility validation does not rewrite
the original manifest or change the digest to which its state and preflight are bound.

## Canonical machine contracts

The installed `schemas/` directory defines the versioned, machine-readable contracts:
`argus/bug-ledger@1`, `argus/lane-plan@2`, `argus/evidence-reference@2`,
`argus/automation-status@2`, `argus/runner-result@1`, and the inventory, coverage, and
final-summary contracts. Canonical solution JSON documents are single-owner
`json-document` artifacts; the runner result is validated at its runner-owned report path.
Lane-plan, evidence-reference, and
automation-status accept multiple valid collection fragments; their owner merges records
in stable-key order and rejects duplicate keys across fragments. The controller validates
every fragment before it is persisted, verifies its `engagementId`, then validates the
deterministic merged document again; malformed, incompatible, duplicate, or
cross-engagement content cannot reach a canonical file.

`solution/final-summary.json` is the canonical final record. Its merge also renders
`solution/FINAL-SUMMARY.md` with an explicit `Source schema:` line, so the human-facing
summary is traceable to the machine contract. The lane-plan `lanes`, evidence-reference
`references`, and automation-status `tests` arrays contain unique records sorted by
`lane`, `id`, and `testId`; the final summary lists its source schemas and counts.

The per-contract version policy is `policies/schema-compatibility.json`. Unchanged
contracts remain v1-only. The three collection contracts retain their shipped v1 schemas,
accept v1/v2, migrate new v1 submissions before persistence, and migrate already-persisted
immutable v1 fragments during merge into a validated v2 canonical collection. There is no
guessed migration from any other shape. A future version must
retain the old schema until it ships an explicit deterministic migration and fixtures. Maintainers run
`argus-assets schema list` and `argus-assets schema validate --kind <contract> --input
<file>`; CI exercises both valid and invalid fixtures for every canonical contract.

## Cleanup

Every worker finishes with `engagement cleanup --outcome success|failure|interrupted`. Cleanup
removes its browser profile, auth tokens/cookies, downloads, traces, videos, screenshots,
temporary directory, lease file, and held
exclusive locks while preserving immutable fragments, checkpoints, reports, and
canonical outputs. The command is idempotent and runs on success, failure, and interruption
paths. A missing lease file during resume triggers crash recovery: stale sensitive state
is removed before a new lease is issued. For an explicitly authorized shared session,
the final active member removes the shared profile and auth state.
Released checkpoints move to an allocation-ID archive; retry repairs the exact archive
reference if a crash occurred after the directory rename but before the state commit.
For a worker, `success` cleanup requires an arrival in every projected phase whose manifest
definition names that lane; `failure` and `interrupted` remain available for earlier exits.
Odysseus verifies no active peer allocation or foreign exclusive lock remains. Its
`success` cleanup additionally requires the terminal `complete` barrier to be fully
satisfied, not merely `currentPhase=complete`; earlier shutdown must be recorded truthfully
as `failure` or `interrupted`.

## Guard rules

| Rule | Meaning |
|---|---|
| `GUARD-ALLOW` | All destinations are inside explicit non-canonical write roots. |
| `GUARD-NO-ENGAGEMENT` | No manifest exists; the plugin is not controlling this session. |
| `GUARD-MANIFEST-INVALID` | The engagement manifest cannot be trusted. |
| `GUARD-PATH-UNRESOLVED` | A write destination is missing or cannot be resolved safely. |
| `GUARD-TARGET-IMMUTABLE` | A destination is outside allowed artifact/test roots. |
| `GUARD-CANONICAL-SINGLE-WRITER` | A direct tool attempted to write a canonical artifact. |
| `GUARD-SHELL-AMBIGUOUS` | A write-capable shell/process command cannot be bounded safely. |
| `GUARD-EXPLICIT-BYPASS` | An exact, unexpired operator bypass authorized the path. |
