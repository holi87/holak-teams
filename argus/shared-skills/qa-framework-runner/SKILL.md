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
- A defect regression is RED on the faulty target at the assertion naming the defect and
  GREEN after the target is fixed. Use the framework-native regression selector plus the
  canonical defect provenance marker; neither marker substitutes for the other.
- One attempt is the default. Never green-encode a failure with broad catches, expected
  failure wrappers, early returns, hidden retries, order dependence, `.only`, or vacuous
  assertions.
- Quarantine requires an owner, reason, evidence, expiry, and explicit runner outcome.
  Expired or malformed entries fail closed. Final verification uses the lockfile, clean
  install/state, and the same command documented for CI.
