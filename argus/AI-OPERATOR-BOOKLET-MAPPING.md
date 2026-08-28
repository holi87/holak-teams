# Argus QA — AI Operator Booklet (Part II) hardening map

This document dispositions every rule of the Sii Testing Lab *AI Operator Booklet*
(Part II, 15 rules / 6 gates) against the Argus QA multi-agent system. It exists so a
reviewer can confirm the booklet was actually applied to the agents — not only carried in
an operator's startup prompt, where a rule gets diluted across a multi-agent run.

**Guiding principle (booklet's own, enforced here):** the deliverable is proven, expensive
defects — not tests, not framework. A change that grows the framework but not the ability
to find and prove bugs was **not** made. Argus already encoded most of the booklet before
this pass; the `4.1.0` edits are the few genuine gaps, applied at the single correct owner
each.

Each item carries one disposition:

- **Enforced** — already binding in a shipped agent/skill; cited at its source.
- **Added in 4.1.0** — a new or sharpened rule introduced by this pass.
- **Engagement-runtime** — belongs to the per-run manifest/preflight/operator prompt, not
  to a permanent agent definition; encoding it into an agent would leak one engagement's
  scope into every future run.
- **Rejected** — deliberately not made, with the reason (usually: it grows framework, or
  duplicates an existing owner).

Paths are relative to the repo root. Agent bodies are the canonical sources in
`argus/roles/<slug>.md`; shared contracts are in `argus/shared-skills/<profile>/SKILL.md`
and preload into every role by the capability matrix.

---

## What changed in 4.1.0

Three canonical sources, each edit at the RACI-correct owner, all within the prompt-budget
and duplicate-doctrine gates (`node scripts/check-argus-prompts.mjs`: 0 regression
increases, 0 duplicated paragraphs).

| # | Source | Change | Booklet rule |
|---|---|---|---|
| 1 | `argus/shared-skills/qa-core/SKILL.md` | Oracle-independence guardrail: compute the expected value from the spec, never from the live response it judges; a live snapshot is a change-detector, not a correctness oracle; use a metamorphic invariant when the exact value is out of reach. | 1–2 |
| 2 | `argus/shared-skills/qa-core/SKILL.md` | Expensive-first prior: the costliest defects correlate inversely with detection; hold every funded surface at baseline breadth, then spend depth on the highest-consequence invariants first. | study finding, 15 |
| 3 | `argus/shared-skills/qa-core/SKILL.md` | Assertion-teeth rule: an assertion that still passes when its expected value is inverted has no teeth; treat it as absent. | 8, mutation |
| 4 | `argus/roles/metis.md` | Metamorphic oracles as a general strategy fallback (previously AI/LLM-only): idempotent re-submit, monotonic direction, illegal-transition invariants recorded as falsifiable `ORC-` ids. | 1–2 |
| 5 | `argus/roles/aristarchus.md` | Sharpened the mutation line into the explicit invert-value teeth check as a BLOCKER-class gate. | 8, 10 |

`qa-core` is preloaded by all 27 roles, so guardrails 1–3 reach every hunter's
depth-allocation decision, the verifier, and triage from one place — no duplication.

---

## Gate 1 — Independent correctness oracle (rules 1–2)

| Booklet item | Disposition | Where |
|---|---|---|
| Expected value derived from spec, computed independently before the app is called | **Enforced + Added** | `metis.md` "Spec-as-oracle"; strengthened by qa-core guardrail 1 (independent of the live response it judges) |
| `{expected, source}` output citing the doc/schema | **Enforced** | Metis owns `solution/ORACLES.md`; every oracle is an `ORC-<lane>-NNN` id each hunter must cite; an unsourced rule is a named residual risk, never invented |
| Metamorphic invariants when the formula is unknown/costly | **Added in 4.1.0** | qa-core guardrail 1 + `metis.md` "Metamorphic oracles when the exact value is out of reach" |
| Oracle never reads a live response to decide what is correct | **Added in 4.1.0** | qa-core guardrail 1 makes this explicit for every role |
| Fix: no golden files snapshotted from the running app | **Added in 4.1.0** | qa-core "a snapshot of current application behaviour is a change-detector, not a correctness oracle; never pin an expectation to it" |

## Gate 2 — Assertions at the right layer (rule 3)

| Booklet item | Disposition | Where |
|---|---|---|
| Business-value assertions go through the API; UI covers presentation/interaction only | **Enforced** | `metis.md` step 4 "API-first … PLUS a funded, first-class UI lane"; Atalanta owns API-layer business assertions, Orion/Lynceus own UI behaviour/presentation |
| Decisions/amounts/status asserted against the API payload, not scraped UI | **Enforced** | Metis "spec-as-oracle" + qa-coverage-reporting UI-vs-API reconciliation; Minos excludes "UI-render-of-API-bug" from unique coverage |
| Fix: a test that "passes" because the UI rendered while the API value was wrong | **Enforced** | Minos anti-pattern "counting UI-renders-of-API-bugs … as distinct unique coverage" |

## Gate 3 — Separate adversarial pass (rules 4–6)

| Booklet item | Disposition | Where |
|---|---|---|
| Adversarial work is a distinct pass after baseline coverage | **Enforced** | Hunters (Atalanta/Perseus/Orion/Lynceus/Ariadne/Hermes/Tyche) are separate roles from the automation engineers; dispatched as a parallel hunt wave, not interleaved into happy-path authoring |
| Every risk becomes ≥1 falsifying scenario | **Enforced** | `metis.md` risk register maps each `RISK-###` to mitigating tests/tags; Metis exit criterion "top risks each have ≥1 targeted test" |
| Tests written to refute the system | **Enforced** | Perseus "write refutation-oriented tests" / "Confirm before you write"; defect-clustering (Pareto) drill-where-bugs-appear |
| Fix: "coverage complete" treated as "quality verified" | **Enforced** | qa-core "counts never replace coverage"; Minos/Kleio coverage-vs-inventory reconciliation |

## Gate 4 — Response hygiene & security (rule 7)

The booklet's 5-point sweep maps one-to-one onto the Perseus security lane
(`argus/roles/perseus.md`), which runs independently of the domain tests.

| Sweep item | Disposition | Where |
|---|---|---|
| Sensitive fields — no PII/secret leakage in responses/errors | **Enforced** | Perseus "Sensitive-data exposure" |
| Endpoint authorization on every endpoint | **Enforced** | Perseus "Broken access control — full role × operation matrix" |
| CORS consistency / not over-permissive | **Enforced** | Perseus "Security misconfiguration … open CORS" |
| Garbage/fuzz validation rejected cleanly | **Enforced** | Perseus "Injection" + BVA-at-the-API oracles |
| Cross-role data visibility (IDOR on application IDs) | **Enforced** | Perseus "IDOR/BOLA on every `{id}` and `/{id}/*` sub-route" |
| Sweep runs even if domain coverage is incomplete | **Enforced** | Perseus dispatched concurrently with Aegis in the parallel hunt wave, "continuous from post-recon to the end" |

## Gate 6 — Verify before you believe (rules 8–11)

| Booklet item | Disposition | Where |
|---|---|---|
| Rule 8 — assertion-integrity guard; no relaxing/skipping/swallowing to go green | **Enforced** | Aristarchus forbidden-pattern BLOCKLIST (`.skip`/`xfail`/`test.fail`/`try…catch` swallow/`.only`/serial-hide/vacuous oracle), run as its own mechanical grep |
| Rule 9 — red-by-design: every bug ships a repro red against the app, green against the correct expected value | **Enforced** | Aristarchus "Structural RED/GREEN check"; Minos "No proof, no entry" |
| Rule 10 — a red test is a bug hypothesis first, flaky only after a demonstrated cause | **Enforced** | Aristarchus "Flaky-RED is a BLOCKER" (re-run ≥2×, no auto-quarantine) |
| Rule 11 — independent re-verification by a different agent/session | **Enforced** | The finder (hunter) and the validator (Minos) and the test-honesty reviewer (Aristarchus) are structurally distinct roles; Minos "re-judge every rating from evidence, not from the filing hunter's first guess" |
| Mutation / invert-value teeth check | **Added in 4.1.0** | qa-core guardrail 3 (universal) + `aristarchus.md` explicit invert-value BLOCKER gate |
| Fix: auto-classify reds as flaky / auto-retry-until-green / "make it pass" | **Enforced** | Aristarchus anti-patterns + blocklist |

## Cross-cutting rules 12–15

| Rule | Disposition | Where / reason |
|---|---|---|
| 12 — persistent shared context (AGENTS.md) every agent reads/updates | **Engagement-runtime** | Provided by `ai_agents_internal/` engagement state + persisted `solution/surface-inventory.json` (Kalchas), `TEST-STRATEGY.md`/`ORACLES.md` (Metis), and the machine orchestration plan — read by every dispatched role. A new canonical `AGENTS.md` artifact is **Rejected**: it would need RACI + schema + sync wiring (framework growth the booklet bans) and duplicate the existing sources of truth. |
| 13 — structured decision log (proposals/rejections/confirmed defects) | **Enforced (equivalent) / Engagement-runtime** | `solution/BUG-LEDGER.md` + `solution/bug-ledger.json` (Minos: confirmed defects, dedup, bounced-back); `ai_agents_internal/authorization-audit.jsonl` (redacted decision events); Kleio's per-agent AI-collaboration log (kept vs rejected, why). A separate `decision-log.md` is **Rejected** for the same anti-overbuild reason. |
| 14 — don't build a framework instead of finding bugs | **Enforced** | `orchestration-core` Mode B: "Do not build a framework"; Kleio measures phase output as defects proven, not harness; qa-core "counts never replace coverage". Framework-time cap is **Engagement-runtime** (operator budget). |
| 15 — test count is not the metric | **Enforced** | qa-core "counts never replace coverage"; Minos "Report the unique count, never the inflated raw find count"; Kleio coverage-adequacy gate leads with defects + severity and reconciles coverage-vs-inventory; success = cost-weighted proven defects (reinforced by qa-core expensive-first prior). |

## Section 0 — pre-flight, scope guards, shared artifacts

| Booklet item | Disposition | Where / reason |
|---|---|---|
| Inventory the agent set (agent → responsibility → I/O → DoD) | **Enforced** | Generated capability + RACI matrices (`argus/capabilities/`, `argus/raci.json` → `RACI-CONTRACT.md`); preflight emits a per-role `ready/degraded/deferred/skipped/blocked` disposition |
| Confirm launch mode & fallback; `ARGUS_LAUNCH_UNATTESTED=1` works | **Enforced** | `orchestration-core` fail-closed preflight + the unattested exception (`--unattested-launch`, `trust=unattested`, operator/Codex escalation stays blocked) |
| DB out of scope enforced in tooling, not prose | **Enforced (by gating)** | DB is reachable only through the gated Charon/Mnemosyne roles when `db-access` is `ready`; every other role has no DB tool in its capability-matrix-pinned allowlist, and unknown/staging/production targets are read-only by default. There is no DB MCP tool in the plugin to remove; scope is enforced by disposition-gating, checked by `check-argus-prompts` tool-boundary assertion. |
| Argus-only tooling | **Enforced** | Each role's `tools` frontmatter is pinned by the capability matrix and asserted (`frontmatter tools differ from requiredTools + toolProfiles` fails the gate) |
| Shared `AGENTS.md` + `decision-log.md` | **Rejected as new artifacts** | See rules 12–13 above — mapped to existing sources of truth. |

## Sections 6–7 — time budget, quick audit

- **Time-budget protocol (Phase 1/2/3 minutes, framework cap, spillover):**
  **Engagement-runtime.** Wall-clock budgets are the operator's per-run choice and Odysseus's
  orchestration policy, not a permanent agent constant. The *behaviour* they protect
  (baseline breadth then depth on expensive defects; stop building framework once plumbing
  runs) is enforced by qa-core guardrail 2 and Mode B.
- **Quick audit checklist:** every line resolves to an **Enforced** row above — oracle /
  adversarial / verifier separated from the test author; oracle from spec not golden files;
  API-layer business assertions; distinct post-coverage adversarial pass; the 5-point
  security sweep; invert-value teeth; no DB tools; success = cost-weighted proven defects;
  unattested launch verified.

---

## Independence summary (the booklet's core structural demand)

The booklet requires the Oracle, the Adversarial pass, and the Verifier to be distinct from
the agent that writes the tests. Argus satisfies this by construction:

- **Oracle** — Metis (`ORACLES.md`), never a hunter or an automation engineer.
- **Adversarial** — the hunter lanes (Atalanta, Perseus, Orion, Lynceus, Ariadne, Hermes,
  Tyche, Charon, Antigone), never the engineers who automate their confirmed defects.
- **Verifier** — Aristarchus (test-code honesty, read-only) plus Minos (defect validation,
  dedup, ranking), both independent of the filing hunter and the test author.
- **Automation** — Talos/Daidalos/Aegis/Nike/Mnemosyne, who only automate defects Minos has
  already confirmed.

No single role finds, validates, and automates its own defect.

---

## Appendix — model tier verification

The booklet run assumes the frontier roles reason on the strongest available model. Status:

- The 10 frontier roles (`ariadne`, `aristarchus`, `atlas`, `kalchas`, `metis`, `minos`,
  `odysseus`, `perseus`, `tiresias`, `tyche`) declare `model: opus`; the 17 execution roles
  declare `model: sonnet`. Both are generated from `argus/model-policy.json` (frontier tier
  `claude.model = opus`).
- `opus` is an **alias**. Claude Code 2.1.250 resolves it to the latest opus family member,
  `claude-opus-5` (CLI alias table `opus → claude-opus-5`; verified on live agent runs via
  `--output-format json` `modelUsage.canonicalModel`). No repo change is needed for the
  frontier roles to request Opus 5. Pinning an exact id is deliberately **not** done — the
  alias floats forward with the CLI, and an exact pin recreates the staleness it would try
  to fix.
- Which model actually **serves** a completion, and any runtime fallback to a previous opus
  (e.g. `claude-opus-4-8`), is decided by the Claude Code CLI at request time from account
  capacity/quota — **not** by the agent definition. Verified: an exact
  `model: claude-opus-5` pin falls back identically to the alias, so the fallback is outside
  repo control. The only in-repo lever is the tier request, which is set to Opus 5.
