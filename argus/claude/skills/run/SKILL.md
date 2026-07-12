---
name: run
description: Run an Argus QA engagement from the main Claude Code thread, dispatching the installed Argus specialists and collecting their results.
argument-hint: "<target URL, running stack, repo path, and QA scope>"
disable-model-invocation: true
allowed-tools: Read, Agent, Bash(argus-assets *)
model: opus
effort: max
---

# Run Argus from the main thread

This skill is executable only inside a session started by
`${CLAUDE_PLUGIN_ROOT}/bin/argus-launch`. Preflight must observe the launcher's native
turn-cap and OS-sandbox binding. A direct skill or agent invocation stops before target
probing or specialist dispatch.

`$ARGUMENTS` is the target and QA scope. Stay the sole controller; never spawn
`argus:odysseus`. Read `${CLAUDE_PLUGIN_ROOT}/skills/orchestration-core/SKILL.md` completely
and execute it as the only controller policy. Do not read the Odysseus agent as a second policy source.

Reject empty input with `ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED`. Confirm `Agent` and two
required specialists, choose Mode A–D, and run `argus-assets preflight --target <target> --mode <A|B|C|D> --artifact-root <artifact-root>`. A mandatory failure stops with evidence.
Pin the public-only host trust store's distinct `runtime-attestation` and
`operator-approval` IDs, then rerun preflight; never sign, access private keys, or accept
first-use trust. Persist exactly one normal attempt-1 decision for Odysseus and every
selected agent whose current disposition is `ready` or `degraded` with
`dispatchAllowed=true`.
Allocate Odysseus first with its decision, then workers with their decisions and its
controller token. Give workers only their own lane token and public coordinates. Reject
late normal routes; retries keep the dispatch/allocation and run `engagement start-attempt`
after emitting prior-attempt telemetry. Capture its returned lane token, replace the
consumed token, and only then start the new thread; the stale token is revoked.

Dispatch only persisted `ready`/`degraded` roles as exact `argus:<slug>` types. Follow the
RACI projection and W0–W4 barriers. The sealed dispatchable projection is the immutable
barrier-participant set; worker `success` cleanup requires every declared arrival, and
heartbeats are allocation/dispatch/attempt-generation-bound. Collect every RESULT, validate
canonical outputs, run gates, and clean all allocations on success, failure, or interruption. Report verified
preflight/authorization, contributions, paths, runner categories, surface-derived coverage,
denials, residual risk, model bindings, barriers, and cleanup. Never equate defect yield
with coverage or claim uncollected work.

For exact input `ARGUS_ORCHESTRATION_SMOKE`, use `.` as synthetic Mode A. Pin both trust
anchors, rerun non-blocked preflight, and persist one normal attempt-1 decision per
dispatchable selected agent before allocation. Allocate Odysseus first, then only Kleio and Theseus using their
decisions and the controller token. Dispatch both concurrently with only their lane tokens
and public coordinates; require exact no-tool replies `ARGUS_SMOKE_KLEIO_OK` and
`ARGUS_SMOKE_THESEUS_OK`. Collect them, clean all three leases as interrupted unless the
terminal phase was reached, verify no active allocation/lock, and return exactly
`ARGUS_SMOKE_OK: argus:kleio,argus:theseus`. Otherwise return
`ARGUS_PREFLIGHT_ERROR: SMOKE_DISPATCH_FAILED` with concise evidence.
