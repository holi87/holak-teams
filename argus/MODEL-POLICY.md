# Argus Runtime Model Policy

Policy ID: `argus/model-policy@1`. The machine-readable source is [`model-policy.json`](model-policy.json).

The adopted baseline assigns 10 high-consequence roles to frontier reasoning and 17 bounded execution roles to standard reasoning. No complete role uses the mechanical tier.

| Agent | Tier | Claude | Effort | Codex | Effort | Max turns | Escalation | Fallback |
|---|---|---|---|---|---|---:|---|---|
| aegis | standard | sonnet | medium | terra | medium | 48 | execution | upward-only |
| antigone | standard | sonnet | medium | terra | medium | 40 | judgment | upward-only |
| ariadne | frontier | opus | max | sol | xhigh | 56 | judgment | frontier-fail-closed |
| aristarchus | frontier | opus | max | sol | xhigh | 40 | judgment | frontier-fail-closed |
| asklepios | standard | sonnet | medium | terra | medium | 40 | judgment | upward-only |
| atalanta | standard | sonnet | medium | terra | medium | 48 | execution | upward-only |
| atlas | frontier | opus | max | sol | xhigh | 64 | analysis | frontier-fail-closed |
| charon | standard | sonnet | medium | terra | medium | 40 | execution | upward-only |
| daidalos | standard | sonnet | medium | terra | medium | 56 | execution | upward-only |
| hermes | standard | sonnet | medium | terra | medium | 40 | analysis | upward-only |
| kalchas | frontier | opus | max | sol | xhigh | 48 | analysis | frontier-fail-closed |
| kleio | standard | sonnet | medium | terra | medium | 40 | judgment | upward-only |
| lynceus | standard | sonnet | medium | terra | medium | 40 | judgment | upward-only |
| metis | frontier | opus | max | sol | xhigh | 48 | analysis | frontier-fail-closed |
| minos | frontier | opus | max | sol | xhigh | 48 | judgment | frontier-fail-closed |
| mnemosyne | standard | sonnet | medium | terra | medium | 48 | execution | upward-only |
| nike | standard | sonnet | medium | terra | medium | 56 | execution | upward-only |
| odysseus | frontier | opus | max | sol | xhigh | 96 | orchestration | frontier-fail-closed |
| orion | standard | sonnet | medium | terra | medium | 48 | execution | upward-only |
| penelope | standard | sonnet | medium | terra | medium | 40 | schema-bound | upward-only |
| perseus | frontier | opus | max | sol | xhigh | 56 | judgment | frontier-fail-closed |
| pistis | standard | sonnet | medium | terra | medium | 40 | schema-bound | upward-only |
| proteus | standard | sonnet | medium | terra | medium | 48 | execution | upward-only |
| talos | standard | sonnet | medium | terra | medium | 56 | execution | upward-only |
| theseus | standard | sonnet | medium | terra | medium | 40 | schema-bound | upward-only |
| tiresias | frontier | opus | max | sol | xhigh | 48 | analysis | frontier-fail-closed |
| tyche | frontier | opus | max | sol | xhigh | 48 | judgment | frontier-fail-closed |

## Routing rules

- Standard roles escalate upward to frontier on their declared ambiguity, safety, cross-lane, evidence, failure, or turn-limit signals.
- Frontier roles never fall back to a weaker model. Unavailability blocks the dispatch and escalates to the operator.
- Claude enforces the complete reviewed baseline in native agent frontmatter. Its current dispatch adapter blocks an escalation because no verified per-dispatch effort override exists. Codex native config enforces model and effort but blocks until the parent can also enforce max turns. Every runtime fails closed when model, effort, and turn cap cannot be honored together.
- Haiku/Luna is reserved for a future bounded subrole with no quality judgment, a deterministic output schema, and a validator that passes before merge.
- Worker prompts contain only their turn cap, declared signals, and the `argus/model-escalation-request@1` stop envelope. They never select a model, invoke routing, or write telemetry.
- Odysseus and `/argus:run` alone validate escalation envelopes, increment attempts, create a fresh thread for a selected decision, and bind telemetry to that immutable decision.
- `argus-assets model route` validates the engagement and trusted adapter snapshot, then atomically persists a selected or blocked immutable decision under `ai_agents_internal/model-decisions/`. `argus-assets model telemetry` accepts only that exact decision and writes sanitized usage metrics bound to its ID and hashes.

## Benchmark

The committed `model-policy.benchmark.json` compares representative synthesis, judgment, and schema-bound work on quality markers, latency, input/output tokens, and provider-reported cost without storing prompts, completions, targets, accounts, or evidence.
