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

Lane-owned roots are writable in place by their owners only. `writePolicy.ownedArtifactRoots`
lists exact canonical paths with their owners: Atlas for `solution/test-lanes.tsv`,
`solution/environment.tsv`, and the runner-kit files under `scripts/` (never `scripts/`
itself); Atlas and Asklepios for `solution/quarantine.tsv`; Atlas and the lane automation
engineers for `solution/counterfactual/`. The guard takes the writing lane from the
PreToolUse payload that Claude Code writes (`agent_type` `argus:<slug>` for a subagent; the
main thread is the controller). A non-owner, the controller when it is not an owner, an
unidentified writer, and an owned root reached through a symbolic link are denied with
`GUARD-OWNED-ARTIFACT`. A packaged command checks its own outputs without a lane identity,
so it never writes an owned path: write to `reports/` and copy the result in place.
`writePolicy.selectedTemplateRoots` adds the roots of the operator's explicit
`ai_agents_internal/template-selection.json`, which no lane can write: its `testRoot` joins
the generated test roots and its `harnessRoot` is owned by `harnessRootOwners` (Atlas, the
lane automation engineers, and Asklepios, who extend the shared layer). The record
must be schema-valid and name the artifact or target root. Each root must lie below the
artifact root through real directories, outside `ai_agents_internal`, and clear of every
canonical, owned, and control path (the harness root also of every shared artifact root). It
must also be physically disjoint from the target root, so an artifact root that is the
target grants nothing. Any doubtful record grants nothing.

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

A canonical entry may declare `merge`: `concatenate` (the default) or `latest-revision`.
Only markdown artifacts may use `latest-revision`; Minos's `solution/BUG-LEDGER.md` and
`solution/WHITEBOX-LEADS.md` do. Their owner alone submits fragments, and any other lane is
refused with `<path> revisions are written only by <owner>`. Each new fragment id receives
the next revision number, and replaying an existing fragment returns its original record.
The merge still digest-checks every revision but publishes only the highest one; the merge
record adds `revision` and `supersededFragments`.

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
- **Operator-approved escalations are unavailable.** Automatic frontier continuation under
  the policy's `autoContinue` flag needs no operator signature, so its three paths work
  unattested exactly as attested: checkpoint-resume for a checkpointed `turn-limit` or
  `repeated-failure`, one fresh restart per dispatch for a controller-observed
  `no-artifact`, `zero-candidates`, or uncheckpointed `turn-limit`, and same-baseline
  backoff retries for frontier `model-unavailable`. Everything that still needs an operator
  stays blocked, because there is no operator-approval anchor to verify a signature against:
  an operator-gated signal (`safety`, `ambiguity`, `cross-lane`, `conflicting-evidence`,
  `oracle-ambiguity`, `schema-validation-failure`) or a checkpointed worker signal past
  `maxAutoContinuations` produces `OPERATOR_ESCALATION_REQUIRED`, and frontier
  `model-unavailable` after the last backoff produces `FRONTIER_UNAVAILABLE`. A spent
  checkpoint-less restart is `AUTO_CONTINUATION_EXHAUSTED`, reported as a residual. Weaker
  fallback is forbidden in both modes. Standard-role `model-unavailable` still routes upward
  to frontier as usual.

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

## Browser runtime record

`ai_agents_internal/browser-runtime.json` (`argus/browser-runtime@1`) names the Playwright
runtime that browser lanes may use. Writers: preflight and controller gate resolution; each
run replaces the whole record atomically, and only when the artifact root is writable and
the engagement is usable. Readers: the managed hunt driver and browser lanes. No lane edits it.
The preflight report carries the same result as `browserRuntime`.

