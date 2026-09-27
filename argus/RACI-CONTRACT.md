# Argus RACI Contract

This generated document is the human view of `argus/raci.json`. The JSON source is authoritative. `scripts/sync-argus-raci.mjs --check` rejects ownership, roster, or transition drift. Runtime routing uses `argus-assets raci route`; `scripts/sync-argus-role-variants.mjs` renders role descriptions and contract blocks.

R = responsible, A = exactly one accountable owner, C = consulted, I = informed.

## Defect lifecycle

| Activity | A | R | C | Handoff |
|---|---|---|---|---|
| discover | odysseus | surface-owner | — | Resolve the responsible specialist from surfaceRoutes, then submit an immutable candidate with evidence to Minos through Odysseus. |
| validate | minos | minos | originating-specialist | — |
| deduplicate | minos | minos | — | — |
| persist | minos | minos | originating-specialist | — |
| automate | atlas | surface-automation-owner | minos | — |
| judge | aristarchus | aristarchus | asklepios | — |
| report | kleio | kleio | minos, atlas, metis | — |
| repair | odysseus | originating-specialist | minos | Re-dispatch the filing lane under its active allocation with the exact repair.missing items; the lane updates its own candidate file and evidence, then Minos re-judges. |
| reproduce | minos | independent-reproducer | originating-specialist | Odysseus assigns the first eligible surface-route reproduce candidate; the reproducer arranges fresh state and records evidence collected under its own slug. |
| source-oracle | metis | metis | minos | Metis answers needs-oracle requests with an ORC addendum, a justified-invariant class, both readings, or an explicit no-oracle residual. |
| review-evidence | minos | minos | originating-specialist | The collector runs the binary-evidence authorization check before capture and hands Minos the masked or synthetic derivative with the printed audit timestamp; Minos inspects it and registers the reference and review in his own evidence fragment. Kleio reviews a capture Minos collected. |

## Surface routing

Reproduce lists independent reproducers in preference order. Odysseus assigns the first selected, dispatchable candidate that is not the finder, an origin lane, or the collector of the original reproduction evidence; every candidate holds a lane before the first proof phase and never discovers that surface. An empty list names no independent reproducer: the finding uses the route of its manifestation surface when that differs, and otherwise records independent reproduction as unavailable with its reason.

| Surface | Discover | Reproduce | Baseline | Automate | Validate | Report | Gate |
|---|---|---|---|---|---|---|---|
| ui-functional | orion | ariadne, lynceus, daidalos | penelope | daidalos | minos | kleio | — |
| ui-presentation | lynceus | orion, antigone, daidalos | penelope | daidalos | minos | kleio | — |
| accessibility | antigone | lynceus, orion, daidalos | penelope | daidalos | minos | kleio | — |
| api-rest | atalanta | ariadne, perseus, talos | theseus | talos | minos | kleio | — |
| event-protocol | proteus | atalanta, talos | pistis | talos | minos | kleio | — |
| journey-ui | ariadne | orion, daidalos | penelope | daidalos | minos | kleio | — |
| journey-api | ariadne | atalanta, talos | theseus | talos | minos | kleio | — |
| performance | hermes | atalanta | metis | nike | minos | kleio | — |
| resilience | tyche | — | metis | nike | minos | kleio | — |
| security | perseus | atalanta, ariadne | metis | aegis | minos | kleio | — |
| data-direct | charon | atalanta | kalchas | mnemosyne | minos | kleio | db-access |
| data-public-api | atalanta | ariadne, charon, talos | theseus | talos | minos | kleio | — |
| source | tiresias | — | kalchas | atlas | minos | kleio | source-access |
| existing-suite | asklepios | — | asklepios | asklepios | aristarchus | kleio | existing-suite |

## Canonical artifacts

The accountable owner is also the sole owner of that artifact's `fragment → canonical` merge transition.

