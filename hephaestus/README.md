# Hephaestus — Development Team

Roman code names. The forge: from goal to delivered increment.

[![Hephaestus team graph](team-graph.png)](team-graph.html)

*One entry point (`marcus`), hub-and-spoke — full-screen / print version: [`team-graph.html`](team-graph.html) (open locally in a browser).*

## How to start

**Entry point = `marcus`** (team leader).

You tell `marcus` what you want — and it:

1. decomposes the goal,
2. designs a **named team** and a **delegation plan**,
3. dispatches specialists (ba / dev / management / QA),
4. synthesises the results and reports back.

A single entry point — `marcus`. You don't call specialists yourself; the leader does.

## Roster (`claude/` + `codex/`)

The Claude Code version lives in `claude/`. The Codex version lives in `codex/` as the same 22 agents with the same slugs and names, each as a `*.toml` + `*.md` pair. Codex model mapping: `opus` → `sol` + `xhigh`, `sonnet` → `terra` + `medium`, `haiku` → `luna` + `medium`.

**Leader:** `marcus`

**ba/** — analysis and backlog
| cato | Product Owner — backlog, priorities, scope, accept/reject |
| varro | Business Analyst — requirements, user stories, Gherkin |

**dev/** — build
| vitruvius | architect — design, ADR, NFR, contracts |
| agrippa | tech-lead / planner — task plan, DoD, standards |
| maximus | backend — API, logic, data access, auth |
| lucius | frontend — components, a11y, responsiveness |
| tiberius | database — schema, migrations, optimization |
| fabricius | fullstack — vertical cross-cutting slices |
| severus | final gate — adversarial review, BLOCKER/WARNING |

**management/** — delivery and communication
| cicero | documentation — README, API docs, changelog |
| tacitus | signal — condenses logs / stack traces / results |
| numa | scrum — standups, ceremonies, impediments, risks |
| appius | DevOps — CI/CD, IaC, containers, deploy, observability |
| regulus | checklists — atomic, verifiable items |

**QA/** — quality
| janus | env-readiness — READY / NOT-READY gate |
| cassius | security review — STRIDE/OWASP, threat model |
| fabius | test automation — suite, fixtures, CI |
| boethius | test design — coverage from formal techniques |
| seneca | QA strategy — pyramid, quality gates, GO/NO-GO |
| catiline | exploratory — adversarial user, repro bugs |
| mercury | performance testing — k6, response time, CWV |

`codex/` — Codex variant of the roster (22 `*.toml` + `*.md` pairs).