Preflight never installs a runtime. Once the audited target probe is allowed, it inspects
candidates read-only, deduplicated by physical path, in this order: the profile's
`browserRuntime.modulePath` (probed alone when set); host-provisioned
`~/.cache/argus/browser-runtime/<x.y.z>/node_modules/playwright`, newest first
(`argus-launch --provision-browser` installs there, outside the artifact root, so the
sandbox can read but not modify it); `<artifact-root>/node_modules/playwright`;
`<target>/node_modules/playwright` for path targets; `<cwd>/node_modules/playwright`;
`$(npm root -g)/playwright`; the Homebrew and system global `node_modules`; and the five
newest `~/.npm/_npx/*` caches. A valid candidate is a directory whose `package.json` names
`playwright` and that has an `index.mjs`. Up to three valid candidates are proven by a real
headless Chromium launch (45 s each, environment limited to `HOME`, `PATH`, and `TMPDIR`,
throwaway profile under `ai_agents_internal/tmp/browser-probe-*` that is always removed);
the first launch wins. `status` is `available`, `unavailable` (evidence names the first
failure), or `not-probed` (the target probe was skipped, the profile set
`browserRuntime: false`, or a profile `features` list is authoritative). Without an
operator-declared feature, only `available` makes the `browser-runtime` capability available.

An `available` record binds the winner with `packageJsonSha256` and `moduleTreeSha256`. The
tree digest covers every directory in `moduleTreeRoots`: the package plus each runtime
dependency found by Node's `node_modules` lookup outside an already covered root. Entries
are labelled by their path relative to the directory that holds `modulePath` with `/`
separators, sorted by code unit, and hashed in order as `label NUL kind NUL payload LF`,
where `file` entries carry the SHA-256 hex of their bytes and `symlink` entries their link
text (links are never followed). Directories contribute only through their entries. A
consumer recomputes the digest immediately before importing the module and refuses on any
mismatch. A candidate inside the artifact root is only as trustworthy as that root was when
it was probed, because the root becomes worker-writable once lanes run.

## Isolated resources and leases

Before allocation, the controller persists a normal attempt-1 selected model decision for
Odysseus and every projection-selected worker whose current preflight record is `ready`,
`degraded`, or `conditional` with `dispatchAllowed=true`. This exact dispatchable set is
sealed; deferred, skipped, and blocked roles cannot allocate, and a conditional role
allocates only once gate resolution releases it. The controller then runs `engagement allocate` for Odysseus
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

