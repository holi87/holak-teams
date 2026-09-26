# Argus Runtime Model Policy

Policy ID: `argus/model-policy@1`. The machine-readable source is [`model-policy.json`](model-policy.json).

The adopted baseline (`adopt-27-frontier-0-standard`) assigns 27 roles to frontier reasoning and 0 roles to standard reasoning. Both counts are derived from the role tiers below, and validation rejects a baseline whose counts or decision string differ from them. No complete role uses the mechanical tier.

- Frontier floor: every role whose escalation profile is `orchestration`, `judgment`, or `analysis`, and every RACI lane ending in `-hunt`, always uses the frontier tier.
- A standard role is valid only with a matching `baseline.standardAllowlist` entry that names it and states a justification of at least 20 characters; an allowlist entry for a role that is not standard is rejected.

| Agent | Tier | Claude | Effort | Codex | Effort | Max turns | Escalation | Fallback |
|---|---|---|---|---|---|---:|---|---|
| aegis | frontier | opus | max | sol | xhigh | 100 | execution | frontier-fail-closed |
| antigone | frontier | opus | max | sol | xhigh | 140 | judgment | frontier-fail-closed |
| ariadne | frontier | opus | max | sol | xhigh | 160 | judgment | frontier-fail-closed |
| aristarchus | frontier | opus | max | sol | xhigh | 120 | judgment | frontier-fail-closed |
| asklepios | frontier | opus | max | sol | xhigh | 100 | judgment | frontier-fail-closed |
| atalanta | frontier | opus | max | sol | xhigh | 160 | execution | frontier-fail-closed |
| atlas | frontier | opus | max | sol | xhigh | 100 | analysis | frontier-fail-closed |
| charon | frontier | opus | max | sol | xhigh | 120 | execution | frontier-fail-closed |
| daidalos | frontier | opus | max | sol | xhigh | 140 | execution | frontier-fail-closed |
| hermes | frontier | opus | max | sol | xhigh | 120 | analysis | frontier-fail-closed |
| kalchas | frontier | opus | max | sol | xhigh | 120 | analysis | frontier-fail-closed |
| kleio | frontier | opus | max | sol | xhigh | 120 | judgment | frontier-fail-closed |
| lynceus | frontier | opus | max | sol | xhigh | 160 | judgment | frontier-fail-closed |
| metis | frontier | opus | max | sol | xhigh | 80 | analysis | frontier-fail-closed |
| minos | frontier | opus | max | sol | xhigh | 200 | judgment | frontier-fail-closed |
| mnemosyne | frontier | opus | max | sol | xhigh | 100 | execution | frontier-fail-closed |
| nike | frontier | opus | max | sol | xhigh | 100 | execution | frontier-fail-closed |
| odysseus | frontier | opus | max | sol | xhigh | 96 | orchestration | frontier-fail-closed |
| orion | frontier | opus | max | sol | xhigh | 160 | execution | frontier-fail-closed |
| penelope | frontier | opus | max | sol | xhigh | 80 | schema-bound | frontier-fail-closed |
| perseus | frontier | opus | max | sol | xhigh | 160 | judgment | frontier-fail-closed |
| pistis | frontier | opus | max | sol | xhigh | 80 | schema-bound | frontier-fail-closed |
| proteus | frontier | opus | max | sol | xhigh | 140 | execution | frontier-fail-closed |
| talos | frontier | opus | max | sol | xhigh | 140 | execution | frontier-fail-closed |
| theseus | frontier | opus | max | sol | xhigh | 100 | schema-bound | frontier-fail-closed |
| tiresias | frontier | opus | max | sol | xhigh | 140 | analysis | frontier-fail-closed |
| tyche | frontier | opus | max | sol | xhigh | 160 | judgment | frontier-fail-closed |

## Routing rules

