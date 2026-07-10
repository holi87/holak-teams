# Argus RACI Contract

This generated document is the human view of `argus/raci.json`. The JSON source is authoritative. `scripts/sync-argus-raci.mjs --check` rejects ownership, prompt, description, roster, or transition drift. Runtime routing uses `argus-assets raci route`.

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

## Surface routing

| Surface | Discover | Baseline | Automate | Validate | Report | Gate |
|---|---|---|---|---|---|---|
| ui-functional | orion | penelope | daidalos | minos | kleio | — |
| ui-presentation | lynceus | penelope | daidalos | minos | kleio | — |
| accessibility | antigone | penelope | daidalos | minos | kleio | — |
| api-rest | atalanta | theseus | talos | minos | kleio | — |
| event-protocol | proteus | pistis | talos | minos | kleio | — |
| journey-ui | ariadne | penelope | daidalos | minos | kleio | — |
| journey-api | ariadne | theseus | talos | minos | kleio | — |
| performance | hermes | metis | nike | minos | kleio | — |
| resilience | tyche | metis | nike | minos | kleio | — |
| security | perseus | metis | aegis | minos | kleio | — |
| data-direct | charon | kalchas | mnemosyne | minos | kleio | db-access |
| data-public-api | atalanta | theseus | talos | minos | kleio | — |
| source | tiresias | kalchas | atlas | minos | kleio | source-access |
| existing-suite | asklepios | asklepios | asklepios | aristarchus | kleio | existing-suite |

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
| `solution/coverage-observations.json` | atlas |
| `solution/coverage-result.json` | kleio |
| `solution/final-summary.json` | kleio |
| `solution/FINDINGS.md` | kleio |
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

| State machine | Transition | A |
|---|---|---|
| engagement | preflight → discovery | odysseus |
| engagement | discovery → hunting | odysseus |
| engagement | hunting → automation | odysseus |
| engagement | automation → verification | odysseus |
| engagement | verification → reporting | odysseus |
| engagement | reporting → complete | odysseus |
| lane-plan | planned → running | odysseus |
| lane-plan | planned → blocked | odysseus |
| lane-plan | running → blocked | odysseus |
| lane-plan | running → completed | odysseus |
| defect | candidate → needs-oracle | minos |
| defect | needs-oracle → suspected | minos |
| defect | suspected → confirmed | minos |
| defect | confirmed → automated | atlas |
| defect | automated → fixed | minos |
| defect | fixed → closed | minos |
| runner-lifecycle | discovered → reproduced | minos |
| runner-lifecycle | reproduced → automated | atlas |
| runner-lifecycle | automated → fixed | minos |
| runner-lifecycle | fixed → closed | minos |
| evidence | collected → immutable | kleio |
| coverage-observations | collected → merged | atlas |
| coverage-result | inputs-ready → calculated | kleio |
| automation | planned → implemented | atlas |
| automation | implemented → passed | atlas |
| automation | implemented → failed | atlas |
| automation | implemented → skipped | atlas |
| final-summary | reporting → completed | kleio |
| final-summary | reporting → degraded | kleio |
| final-summary | reporting → blocked | kleio |

## Agent contracts

| Agent | Role | Lane | Persistence | Accountable artifacts |
|---|---|---|---|---|
| aegis | Security automation engineer | security-automation | tests-only | — |
| antigone | Accessibility hunter | accessibility-hunt | candidate-file | — |
| ariadne | Journey and lifecycle hunter | journey-hunt | candidate-file | `solution/STATE_MODEL.md` |
| aristarchus | Automation quality judge | automation-review | result-envelope | — |
| asklepios | Test-suite sanitation specialist | suite-sanitation | candidate-file | `solution/TEST-HEALTH.md` |
| atalanta | REST API and public-data hunter | api-hunt | candidate-file | — |
| atlas | Automation architect | automation-architecture | owned-artifact | `run-tests.sh`, `solution/ARCHITECTURE.md`, `solution/automation-status.json`, `solution/coverage-observations.json` |
| charon | Direct-database hunter | database-hunt | candidate-file | — |
| daidalos | UI and accessibility automation engineer | ui-automation | tests-only | — |
| hermes | Performance hunter | performance-hunt | candidate-file | `solution/PERF-REPORT.md` |
| kalchas | System reconnaissance analyst | recon | owned-artifact | `solution/surface-inventory.json` |
| kleio | Final reporter | reporting | owned-artifact | `README.md`, `solution/evidence-reference.json`, `solution/coverage-result.json`, `solution/final-summary.json`, `solution/FINDINGS.md`, `solution/IMPLEMENTATION-REPORT.md`, `solution/TRACEABILITY.md` |
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
| talos | API and event automation engineer | api-automation | tests-only | — |
| theseus | REST API baseline path analyst | api-path-analysis | owned-path-spec | — |
| tiresias | White-box source analyst | source-analysis | fragment-only | — |
| tyche | Resilience hunter | resilience-hunt | candidate-file | `solution/RESILIENCE-REPORT.md` |

## Dual-home scheduling

- **nike** (performance, resilience): Dispatch separate work units; resilience automation requires the exclusive fault window and cannot overlap performance load.
- **ariadne** (ui-journey, api-journey): Own the cross-feature business invariant; route pure presentation to Orion/Lynceus and pure endpoint contract behavior to Atalanta.
- **tiresias** (source-lead, source-candidate): Return immutable TIR candidates and leads; Minos persists canonical bug files and WHITEBOX-LEADS.
