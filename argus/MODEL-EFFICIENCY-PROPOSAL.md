# Argus 5.0.1 approved model allocation

The owner approved this allocation on 2026-09-28 for branch `5.0.1`, based on
default-branch commit `e1ea4ed44f0bcc1f2a0c076c3057d1f3afa124ab` (`master`). It replaces
the 5.0 baseline of 27 Claude Opus/max and Codex Sol/xhigh roles. Approval selects
the configuration; comparative model-quality and cost evaluation remains pending.

The 16 Sonnet slots pin `claude-sonnet-5-5` for
[Sonnet 5.5, released on 2026-09-28](https://platform.claude.com/docs/en/models/sonnet-5-5/overview).
Family aliases resolve to this exact ID; selecting a later family version requires
an explicit policy update. Role assignments and effort are unchanged by this model revision.

## Approved mapping

| Roles | Count | Claude | Codex | Rationale |
|---|---:|---|---|---|
| Odysseus, Metis, Minos, Aristarchus | 4 | Opus 5.5 / max | GPT-6 Sol / xhigh | Orchestration, strategy/oracles, defect adjudication and independent test-quality judgment affect the entire engagement. |
| Ariadne, Perseus, Tyche, Tiresias, Atlas, Kalchas, Kleio | 7 | Opus 5.5 / high | GPT-6 Sol / high | Lifecycle/races, security chains, recovery, source-flow analysis, shared harness, reconnaissance and final coverage/GO-NO-GO decisions. |
| Antigone, Atalanta, Charon, Hermes, Lynceus, Orion, Proteus, Nike, Asklepios | 9 | Sonnet 5.5 / high | GPT-6 Sol / high | Contract-guided hunting, performance/resilience automation and root-cause diagnosis of existing tests. These retain full evidence and judgment obligations. |
| Aegis, Daidalos, Mnemosyne, Talos, Penelope, Pistis, Theseus | 7 | Sonnet 5.5 / medium | GPT-6 Sol / medium | Implement established baselines and confirmed defects, or derive bounded path/consumer-contract specifications from documented sources. |
| **Total** | **27** | **4 Opus/max; 7 Opus/high; 9 Sonnet/high; 7 Sonnet/medium** | **4 Sol/xhigh; 16 Sol/high; 7 Sol/medium** | **11 frontier; 16 standard; 0 mechanical full roles.** |

The canonical policy uses per-role execution profiles rather than deriving the
model and effort solely from a quality tier. A standard role still has to justify
its allowlist entry and satisfy the same responsibility, evidence and safety
contracts. The allocation does not relax an oracle or accept weaker proof.
Deep-hunt passes use `modelSelection: role-execution-profile` and retain each
role's assigned model and effort.

Odysseus retains maximum effort for the entire launch as an explicit conservative
choice. A later comparison may evaluate high effort for routine dispatch and
maximum effort for planning or disputes; phase-specific switching is not claimed
by this allocation. Kleio remains Opus/high because it owns coverage adequacy and
GO/NO-GO, not just report formatting. Kalchas and Atlas remain Opus/high because
errors in reconnaissance or the shared harness propagate across lanes.

| Model | Explicit provider ID | Use |
|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | 11 complete Claude roles |
| Sonnet 5.5 | `claude-sonnet-5-5` | 16 complete Claude roles |
| GPT-6 Sol | `gpt-6-sol` | 27 complete Codex role configurations |
| GPT-6 Astra | `gpt-6-astra` | Bounded high-effort escalation only |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | Eligible bounded helpers only; no complete role |
| GPT-6 Luna | `gpt-6-luna` | Eligible bounded helpers only; no complete role |

## Escalation and operational limits

Astra/high is reserved for a specific unresolved question: contradictory evidence,
consequential oracle disputes, difficult cross-lane reasoning or a complex defect
hypothesis. Supply the relevant evidence and checkpoint, and retain dispatch,
lease, authorization and budget checks. It is not a permanent controller or a
routine bookkeeping model. Configuration alone does not prove live Astra access.
Standard roles have at most one upward escalation per dispatch
(`fallbackPolicies.upward-only.maxEscalations = 1`); repeated escalation cannot
renew their turn budget indefinitely.

The existing fail-closed boundaries remain:

- **Codex:** no verified native hard turn cap means `CAPABILITY_DRIFT` for Argus
  dispatch, including Astra. Loading generated TOMLs is configuration validation,
  not operational Argus support. A signed claim or approximate wrapper counter
  cannot supply the missing enforcement.
- **Claude:** model-only Sonnet/high to Opus/high escalation preserves the role's
  generated effort and native turn cap, with signed launcher proof of pinned
  model aliases; this override is unavailable in unattested mode. Routes that
  change effort remain blocked. The selected
  model, effort, checkpoint, lease and authorization must remain bound together;
  changing capability flags alone is insufficient.
- **Controller:** the launcher must bind `claude-opus-5-5`, maximum effort and the
  native 400-turn cap, with 30 turns reserved for closeout. Claude Code 2.1.284 or
  newer within 2.x is required. Role frontmatter alone
  does not set the main-thread launch arguments.

The launcher disables automatic model substitution with `switchModelsOnFlag: false`;
provider refusals remain refusals. Real API model, billing and quality verification
for this allocation is still pending.

Haiku/Luna eligibility is limited to constrained transformations without quality
judgment, such as extracting declared endpoint fields into a validated schema or
formatting approved canonical facts. Prefer an existing deterministic CLI where
possible. Do not delegate oracle definition, defect confirmation, severity or
delivery approval to these helpers. Haiku 4.5 does not support effort; a bounded
helper must not imply that a configured effort value is natively enforced. This
allocation adds no complete helper role or verified helper execution path.

Continuation tuning is a separate follow-up. In particular, zero candidates with
complete coverage and evidence should not itself motivate more hunting. This
model allocation does not change the existing frontier continuation policy.

## Economic rationale

Published Standard API rates checked on 2026-09-28, USD per million uncached
input/output tokens, short context, excluding tools and cache operations:

| Model | Input | Output |
|---|---:|---:|
| Opus 5.5 | $4 | $20 |
| Sonnet 5.5 | $2 | $10 |
| Haiku 4.5 | $1 | $5 |
| GPT-6 Sol | $2 | $10 |
| GPT-6 Astra | $10 | $50 |
| GPT-6 Luna | $0.10 | $0.50 |
| GPT-5.6 Terra | $2 | $12 |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Sonnet has half the Opus token rate under these assumptions, but moving 16 roles
does not imply a 50% engagement saving. Token volume, reasoning, retries, cache
reuse and tool waits differ by role. Astra costs five times Sol per token; Terra
is not a cheaper replacement for Sol at these rates. Subscription limits require
separate measurement. Reduced effort is the initial Codex efficiency hypothesis;
no saving or quality-preservation percentage has been measured.

## Validation plan

The historical `model-policy.benchmark.json` is synthetic, covers three Claude
prompts and records an older 12-frontier/15-standard decision. Those prompts
supply the expected answer markers; the scorer checks their inclusion. They do
not demonstrate discovery quality or measure this allocation, and there is no
Codex/Astra comparison. The discovery baseline remains `not-recorded` and its
quality gate inactive until an adjudicated baseline is recorded.

Compare the old and new configurations on the same private, adjudicated faulty
and clean targets with at least three repeats per compared mode. Hold targets,
tools, authorization, scope and coverage constant. Record actual runtime model
IDs and effort, not only the requested configuration. Measure:

- Recall and critical recall: no decrease against the paired baseline.
- Precision: within the existing 0.05 tolerance, including clean-target runs.
- Independent reproduction, regression fail-to-pass and final coverage.
- Usage, cache use, cost or subscription consumption, wall time, continuations
  and escalation frequency.
- Cost per independently confirmed defect together with completed clean-run
  cost, so clean targets do not incentivize fabricated findings.

Release, parity and routing checks validate implementation contracts; they do
not replace comparative model evaluation or establish successful live routing.

References: [Claude model configuration](https://code.claude.com/docs/en/model-config),
[Claude subagents](https://code.claude.com/docs/en/sub-agents),
[Claude models](https://platform.claude.com/docs/en/models/overview),
[Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents),
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