- Standard roles escalate upward to frontier on their declared ambiguity, safety, cross-lane, evidence, failure, or turn-limit signals.
- Frontier roles never fall back to a weaker model. Their declared escalation signals and model unavailability block the dispatch pending an explicit operator decision.
- Before routing, the host trust store must contain distinct active Ed25519 anchors for runtime control and human operator approval. `model trust` pins their identities and the secure absolute host-store path. Every request, route, allocation, retry, and telemetry operation reopens that live store and rejects a revoked, replaced, or missing key immediately. Private keys and generic signing services remain outside the controller and worker boundary.
- The controller persists a normal attempt-1 selected decision for Odysseus and every projection-selected worker whose current preflight record is `ready` or `degraded` with `dispatchAllowed=true` before any allocation. That exact dispatchable set is sealed into engagement state and becomes the immutable participant filter for phase barriers; deferred, skipped, and blocked roles cannot allocate or create false quorum. It allocates Odysseus first against its exact decision and retains that lane token as the controller token, then authenticates each exact decision-bound worker allocation with that token. Workers receive only their own lane token and public decision/resource coordinates. A missing or blocked selection in the sealed set stops, and a new normal attempt-1 dispatch after the first allocation is forbidden.
- `argus-launch` is the only supported Claude entry point. An isolated runtime-attestation signer authorizes the exact short-lived engagement, arguments, executable hashes, and native `--max-turns 96` envelope. A one-shot random inherited capability whose digest is signed prevents public-string or file-only replay. Odysseus starts in print mode with exact `opus` / maximum effort, no session persistence, an explicit environment allowlist, and an OS sandbox whose only writable root is the alias-free artifact boundary. Preflight blocks direct or replayed `/argus:run` sessions.
- The installed Codex CLI can enforce model and reasoning effort but exposes no native hard turn cap. Codex routing therefore remains `CAPABILITY_DRIFT` and cannot be unlocked by a signed claim or approximate wrapper counter. Generated Codex agents remain configuration-parity artifacts for a future runtime that can enforce the complete envelope.
- Haiku/Luna is reserved for a future bounded subrole with no quality judgment, a deterministic output schema, and a validator that passes before merge.
- Worker prompts contain only their local turn cap, declared signals, agent binding, and the shared `argus/model-escalation-request@1` stop contract from `qa-core`. They never select a model, invoke routing, or write telemetry.
- Odysseus and `/argus:run` alone persist and route escalation envelopes. `model request` requires the exact active lane token and binds a declared worker escalation to that allocation, original dispatch ID, current checkpoint, and prior immutable decision. After allocation begins, `model route` also requires the active Odysseus controller token. Before retry rebind, the controller emits telemetry for the completed decision. `engagement start-attempt` then consumes the current lane token, atomically rotates it on the same dispatch/allocation, and returns the next token once; the controller replaces the stale token before spawning the new thread.
- Frontier declared-signal escalation first persists a blocked decision. Continuation or abort requires a human-authorized `argus/model-operator-decision@1` signed by the isolated `operator-approval` key; the controller and runtime wrapper cannot author, sign, or replace it.
- `model-unavailable` is valid only after a selected prior attempt on the exact dispatch and an active allocation. When failure occurs before spawn it uses the immutable prior-decision/allocation availability binding and may have no checkpoint; a declared signal from a running worker always uses its authenticated checkpoint. A frontier route then blocks without weakening; an external operator may choose `retry-frontier` after availability recovery or `abort`, while a standard role may move only upward to frontier.
- Preflight accepts `--model-runtime claude|codex`; Claude requires the signed launch authorization, verified receipt, public trust store, and inherited private launch capability. Codex is blocked with the exact missing capability instead of silently presenting Claude readiness.
- `argus-assets model route` validates signatures, bindings, and the trusted adapter snapshot, then permits at most one selected decision per engagement/agent/runtime/dispatch/attempt. An exact authenticated replay returns that immutable decision; a refreshed or otherwise different signed document for the same attempt conflicts and fails closed. `model telemetry` requires the matching current lane token, atomically accepts exactly one event per selected decision, and must be written before retry rebind or cleanup changes the active binding. It contains only sanitized lane-reported operational metrics and is not authoritative billing, benchmark, or outcome evidence.

## Benchmark

The committed `model-policy.benchmark.json` compares representative synthesis, judgment, and schema-bound work on quality markers, latency, input/output tokens, and provider-reported cost without storing prompts, completions, targets, accounts, or evidence.
The benchmark is historical: it was recorded under an earlier baseline, and its `decision`, `policyId`, and per-scenario tiers keep the values that were in force when the runs were recorded. It measures three work classes, not individual roles, and it is never the evidence for a particular role-to-tier assignment. That evidence lives in the answer-key review recorded in `AI-OPERATOR-BOOKLET-MAPPING.md`.
`node scripts/benchmark-argus-model-policy.mjs --check` validates the recorded evidence and prints non-fatal NOTE lines when the current policy identity, baseline decision, or a scenario role tier has drifted from the recorded values. Re-record with `--record` when fresh comparative evidence is wanted; the recorded timestamp shows when a stamp was last earned.
