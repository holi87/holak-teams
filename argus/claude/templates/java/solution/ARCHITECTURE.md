# Solution Architecture — Java QA framework

> **Canonical owner and merge authority: Atlas.** Contributors submit immutable stable fragments through Odysseus; Atlas alone merges this document. Keep strategy in `TEST-STRATEGY.md` and final reconciliation in `IMPLEMENTATION-REPORT.md`.

## Selected stack and rationale

JUnit 5 provides one tagged runner across lanes; REST Assured and JSON Schema Validator cover API/contract oracles; Playwright for Java covers the risk-derived UI and accessibility surface; Awaitility handles genuinely asynchronous outcomes; Maven/Surefire emit CI-native results. Adjust this choice only from the persisted `template select` decision and target evidence.

## Layers and dependency direction

```
<selected-test-root>/qa/support/  Config, role-aware API client, schema oracle,
                                  Playwright fixture, data factory, summary listener
<selected-test-root>/qa/api/      API and contract checks
<selected-test-root>/qa/ui/       funded risk-derived UI journeys and a11y checks
<selected-test-root>/qa/perf/     stated-budget gates or characterisation checks
<selected-test-root>/qa/security/ authorisation checks
<selected-test-root>/qa/db/       explicitly enabled read-only integrity checks
<selected-test-root>/qa/regression/ native regression selector + bug provenance
```

Tests depend on support helpers; helpers depend on configuration. Tests never hardcode credentials, base URLs, or raw endpoint registries. Atlas owns the shared harness and top-level runner; lane engineers own disjoint test packages.

## Runner and evidence contract

`./run-tests.sh --mode <baseline|defect-evidence|candidate-regression|full-suite>` compiles first, invokes the selected JUnit/Surefire suite, appends validated outcome events, and emits `reports/argus-runner-result.json`. Retries remain zero. Expected RED is accepted only in defect-evidence mode; candidate and full modes are strict green gates. Raw and privacy-safe evidence stay under `reports/`.

## Extension decisions

Record target-specific paths, build adapters, browser matrix, gated prerequisites, CI command, data reset, and every unsupported adapter here. A helper or lane not invoked by the one runner is not delivered.

## Trace to strategy and final state

| Strategy risk | Architecture support | Delivered evidence |
|---------------|----------------------|--------------------|
| RISK-001 | <support helper + lane package> | <test/result path> |

Atlas records trade-offs; Kleio supplies the AI-collaboration and final-summary fragment. Link to `IMPLEMENTATION-REPORT.md` for delivered-versus-designed status rather than duplicating it.
