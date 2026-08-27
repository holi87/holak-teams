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
active Ed25519 public anchors by stable key ID from one secure host trust store
before any model decision or allocation. The `runtime-attestation` anchor belongs to a
trusted dispatch wrapper that alone can authorize and apply the exact model configuration; the
`operator-approval` anchor belongs to a separate human-controlled approval boundary.
Rerun preflight so every later decision binds the new manifest digest. Command-supplied,
target-supplied, same-key, same-fingerprint, wrong-purpose, or first-use trust is forbidden.
Neither private key nor a generic signing interface may enter the target, artifact root,
controller/worker tool boundary, or the OS user that runs those agents.

The pinned bundle records the secure absolute host-store path. Every sensitive model
operation reopens that live store and immediately rejects a revoked, missing, or replaced
key. A still-valid historical signature never overrides current revocation state.

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

## Unattested launch (no trust store)

`argus-launch claude ... --unattested` and `argus-assets preflight ... --unattested-launch`
are an explicit, opt-in alternative to the trust-store/launch-authorization handshake above,
for operators who cannot provision or use Ed25519 signing keys (no key-management access on
the target's host is the primary case). They skip ONLY the cryptographic native-launch
attestation gate at preflight (`native-host-execution` becomes a non-mandatory, explicitly
`UNATTESTED`-labeled `degraded` check instead of a hard fail); the OS-level sandbox
(target/artifact-root immutability via `sandbox-exec`/`bwrap`) is unaffected and still runs.
Default behavior — no `--unattested`/`--unattested-launch` — is unchanged and stays
fail-closed exactly as before.

### How assurance is recorded and bound

When `preflight --unattested-launch` creates the engagement manifest it writes
`"launchAssurance": "unattested"` into it. An attested manifest omits the field entirely and
is byte-identical to every manifest written before this mode existed; a missing or
unrecognized value resolves to `attested`, and an unrecognized value is rejected by
`validateEngagementManifest` rather than silently accepted.

### Preconditions: the flag is refused, never quietly ignored

`--unattested-launch` is not a switch a dispatched controller can flip. Passing it is a
hard failure with its own named error unless *every* precondition below holds, so a
controller that was launched attested cannot reach keyless mode by simply omitting the
three signed coordinates from the preflight command it composes:

1. `ARGUS_LAUNCH_UNATTESTED=1` must be present. `argus-launch --unattested` exports it into
   its `env -i` child; the attested launcher never does. An operator running `preflight`
   by hand on a keyless host must set it explicitly:
   `env ARGUS_LAUNCH_UNATTESTED=1 argus-assets preflight ... --unattested-launch`.
2. `--model-runtime` must be `claude`. Codex's `native-host-execution` mandate covers the
   absence of a native hard turn cap and can never be waived.
3. None of `--trust-store`, `--launch-authorization`, `--launch-receipt` may be supplied.
4. The native-launch inspection must not already be `ready`.
5. **No host attestation material may be resolvable.** No `ARGUS_MODEL_TRUST_STORE` /
   `ARGUS_NATIVE_LAUNCH_*` environment binding may be inherited, and no file may exist at
   the host trust store path (`$ARGUS_MODEL_TRUST_STORE`, else
   `~/.config/argus/model-trust.json`). This is the load-bearing check: the trust store is
   required to live outside the engagement artifact root, which is the only region the
   launcher's sandbox grants write access to, so this condition reads state the controller
   cannot forge or remove.
6. No attested `ai_agents_internal/native-launch-receipt.json` may exist in the artifact
   root — that file means this root belongs to an authenticated launch.

Assurance is immutable for the life of an engagement. Rerunning preflight against an
existing manifest with the opposite setting is an error, not a rewrite — the manifest digest
is baked into every model decision and into the model-control seal, so flipping it would
invalidate them. `model trust` refuses to pin a bundle on an unattested engagement, and an
`unattested` manifest that carries a `modelTrust` bundle is invalid.

Every model decision minted for an unattested engagement carries `"trust": "unattested"`.
That marker is part of the semantic input to the deterministic `decisionId`, so it cannot be
added to or stripped from a decision file after the fact. `validateModelDecisionBinding`
requires the decision's trust and the manifest's `launchAssurance` to agree exactly: an
unattested decision is rejected under an attested manifest, and an attested (unmarked)
decision is rejected under an unattested manifest. Decision files therefore cannot be
replayed across assurance levels in either direction.

### What unattested mode does and does not relax

Relaxed, and only this: the requirement for a pinned purpose-separated Ed25519 trust bundle
(`validateModelTrust`) and the per-route recheck of the *pinned* identity against the live
host trust store. With that gate satisfied by the recorded opt-out instead of by key
material, `model route`, `model telemetry`, `engagement allocate`, and
`engagement start-attempt` all work with no trust store, no keys, and no signer.

The recorded opt-out is never honoured on the manifest's word alone. Every command that
would have demanded a pinned bundle re-derives the relaxation before taking it:

- **No host attestation material may be resolvable** — the same probe as preflight
  precondition 5, evaluated fresh on every invocation. This is what restores the
  operator's mid-engagement kill switch: creating, restoring, or relocating a host trust
  store halts an unattested engagement on its very next command, exactly as rotating a
  pinned key halts an attested one. A manifest that claims `unattested` while key material
  exists is a hard failure, not a fall-back.
- **The co-resident `preflight.json` must corroborate it** — schema-valid, digest-fresh
  against the *exact* current manifest, and carrying a `native-host-execution` entry with
  `mandatory: false`, `status: "degraded"`, and `UNATTESTED: `-prefixed evidence. A manifest
  flipped to `unattested` without a matching preflight run is refused, and so is a report
  forged to claim attestation passed. This is defence in depth, not the anchor: the report
  lives inside the artifact root and is writable by the controller.

Fully enforced, unchanged: packaged-asset digests; decision self-integrity SHA-256;
deterministic re-derivation of every decision from the packaged policy and adapter snapshot
(semantics, `decisionId`, `relativePath`, persisted path); preflight freshness bound to the
manifest digest; the immutable model-control seal and its dispatchable projection;
`status === 'selected'`, exact agent/dispatch/attempt binding and retry lineage;
non-aliased/single-link file guards; lease-token capability checks; and the OS sandbox.

Still fail-closed, by design and with no way to opt out:

- **Codex dispatch is unavailable.** A Codex allocation needs a signed JIT
  `MODEL_DISPATCH_AUTHORIZATION`, which cannot exist without a runtime-attestation key.
  Unattested mode is Claude-only, enforced at decision creation, not just at the CLI.
- **Operator-approved escalations are unavailable.** A frontier role that hits
  `ambiguity`/`safety`/`repeated-failure`, or `model-unavailable` on a frontier role,
  produces `OPERATOR_ESCALATION_REQUIRED`/`FRONTIER_UNAVAILABLE` and stays blocked: weaker
  fallback is forbidden and there is no operator-approval anchor to verify a signature
  against. Standard-role `model-unavailable` still routes upward to frontier as usual.

### Named residual risk

Unattested mode loses one protection, and it must be reported: there is no cryptographic
proof of sandbox/turn-cap/model-dispatch integrity for the run. Concretely, a local actor
with write access to the artifact root can mint a *self-consistent* decision file, because
nothing signs the policy-to-decision step. Key rotation and revocation remain observable in
the only form that applies to a keyless host — the appearance of any host trust store halts
dispatch — but there is no pinned identity to compare against, so a *changed* key inside an
existing store is indistinguishable from any other store. One residual downgrade path is
named and accepted: an attested controller whose operator keeps the trust store at a
non-default path could scrub the inherited `ARGUS_*` bindings, delete the in-root
native-launch receipt, and set `ARGUS_LAUNCH_UNATTESTED=1` itself. Keeping the host trust
store at the default `~/.config/argus/model-trust.json` closes it. Disclosure is automatic and
layered: the manifest field, the `UNATTESTED:`-prefixed `native-host-execution` evidence in
`preflight.json`, `attestation=UNATTESTED` on the `PREFLIGHT` line, `"trust": "unattested"`
in every decision file, and an `## Attestation: UNATTESTED` section rendered into
`solution/FINAL-SUMMARY.md`. Carry that residual risk verbatim into every report; never
present an unattested run as attested.

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
binding. Codex routes are currently blocked because the installed CLI lacks a native hard
turn cap. Neither an attestation nor an approximate action counter can change that result.

The controller form is `engagement allocate --manifest <manifest> --lane odysseus
--decision <decision>`. A worker adds its own `--lane` and `--decision` plus
`--controller-token <odysseus-token>`; resume additionally supplies `--token
<current-lane-token>`. A retry uses `engagement start-attempt --manifest <manifest> --lane
<worker> --decision <next-decision> --token <current-lane-token> --controller-token
<odysseus-token>`. The
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
controller-only; direct `Write`, `Edit`, or shell redirection is denied.

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

State is `schemaVersion: 2` only and contains no migration surface. Any older,
unrecognized, or malformed shape is rejected rather than guessed. Active older engagements
must finish with their original runtime before an Argus 3 upgrade.

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
contracts remain v1-only. The three collection contracts accept only current v2. There is
no guessed migration from a retired shape. A future version must
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
