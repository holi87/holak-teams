---
name: qa-framework-runner
description: Shared suite adaptation, runner, regression, and quarantine contract for Argus roles
user-invocable: false
---

# Argus Framework and Runner

Use this profile only for roles that design, build, adapt, execute, or review test code.

The complete installed framework contract is
`${CLAUDE_PLUGIN_ROOT}/references/TEMPLATE-CONTRACT.md`.

- Detect the target language, package manager, runner, source/test roots, CI entry point,
  and existing harness before changing tests. Adapt a healthy existing suite in place.
  Scaffold only for an explicit build action and an approved compatible layout.
- Keep lane ownership disjoint while reusing shared factories, clients, fixtures, schema
  oracles, and cleanup. Tests are independent, deterministic, and runnable from clean state
  through one top-level entry point.
- The runner exposes `baseline`, `defect-evidence`, `candidate-regression`, and
  `full-suite` modes with truthful exit
  status. It emits the canonical result, evidence, and event shapes and keeps product,
  automation, infrastructure, skip, and policy outcomes distinct.
- `scripts/runner-lib.sh` owns every run; the suite's entry point only supplies native
  hooks. The packaged outcome adapters (Playwright reporter, pytest plugin, JUnit listener)
  stay inert until the library exports `ARGUS_RUNNER_MODE`, and only they emit events,
  through `scripts/outcome-event.sh`. A test, fixture, or hook never writes an event, and no
  event carries a title, message, URL, or body.
- Every run collects the full, unfiltered inventory (`reports/test-inventory.tsv`) before
  any test body runs. Every test resolves to exactly one lane; a regression carries exactly
  one provenance token (TypeScript `@bug:<id>`, Java `@Tag("bug:<id>")`, Python
  `@pytest.mark.bug("<id>")`) naming a `confirmed` ledger row. Unresolved, duplicated, or
  unconfirmed provenance, provenance without the regression marker, a focused or
  expected-failure test, and a skipped regression fail the gate.
- `solution/test-lanes.tsv` decides every product lane (`api`, `ui`, `perf`, `security`,
  `db`, `resilience`) with state, owner, prerequisites, and reason; `not-yet-planned` blocks
  `full-suite`. A disabled lane leaves native selection, and a test never self-skips on a
  prerequisite. `solution/environment.tsv` declares reset and verify scripts; reset runs
  only with `ARGUS_ENVIRONMENT_RESET=execute` under the destructive grant and reset window.
- Inside an engagement the runner refuses `ARGUS_ENVIRONMENT_RESET=execute` and
  `ARGUS_FAULT_INJECTION=authorized` (exit 13) unless the caller sets
  `ARGUS_ENGAGEMENT_LANE=<own slug>` and the window's owner holds it: Odysseus claims `reset`
  and Tyche claims `fault` with `argus-assets engagement claim --resource <reset|fault>`, then
  runs `engagement release` after the run. Ask Odysseus for the window; never run without it.
- A defect regression is RED on the faulty target at the assertion naming the defect and
  GREEN after the target is fixed. Use the framework-native regression selector plus the
  canonical defect provenance marker; neither marker substitutes for the other.
- `defect-evidence` runs `live`, `repeat`, `cf-correct`, and `cf-tamper-<k>` passes. Each
  confirmed bug needs its RED in `live` and `repeat` (either one for an intermittent
  defect; a deterministic regression that passes in `repeat` is `flaky-red`), plus
  `solution/counterfactual/<id>.json`: a fixture whose correct response comes from the
  cited oracle and whose `observed-defect` tamper is minimized and passed through
  `argus-assets redact` — the regression passes on the correct response and fails on every
  tamper — or a closed-set exemption (`front-end-logic`, `timing-or-load`, `data-layer`,
  `fault-injection`, `non-http-protocol`) whose justification names why that reason applies.
- One attempt is the default. Never green-encode a failure with broad catches, expected
  failure wrappers, early returns, hidden retries, order dependence, `.only`, or vacuous
  assertions.
- An intermittent confirmed defect (observed rate p = occurrences/attempts < 1) gets a
  declared-repetition RED: its runtime repetition marker declares
  n = min(200, ceil(ln 0.05 / ln(1 - p))), and one test repeats the reproduction up to n
  times from fresh state and fails at the first oracle violation. It is not a retry: a
  failure is never re-run to green. A run without a violation reports its pass as
  `intermittent-unreproduced`, which is not RED evidence; after one, raise n once to the
  99% bound min(200, ceil(ln 0.01 / ln(1 - p))). Flaky-RED applies only to deterministic
  (n = 1) regressions.
- Quarantine requires an owner, reason, evidence, expiry, and explicit runner outcome.
  Expired or malformed entries fail closed, and a regression is never quarantined. Final
  verification uses the lockfile, clean install/state, and the same command documented for
  CI.