| Path | A / merge owner |
|---|---|
| `README.md` | kleio |
| `run-tests.sh` | atlas |
| `solution/ARCHITECTURE.md` | atlas |
| `solution/BUG-LEDGER.md` | minos |
| `solution/bug-ledger.json` | minos |
| `solution/lane-plan.json` | odysseus |
| `solution/evidence-reference.json` | kleio |
| `solution/automation-status.json` | atlas |
| `solution/surface-inventory.json` | kalchas |
| `solution/coverage-observations.json` | kleio |
| `solution/coverage-result.json` | kleio |
| `solution/final-summary.json` | kleio |
| `solution/automation-review.json` | aristarchus |
| `solution/FINDINGS.md` | kleio |
| `solution/ACCESSIBILITY-REPORT.md` | kleio |
| `solution/IMPLEMENTATION-REPORT.md` | kleio |
| `solution/ORACLES.md` | metis |
| `solution/PERF-REPORT.md` | hermes |
| `solution/RESILIENCE-REPORT.md` | tyche |
| `solution/STATE_MODEL.md` | ariadne |
| `solution/TEST-HEALTH.md` | asklepios |
| `solution/TEST-STRATEGY.md` | metis |
| `solution/TRACEABILITY.md` | kleio |
| `solution/WHITEBOX-LEADS.md` | minos |

## State transitions

Engagement transitions are derived, not declared freely: they are exactly the consecutive phases that `derivePhasePlan` produces from `argus/orchestration-plan.json` in Modes A–D, plus the skip exit from each skippable deep-hunt pass to the first phase after that mode's last deep pass.

| State machine | Transition | A |
|---|---|---|
| engagement | preflight → discovery | odysseus |
| engagement | discovery → hunting | odysseus |
| engagement | hunting → proof | odysseus |
| engagement | proof → deep-hunt-1 | odysseus |
| engagement | deep-hunt-1 → deep-proof-1 | odysseus |
| engagement | deep-proof-1 → deep-hunt-2 | odysseus |
| engagement | deep-hunt-2 → deep-proof-2 | odysseus |
| engagement | deep-proof-2 → deep-hunt-3 | odysseus |
| engagement | deep-hunt-3 → deep-proof-3 | odysseus |
| engagement | deep-proof-3 → automation | odysseus |
| engagement | deep-proof-3 → verification | odysseus |
| engagement | proof → automation | odysseus |
| engagement | automation → verification | odysseus |
| engagement | verification → reporting | odysseus |
| engagement | reporting → complete | odysseus |
| engagement | deep-hunt-2 → automation | odysseus |
| engagement | deep-hunt-3 → automation | odysseus |
| engagement | deep-hunt-2 → verification | odysseus |
| engagement | deep-hunt-3 → verification | odysseus |
| lane-plan | planned → running | odysseus |
| lane-plan | planned → blocked | odysseus |
| lane-plan | running → blocked | odysseus |
| lane-plan | running → completed | odysseus |
| defect | candidate → needs-oracle | minos |
| defect | candidate → bounced | minos |
| defect | candidate → suspected | minos |
| defect | candidate → confirmed | minos |
| defect | bounced → needs-oracle | minos |
| defect | bounced → suspected | minos |
| defect | bounced → confirmed | minos |
| defect | needs-oracle → suspected | minos |
| defect | needs-oracle → confirmed | minos |
| defect | suspected → confirmed | minos |
| defect | confirmed → quarantined | minos |
| defect | quarantined → confirmed | minos |
| defect | quarantined → suspected | minos |
| defect | suspected → rejected | minos |
| defect | needs-oracle → rejected | minos |
| defect | suspected → duplicate | minos |
| defect | needs-oracle → duplicate | minos |
| defect | confirmed → duplicate | minos |
| defect | confirmed → automated | atlas |
| defect | automated → fixed | minos |
| defect | fixed → closed | minos |
| runner-lifecycle | discovered → reproduced | minos |
| runner-lifecycle | reproduced → automated | atlas |
| runner-lifecycle | automated → fixed | minos |
| runner-lifecycle | fixed → closed | minos |
| evidence | collected → immutable | kleio |
| coverage-observations | collected → merged | kleio |
| coverage-result | inputs-ready → calculated | kleio |
| automation | planned → implemented | atlas |
| automation | implemented → passed | atlas |
| automation | implemented → failed | atlas |
| automation | implemented → skipped | atlas |
| final-summary | reporting → completed | kleio |
| final-summary | reporting → degraded | kleio |
| final-summary | reporting → blocked | kleio |
| automation-review | pending → approved | aristarchus |
| automation-review | pending → blocked | aristarchus |
| automation-review | blocked → approved | aristarchus |
| automation-review | approved → blocked | aristarchus |