`model request` authenticates the requesting lane with its exact active lane token, or a
worker lane with the controller token in its place (controller authority, below). Once
any allocation exists, `model route` authenticates the controller with the active Odysseus
token. `model telemetry` again requires the decision-owning lane token, or the controller
token for its batch form, and atomically
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
<odysseus-token>`; a worker retry may omit `--token` and run on controller authority. The
controller captures the returned `token`, replaces its stored lane capability, and only then
spawns the retry.

Two batch forms save controller turns without widening any authority. `model route
--manifest <manifest> --agents <slug,slug|dispatchable> --runtime claude --signal normal
--dispatch-prefix <id> --attempt 1` persists the whole initial set in one call before the
first allocation: `dispatchable` expands to Odysseus plus every lane the current preflight
makes dispatchable (the projection the seal binds), Odysseus always comes first, and each
dispatch ID is `<prefix>-<agent>`. It refuses any other signal or attempt, `--agent`,
`--dispatch-id`, `--request`, `--operator-decision`, and `--controller-token`, and any
active allocation. Every listed agent is validated before a decision is persisted, an exact
replay returns the same decisions, and one `argus/model-route-batch@1` line reports each
agent's `dispatchId`, `decisionId`, `relativePath`, `status`, and `reasonCode`; the exit code
is 2 when any decision is blocked. `engagement allocate --manifest <manifest> --lanes
<slug,slug> --controller-token <odysseus-token>` then allocates one wave of new worker lanes
under the initial model-control lock. It requires the seal, refuses `odysseus`, `--lane`,
`--decision`, `--token`, and `--dispatch-authorization`, and is Claude-only because every
Codex lane needs its own JIT dispatch authorization. Each lane must have its sealed decision,
no active allocation, a released gate when it is conditional, and the sealed preflight digest
before any lane is allocated; allocation then runs in the listed order and stops at the first
error. The `argus/engagement-allocation-batch@1` line carries each new allocation with its
token, on stdout only, plus the failed or unattempted lanes, and exits 1 when any failed.
Neither form persists a token, and the write guard applies to both exactly as to their
single-lane forms.

Controller authority lets the active Odysseus token stand in for a worker's lane token.
`engagement start-attempt`, `engagement barrier arrive`, `engagement cleanup`, and `model
request` accept `--controller-token <odysseus-token>` without `--token` for any worker lane,
and the three batch forms below take only the controller token. The runtime requires the
Odysseus allocation to be active with its live lease marker and the worker's allocation to be
active with its live lease marker, so controller authority never acts on a lane that was
never allocated or has been released. The one exception is an idempotent cleanup replay of
an already released worker: no lease file is left, so only the active controller is
required. Controller authority never applies to Odysseus, whose lane token is the controller
token. A supplied lane token is always judged on its own and never falls back to controller
authority. Every other rule (participants, phase order, pending phases before `success`
cleanup, retry lineage, backoff) is unchanged, and the start-attempt, arrival, and cleanup
results report `authority: lane` or `authority: controller`.

This grants no new capability. The controller already receives every lane token on stdout
when it allocates the lane, so it could already perform each of these operations; controller
authority only lets it stop retaining those tokens. Workers never receive the controller
token and no token is ever persisted, so a worker gains nothing: its own token still
authenticates only its own lane, and a worker token passed as `--controller-token` is
refused. A controller-authorized `start-attempt` returns the rotated lane token to the
controller, which passes it to the retry thread. Crash recovery is not covered: re-allocating
a lane whose lease file vanished still requires that lane's current token.

Three batch forms use controller authority:

- `model telemetry --manifest <manifest> --json '{"events":[{"decisionId":"MDR-…",
  "inputTokens":<n>,"outputTokens":<n>,"durationMs":<n>,"success":<bool>}]}'
  --controller-token <odysseus-token>` records 1 to 64 events; `reportedCostUsd` is optional.
  Keys are closed, no entry may carry a token, and decision IDs are unique. The controller is
  authenticated before any entry is read, and each decision must be the active binding of its
  lane with a live lease marker. All events are appended in one atomic write that is refused
  whole when any decision already has telemetry, and the command prints
  `MODEL_TELEMETRY_BATCH`. `--decision` and `--json` are mutually exclusive.
- `engagement barrier arrive --manifest <manifest> --phase <phase> --json
  '{"lanes":["<slug>"]}' --controller-token <odysseus-token>` records up to 32 arrivals.
  Workers arrive on controller authority and Odysseus on its own lease. One
  `argus/engagement-barrier-batch@1` line reports per-lane `results`, `failed`, and the
  resulting `barrier` status.
- `engagement cleanup --manifest <manifest> --json
  '{"cleanups":[{"lane":"<slug>","outcome":"success|failure|interrupted"}]}'
  --controller-token <odysseus-token>` releases up to 32 worker lanes. `odysseus` is refused:
  the controller still cleans itself last with its own token. One
  `argus/engagement-cleanup-batch@1` line reports `results` and `failed`.

Each batch validates its whole input before anything runs. Arrival and cleanup then attempt
every entry independently and exit 1 when any failed, so one refusal never hides another
lane's result; a released lane replays idempotently.

Batch input is inline only: exactly one single-line JSON object as the `--json` argv value,
in single quotes. A batch file would have to live in the artifact root, the only tree the
sandboxed controller can write and one every worker can read, so a path, `-`, or `@file` is
refused. The write guard already denies any packaged command containing a newline, pipe,
`;`, `&`, `>`, a backtick, or `$(`, which rules out heredoc and piped input, and it also
denies here-string or redirected stdin for a batch command. Tokens therefore travel only on
the controller's own argv, where same-UID processes inside the sandbox can see them exactly
as they can see `--token` and `--controller-token` today; the new forms never read a token
from the environment.

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

Phases are derived, never hard-coded. When the manifest is created, the packaged runtime
derives `phasePlan` from the packaged orchestration plan for the engagement's mode and
selected roles: the controller-owned `preflight` and `complete` bracket every plan phase
active in that mode. Mode A runs discovery, hunting, proof, deep-hunt-1, deep-proof-1,
deep-hunt-2, deep-proof-2, deep-hunt-3, deep-proof-3, automation, verification, and
reporting. Each entry records its wave, its kind (`control`, `work`, `proof`, or
`deep-hunt`), a pass number for proof and deep-hunt phases, whether it is skippable, its
participants, and its standby lanes. The runtime re-validates this shape on every load, and
a phase outside the plan is rejected for heartbeats, checkpoints, and barriers.

Before allocation, model-control sealing copies the exact dispatchable preflight projection
into engagement state. That projection is immutable and filters each manifest phase's
participants and standby lanes, so deferred/skipped/blocked roles create no false barrier
and late capability changes cannot silently alter quorum. A projected participant records
`engagement barrier arrive`; only Odysseus can advance after every declared projected
participant has arrived. Dispatch for the next phase is forbidden before a successful
advance. This phase dispatch uses the already selected decision and allocation; it does not
mint a late normal dispatch or replacement lease.

Standby lanes never arrive at a barrier. They are the lanes a phase may re-dispatch on
their active lease: filing lanes whose candidates need proof repair and Metis as the
oracle desk. A phase-scoped re-dispatch reuses the lane's allocation and token, so a
standby lane keeps its lease until the standby phase has passed (see Cleanup).

A proof phase whose projected participants include Minos cannot advance until Minos has
merged `solution/bug-ledger.json` during that phase. Each bug-ledger merge records
`ledgerSnapshots[<current phase>]`: the merged fragment ids, the sorted bug ids per status
(`confirmed`, `suspected`, `needsOracle`, `bounced`, `quarantined`), `newConfirmed` (the
confirmed ids that no earlier phase's snapshot had confirmed), and `mergedAt`. The snapshot
is taken from the merged ledger after reconciliation, so a row the merge quarantined for an
evidence failure counts as `quarantined`, never as confirmed.

`engagement barrier skip --lane odysseus --reason converged|controller-budget` ends the
deep hunt early. Only Odysseus may skip, only from the untouched start (no arrivals) of a
skippable deep-hunt pass, which is pass 2 or later. The skip covers that pass and every
later deep-hunt and deep-proof pass, and the phase cursor moves to the next unskipped phase.
`converged` requires the previous proof pass to have a ledger snapshot with zero new
confirmed defects. `controller-budget` is always accepted but is a named residual: the
final-summary merge downgrades a `completed` summary to `degraded` while such a skip exists.
Every skipped phase is recorded in `skippedPhases` with its reason, `skippedAt`, and
`basis` (the proof phase that proved convergence, or `null`). A skipped phase needs no
arrivals, rejects arrivals, and is never recorded as completed.

Canonical IDs come from `engagement id --identity <stable-key>`; allocation is serialized,
owner-restricted, and identity-deduplicated. Replaying the same identity across a resume
returns the original ID, while a distinct identity receives the next ID. `engagement
checkpoint` accepts a monotonic sequence per worker. Replaying the same sequence and
content is idempotent; different content at an existing sequence is rejected.
`engagement status` exposes the last durable phase, arrivals, allocations, locks,
checkpoints, ID identities, and merges for resume.

A retry decision carries exactly one immutable lineage; `start-attempt` rejects a decision
with none or with more than one.

- **Escalation lineage.** A declared worker escalation, including an automatic
  checkpoint-resume, requires the current monotonic checkpoint and binds the next attempt to
  its path and SHA-256. `start-attempt` validates that exact checkpoint before rotating the
  token.
- **Availability lineage.** A pre-spawn `model-unavailable` route binds the prior selected
  decision and the active allocation directly (allocation ID and the SHA-256 of its state
  record) and may retry without a checkpoint because no worker thread began.
- **Outcome lineage.** A controller-observed `no-artifact`, `zero-candidates`, or
  uncheckpointed `turn-limit` is routed without `--request` or `--operator-decision` and is
  bound to the prior selected decision and allocation the same way. The route also records
  `observedArtifacts`: the agent's RACI accountable artifacts that physically exist under the
  artifact root without crossing a symbolic link. A `no-artifact` claim they contradict is
  refused (`route turn-limit instead`). `priorCheckpointlessRetries` counts the outcome-bound
  selected decisions of earlier attempts on the same dispatch, so the policy grants one fresh
  restart per dispatch and then returns `AUTO_CONTINUATION_EXHAUSTED`.

A `BACKOFF_RETRY_SELECTED` decision carries `continuation.backoffSeconds`; its retry may not
rebind before the decision's `createdAt` plus that backoff. Earlier, `start-attempt` fails
with `retry backoff has not elapsed; retry at <ISO> or pass --wait true` and changes nothing.
With `--wait true` it sleeps out a remaining wait of at most 300 seconds and then rebinds.
The runtime re-checks the same rule inside its state lock for every caller. Emit the active
decision's telemetry before `start-attempt`, because the rebind supersedes that decision.

The manifest is `schemaVersion: 2` with the derived phase plan. State is `schemaVersion: 3`
only, carries `skippedPhases`, `ledgerSnapshots`, `conditionalAgents`, and `gateResolution`,
and contains no migration surface. Any
older, unrecognized, or malformed shape is rejected rather than guessed. Argus 5 upgrade:
a manifest (`schemaVersion: 1`) or state (`schemaVersion: 2`) written by Argus 4 is
rejected, so an active older engagement must finish with its original runtime.

## Conditional lanes and gate resolution

Preflight gives every role one disposition. The sealed dispatchable set is exactly the
selected records whose disposition has `dispatchAllowed=true`:

| Disposition | Meaning | `dispatchAllowed` | Sealed with a decision | Allocation |
|---|---|:--:|:--:|---|
| `ready` | Every required and optional capability is available | yes | yes | After the controller |
| `degraded` | An optional capability, host command, or authorization grant is missing; the record carries a deterministic fallback action | yes | yes | After the controller |
| `conditional` | Every unmet required capability is of kind `target` or `browser` and listed in `pendingGates` (sorted, non-empty); no tool is missing | yes | yes | Only after `engagement resolve-gates` releases it |
| `deferred` | A missing required capability of another kind (recon cannot prove it) defers the lane, or a blocked non-essential lane was downgraded (`downgradedFrom=blocked`) | no | no | Never |
| `skipped` | A missing required capability of another kind marks the lane not applicable to the target | no | no | Never |
| `blocked` | A tool, model route, or mandatory prerequisite failed; it stops the engagement for Odysseus, an essential lane, or a mandatory lane | no | no | Never |
| `not-selected` | The role is outside the engagement mode | no | no | Never |

`pendingGates` is empty on every record that is not `conditional`. A conditional record
replaces its required-capability fallbacks with one action naming its gates, the
resolve-gates release, and the fallback recorded as residual risk when a gate stays unmet;
optional-capability, host-command, and authorization actions stay. Any conditional record
makes the report `degraded`, `summary.conditional` counts them, and `residualRisks` lists
each with a reason that starts `pending gate resolution`.

Odysseus's first allocation seals `ai_agents_internal/preflight.json` by digest, and every
later allocation and retry re-checks it. Once `ai_agents_internal/model-control-seal.json`
exists, preflight refuses before any probe or write when its output resolves to that report:
``preflight.json is sealed by the model-control seal; release conditional lanes with
`argus-assets engagement resolve-gates`, never by rerunning preflight``. A diagnostic
report under another `--output` path stays allowed. A seal load also fails with
`engagement state conditional projection differs from the sealed preflight` when the bound
`conditionalAgents` map is not exactly the sealed report's conditional records and their
`pendingGates`.

A conditional lane is a dispatchable worker whose preflight record still waits on target or
browser capability gates that recon may prove. Model-control sealing binds
`conditionalAgents` together with the dispatchable projection: a sorted map from each
conditional lane to its sorted, unique gate IDs (empty when no lane is conditional).
Odysseus and Kalchas are never conditional. The map is immutable: re-binding a different
projection or conditional map fails with `dispatchable agent projection is immutable once
bound`. A conditional lane is sealed with its normal attempt-1 model decision like every
dispatchable lane, but allocation refuses it until the gates are resolved: `<lane> is
conditional on <gates>; run engagement resolve-gates first`.

`argus-assets engagement resolve-gates --manifest <manifest> --controller-token
<odysseus-token> [--evidence <path>]` records the verdicts exactly once. It prints `GATES  none`
and changes nothing when no lane is conditional. Otherwise it requires the active Odysseus
token (argument or `ARGUS_ENGAGEMENT_CONTROLLER_TOKEN`), `discovery` as the current phase,
and, when Kalchas is dispatchable, Kalchas's discovery arrival. A refused call interprets no
evidence and probes nothing. The evidence is Kalchas's
`solution/discovery/capability-evidence.json` (`argus/capability-evidence@1`, see
`CANONICAL-CONTRACTS.md`); `--evidence` resolves against the artifact root and must stay under
`solution/discovery`. It must be a non-aliased single-link regular file that validates and
names this engagement. An aliased, malformed, or foreign file is refused without recording
anything; a missing file leaves every evidence-backed gate unmet. Recon evidence is input,
never authority, so the runtime re-checks every gate it can:

| Gate | Proven only when | Basis |
|---|---|---|
| `browser-runtime` | A fresh functional probe launches headless Chromium; the probe rewrites `ai_agents_internal/browser-runtime.json` | `runtime-probe` |
| `source-access` | Kalchas recorded `proven`; `path` is a readable directory disjoint from the artifact root and inside `target.root` when one is recorded; `fileRead` is a readable regular file inside it; both are resolved physically | `kalchas-evidence+path-check` |
| `existing-suite` | The same checks, with `testFile` | `kalchas-evidence+path-check` |
| `non-rest-surface` | Kalchas recorded `proven` and every `surfaceId` exists in the validated `solution/surface-inventory.json` | `kalchas-evidence+inventory` |
| `db-access`, `multi-service` | Never by recon: the runtime cannot re-verify credentials or a service topology, so only an operator `--feature` at launch declares them | `operator-feature-required` |
| Any other gate | Never | `not-recon-provable` |

State then holds `gateResolution`: `resolvedAt`, `evidenceSha256` (the SHA-256 of the
evidence bytes, or `null`), one `{status: proven|unmet, basis, reason}` verdict per conditional
gate, and one outcome per conditional lane. The runtime computes every lane outcome itself,
`released` exactly when all of the lane's gates are proven and `gate-unmet` otherwise, and
never accepts a caller-supplied lane map. Reasons are fixed runtime strings, so no proof
value (path, host, query, or surface ID) enters state. The resolution is immutable: a second
run fails with `gate resolution is immutable once recorded`, and every state load re-checks
that the lane outcomes follow from the gate verdicts.

Discovery cannot advance while conditional lanes exist without a recorded resolution
(`discovery cannot advance before engagement resolve-gates records the conditional lane
verdicts`), because resolution is only possible during discovery. A conditional discovery
participant, such as Tiresias waiting on `source-access`, keeps the discovery barrier open
until it is released and arrives or is omitted. A released lane allocates and participates
normally. A `gate-unmet` lane is omitted: allocation fails with `<lane> was omitted: gate
unmet (<gates>)`, and the lane leaves every phase's participants and standby lanes exactly
like a role outside the dispatchable projection, so no barrier, standby window, or success
cleanup waits for it. Under the `selected-dispatchable-predecessors` dependency policy it
counts as a non-dispatched predecessor, and its unmet gates remain a named residual risk.

## Canonical machine contracts

The installed `schemas/` directory defines the versioned, machine-readable contracts:
`argus/bug-ledger@2`, `argus/lane-plan@2`, `argus/evidence-reference@3`,
`argus/automation-status@2`, `argus/runner-result@1`, `argus/surface-inventory@1`,
`argus/coverage-observations@2`, `argus/coverage-result@2`, `argus/automation-review@1`, and
the final-summary contract.
Canonical solution JSON documents are single-owner
`json-document` artifacts; the runner result is validated at its runner-owned report path.
Lane-plan, evidence-reference, automation-status, and coverage-observations (keyed by
`<lane>:<surfaceId>`) accept multiple valid collection fragments; their owner merges records
in stable-key order and rejects duplicate keys across fragments. Coverage observations cite
evidence and ledger references only: the coverage-result merge derives each surface's
execution, assertion, evidence, and automation flags from the canonical evidence registry,
takes defect outcomes from the canonical bug ledger (required whenever Minos is
dispatchable), credits a runner case only to a surface the merged automation status maps it
to (`runnerCaseMapping`), and rejects a Kleio result that differs from that recalculation. The controller validates
every fragment before it is persisted, verifies its `engagementId`, then validates the
deterministic merged document again; malformed, incompatible, duplicate, or
cross-engagement content cannot reach a canonical file.

Single-document supersession: every other canonical JSON document (bug ledger, surface
inventory, coverage result, final summary, automation review) is one complete document. Only its owner may
submit fragments; any other lane is refused at write time with `<path> is a single-document
contract; only <owner> may submit fragments`, so a non-owner can neither block nor poison
the merge. Every fragment record carries a `sequence` one above the highest sequence across
all canonicals (records written before sequences existed count as 0), and an identical
replay of the same id and lane keeps its original record. The owner republishes by
submitting a newer fragment. With more than one fragment, the merge digest-checks and
validates every fragment, orders them by sequence (a tie fails), requires each one to keep
its contract's stability invariants relative to its predecessor, and publishes only the
latest; the merge record adds `effectiveFragment` and `supersededFragments`. The bug ledger
keeps every earlier bug ID with at least its earlier origins, so an ID may change status but
is never removed or re-pointed; the surface inventory keeps every earlier `SRF-*` ID and never
lowers `discovery.candidates`. Fragments are immutable and never deleted, so a fragment that
breaks an invariant fails that merge and every later merge of the canonical, and the last
published document stays in place. A single fragment merges exactly as before.

Automation review: Aristarchus's `solution/automation-review.json` is append-only (a newer
fragment repeats every earlier review round unchanged), and its merge also requires the
latest round's `corpus.sha256` to equal the current test-corpus digest
(`argus-assets automation-review digest`). Aristarchus has no Write tool and submits each
cumulative document through `engagement fragment --json <single-line-object>`.
`argus-assets automation-review check` exits 0 for APPROVED or NOT-APPLICABLE, 13 for
BLOCKED, STALE, or ABSENT (a new round is required), and 14 for invalid input. See
`CANONICAL-CONTRACTS.md` "Automation review in 5.0".

`solution/final-summary.json` is the canonical final record. Its merge also renders
`solution/FINAL-SUMMARY.md` with an explicit `Source schema:` line, so the human-facing
summary is traceable to the machine contract. The lane-plan `lanes`, evidence-reference
`references`, and automation-status `tests` arrays contain unique records sorted by
`lane`, `id`, and `testId`; the final summary lists its source schemas and counts.

The per-contract version policy is `policies/schema-compatibility.json`. Unchanged
contracts remain v1-only. The three collection contracts and the bug ledger accept only
current v2. Retired shapes, such as `argus/bug-ledger@1`, fail closed; there is no guessed
or in-place migration, and a 4.x engagement finishes on its 4.9.x runtime. A future version
moves its expected-version row, compatibility policy, packaged consumers, and fixtures in one
change. The bug-ledger merge quarantines a row whose cited evidence fails reconciliation
instead of failing; see `CANONICAL-CONTRACTS.md` "Bug ledger v2 in 5.0". Maintainers run
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
For a worker, `success` cleanup is refused while anything is pending: a projected
participant phase without the lane's arrival, a participant phase not yet reached, or a
standby phase at or after the current phase. Skipped phases are never pending. The refusal
reads `<lane> success cleanup is not yet available: pending <phases in plan order>; the
lease stays active and Odysseus performs terminal cleanup`, and it leaves the lease intact.
Each lane therefore keeps one allocation for the whole engagement, and Odysseus performs its
terminal success cleanup once nothing is pending. `failure` and `interrupted` remain
available for earlier exits.
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
