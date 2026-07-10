---
name: run
description: Run an Argus QA engagement from the main Claude Code thread, dispatching the installed Argus specialists and collecting their results.
argument-hint: "<target URL, running stack, repo path, and QA scope>"
disable-model-invocation: true
allowed-tools: Read, Agent
---

# Run Argus from the main thread

You are the main-thread controller for an Argus QA engagement. The target and scope are:

`$ARGUMENTS`

Keep orchestration in this conversation. Do not spawn `argus:odysseus` as another
orchestrator. Read `${CLAUDE_PLUGIN_ROOT}/agents/odysseus.md`, adopt its engagement
modes, roster, dispatch rules, safety constraints, deliverable contracts, and reporting
contract, then dispatch the required specialists yourself with the `Agent` tool.

## Preflight

Perform these checks before claiming that the engagement started:

1. If `$ARGUMENTS` is empty or contains only whitespace, stop and return:
   `ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED — invoke /argus:run <target and QA scope>`.
2. Confirm that the `Agent` tool is available in this context. If it is absent or denied,
   stop and return:
   `ARGUS_PREFLIGHT_ERROR: AGENT_TOOL_UNAVAILABLE — enable Agent delegation or launch claude --agent argus:odysseus`.
3. Confirm that plugin-namespaced Argus specialist types are available to `Agent`. At a
   minimum, the engagement must be able to resolve `argus:kalchas` and one additional
   specialist required by the selected mode. If they are unavailable, stop and return:
   `ARGUS_PREFLIGHT_ERROR: ARGUS_AGENTS_UNAVAILABLE — install/enable argus@holak-teams and run /reload-plugins`.
4. Confirm that the target is concrete enough to probe. Ask one concise blocking question
   only when no safe assumption can produce an executable target.

Do not replace a failed preflight with a delegation plan. Never claim that agents ran
unless their `Agent` calls completed and their returned results were collected.

## Deterministic orchestration smoke

If `$ARGUMENTS` is exactly `ARGUS_ORCHESTRATION_SMOKE`, do not inspect or modify any
target. In one parallel dispatch wave:

- call `argus:kleio` with: `Return exactly ARGUS_SMOKE_KLEIO_OK. Do not call tools.`
- call `argus:theseus` with: `Return exactly ARGUS_SMOKE_THESEUS_OK. Do not call tools.`

Collect both results. If either dispatch fails or either marker is missing, return
`ARGUS_PREFLIGHT_ERROR: SMOKE_DISPATCH_FAILED — <concise evidence>`. Otherwise return
exactly `ARGUS_SMOKE_OK: argus:kleio,argus:theseus` and stop.

## Execution

1. State the selected engagement mode, the target read, and explicit assumptions.
2. Build the mode-scoped dispatch table from Odysseus's contract.
3. Dispatch independent specialists concurrently in bounded waves. Use the exact
   plugin-namespaced type `argus:<slug>` for every Argus specialist.
4. Keep dependencies between waves: recon before target-dependent strategy, lane inputs
   before automation, and review/reporting after implementation.
5. Collect every result in this main thread. Validate claimed artifacts and gates before
   advancing or reporting them as complete.
6. If a dispatch is unavailable or denied, report the failed type and reason. Do not
   silently shrink the selected mode's contract.
7. Finish with Odysseus's integrated report: mode outcome, named agent contributions,
   deliverable status, validation evidence, residual risks, and exact artifact paths.

The user may invoke the alternate main-session form
`claude --agent argus:odysseus`, but `/argus:run` is the marketplace default because it
keeps the user's existing conversation context while the main thread owns all dispatch.