## Agent contracts

| Agent | Role | Lane | Persistence | Accountable artifacts |
|---|---|---|---|---|
| aegis | Security automation engineer | security-automation | tests-only | — |
| antigone | Accessibility hunter | accessibility-hunt | candidate-file | — |
| ariadne | Journey and lifecycle hunter | journey-hunt | candidate-file | `solution/STATE_MODEL.md` |
| aristarchus | Automation quality judge | automation-review | owned-artifact | `solution/automation-review.json` |
| asklepios | Test-suite sanitation specialist | suite-sanitation | candidate-file | `solution/TEST-HEALTH.md` |
| atalanta | REST API and public-data hunter | api-hunt | candidate-file | — |
| atlas | Automation architect | automation-architecture | owned-artifact | `run-tests.sh`, `solution/ARCHITECTURE.md`, `solution/automation-status.json` |
| charon | Direct-database hunter | database-hunt | candidate-file | — |
| daidalos | UI and accessibility automation engineer | ui-automation | tests-only | — |
| hermes | Performance hunter | performance-hunt | candidate-file | `solution/PERF-REPORT.md` |
| kalchas | System reconnaissance analyst | recon | owned-artifact | `solution/discovery/capability-evidence.json`, `solution/discovery/contract-drift.json`, `solution/surface-inventory.json` |
| kleio | Final reporter | reporting | owned-artifact | `README.md`, `solution/evidence-reference.json`, `solution/coverage-result.json`, `solution/final-summary.json`, `solution/FINDINGS.md`, `solution/ACCESSIBILITY-REPORT.md`, `solution/IMPLEMENTATION-REPORT.md`, `solution/TRACEABILITY.md`, `solution/coverage-observations.json` |
| lynceus | UI presentation hunter | presentation-hunt | candidate-file | — |
| metis | Test strategist | strategy | owned-artifact | `solution/TEST-STRATEGY.md`, `solution/ORACLES.md` |
| minos | Defect authority and triage lead | triage | owned-artifact | `solution/BUG-LEDGER.md`, `solution/bug-ledger.json`, `solution/WHITEBOX-LEADS.md` |
| mnemosyne | Database automation engineer | database-automation | tests-only | — |
| nike | Performance and resilience automation engineer | performance-resilience-automation | tests-only | — |
| odysseus | Main-thread orchestration policy | orchestration | owned-artifact | `solution/lane-plan.json` |
| orion | Functional UI hunter | ui-hunt | candidate-file | — |
| penelope | UI baseline path analyst | ui-path-analysis | owned-path-spec | — |
| perseus | Security hunter | security-hunt | candidate-file | — |
| pistis | Consumer contract baseline analyst | contract-analysis | owned-path-spec | — |
| proteus | Event and non-REST protocol hunter | multi-protocol-hunt | candidate-file | — |
| talos | API and event automation engineer | api-automation | tests-only | `solution/findings/conformance-red.json` |
| theseus | REST API baseline path analyst | api-path-analysis | owned-path-spec | `solution/paths/conformance-grid.json` |
| tiresias | White-box source analyst | source-analysis | fragment-only | — |
| tyche | Resilience hunter | resilience-hunt | candidate-file | `solution/RESILIENCE-REPORT.md` |

## Dual-home scheduling

- **nike** (performance, resilience): Dispatch separate work units; resilience automation requires the exclusive fault window and cannot overlap performance load.
- **ariadne** (ui-journey, api-journey): Own the cross-feature business invariant; route pure presentation to Orion/Lynceus and pure endpoint contract behavior to Atalanta.
- **tiresias** (source-lead, source-candidate): Return immutable TIR candidates and leads; Minos persists canonical bug files and WHITEBOX-LEADS.
