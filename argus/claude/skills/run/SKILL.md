---
name: run
description: Run an Argus QA engagement from the main Claude Code thread, dispatching the installed Argus specialists and collecting their results.
argument-hint: "<target URL, running stack, repo path, and QA scope>"
disable-model-invocation: true
allowed-tools: Read, Agent, Bash(argus-assets *)
---

# Run Argus from the main thread

The target and QA scope are `$ARGUMENTS`. Remain the only controller in this conversation;
never spawn `argus:odysseus`. Read
`${CLAUDE_PLUGIN_ROOT}/skills/orchestration-core/SKILL.md` completely and execute that
controller contract. It owns mode outcomes, preflight, authorization, engagement leases,
RACI, templates, runner semantics, coverage, model routing, waves, validation, cleanup,
and final reporting. Do not read the Odysseus agent as a second policy source.

Reject empty input with `ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED`. Confirm `Agent` and at
least `argus:kalchas` plus another mode-required specialist are resolvable, then select one
Mode A, B, C, or D. Persist the machine projection with
`argus-assets orchestration plan --mode <A|B|C|D> --output ai_agents_internal/orchestration-plan.json`
and run packaged preflight before any target probe or dispatch. A failed mandatory check
stops with the exact fail-closed error and persisted evidence; it never becomes plan-only
success.

Join the projection's RACI-derived task/output contract with persisted preflight records.
Dispatch only selected `ready` or `degraded` specialists using exact namespaced
`argus:<slug>` types, immutable model decisions, isolated leases, and degraded actions.
Advance W0–W4 by dependency and barrier, collect every RESULT, validate canonical outputs,
and clean every worker on success, failure, or interruption. Never claim unavailable or
uncollected execution.

Close with verified preflight and authorization evidence, disposition counts, worker
contributions, deliverable paths, runner category outcomes, surface-derived coverage,
policy denials, residual risks, model-decision binding, barrier state, and zero-resource
cleanup. Keep defect yield separate from coverage and quality claims.

If `$ARGUMENTS` is exactly `ARGUS_ORCHESTRATION_SMOKE`, use `.` as a synthetic Mode A
target, run non-blocked preflight, allocate Kleio and Theseus, dispatch both concurrently
with exact no-tool replies `ARGUS_SMOKE_KLEIO_OK` and `ARGUS_SMOKE_THESEUS_OK`, collect the
markers, clean both leases, verify no active allocation or lock remains, and return exactly
`ARGUS_SMOKE_OK: argus:kleio,argus:theseus`. Any failure returns
`ARGUS_PREFLIGHT_ERROR: SMOKE_DISPATCH_FAILED` with concise evidence.
