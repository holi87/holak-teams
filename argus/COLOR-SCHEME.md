# Argus QA — Agent colour scheme

> The `color:` frontmatter field on each agent def is **purely cosmetic** — it tints the agent's
> name/label badge in the Claude Code `/agents` manager, running-agent indicators, and the
> multi-agent view. It has ZERO effect on behaviour, tools, model, or routing.

## Why named colours (not hex)
Claude Code officially supports only **6 NAMED colours**: `blue, cyan, green, yellow, magenta, red`.
Arbitrary hex (e.g. `#6366F1`) may render in some surfaces but is **not officially supported and
strips on CLI restart** (gh issue #57044). So every Argus QA def uses a named colour from the 6.
No icons / emoji / custom display-name are supported — only `name` + `color`.

## The scheme — colour = ROLE TYPE (legible at a glance in a parallel run)
| Colour | Role type | Meaning |
|---|---|---|
| **cyan** | Core / lead | coordination, analysis, strategy, triage, reporting |
| **red** | Bug hunters (black-box) | adversarial, exploratory defect FINDING |
| **green** | Test automation | build the GREEN baseline + RED regression suites |
| **yellow** | Test-path analysts | regression BASELINE / validation paths |
| **magenta** | Cross-cutting / meta | architecture, code review, white-box analysis (inform every lane) |
| _blue_ | _(reserved / unused)_ | free for a future role type |

> The "D-team" (additional agents beyond the first 8-agent wave) is marked by the **D- name prefix**,
> not by colour — colour now encodes role type so the parallel run is readable by function.

## Per-agent mapping (23 Argus QA agents)
**cyan — core (5):** Odysseus (lead/orchestrator) · Kalchas (recon) · Metis (strategy) · Minos (triage) · Kleio (reporter)

**red — hunters (8):** Atalanta (API) · Hermes (Performance) · Orion (UI behaviour) · Lynceus (UI presentation/format/locale) · Antigone (Accessibility) · Perseus (CyberSecurity) · Ariadne (deep journeys / business-rule lifecycle) · Charon (Database — gated on DB access)

**green — automation (5):** Talos (API/backend) · Daidalos (frontend, incl. a11y autos) · Nike (performance) · Aegis (CyberSecurity) · Mnemosyne (Database — gated)

**yellow — path analysts (2):** Penelope (UI regression baseline) · Theseus (API regression baseline)

**magenta — cross-cutting / meta (3):** Atlas (Automation Architect) · Aristarchus (Code Reviewer, runs LAST) · Tiresias (White-box Source Analyst — gated on source-code access)

## Notes
- Gated agents (Charon, Mnemosyne, Tiresias) only join a run when their access precondition holds
  (Kalchas reports DB-access and source-code-access in recon); otherwise they sit out and their
  surface is covered black-box / named as residual risk.
- If you ever want the "additional vs original" cohort distinction back in colour, the alternative
  is: core+rerole = `cyan`, whole D-team = one colour (e.g. `magenta`). We chose role-type instead.

<!-- Author: Grzegorz Holak -->
