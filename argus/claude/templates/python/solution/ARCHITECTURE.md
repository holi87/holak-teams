# Solution Architecture — Python QA framework

> **Canonical owner and merge authority: Atlas.** Contributors submit immutable stable fragments through Odysseus; Atlas alone merges this document. Keep strategy in `TEST-STRATEGY.md` and final reconciliation in `IMPLEMENTATION-REPORT.md`.

## Selected stack and rationale

pytest provides one marker-based runner across lanes; httpx and jsonschema cover API/contract oracles; Playwright for Python covers the risk-derived UI and accessibility surface; pytest HTML/JSON/JUnit reporters serve humans, automation, and CI. Adjust this choice only from the persisted `template select` decision and target evidence.

## Layers and dependency direction

```
<selected-harness-root>/qa/       configuration, role-aware API client, schema oracle,
                                  page objects, and deterministic data factory
<selected-test-root>/api/         API and contract checks
<selected-test-root>/ui/          funded risk-derived UI journeys and a11y checks
<selected-test-root>/perf/        stated-budget gates or characterisation checks
<selected-test-root>/security/    authorisation checks
<selected-test-root>/db/          explicitly enabled read-only integrity checks
<selected-test-root>/regression/  native regression marker + bug provenance
```

Tests depend on fixtures/pages/data, which depend on the API client and configuration. Tests never hardcode credentials, base URLs, or raw endpoint registries. Atlas owns the shared harness and top-level runner; lane engineers own disjoint test packages.

## Runner and evidence contract

`./run-tests.sh --mode <baseline|defect-evidence|candidate-regression|full-suite>` prepares the selected environment, checks readiness, invokes pytest, appends validated outcome events, and emits `reports/argus-runner-result.json`. Automatic reruns remain disabled. Expected RED is accepted only in defect-evidence mode; candidate and full modes are strict green gates. Raw and privacy-safe evidence stay under `reports/`.

## Extension decisions

Record target-specific paths, environment adapter or lock strategy, browser matrix, gated prerequisites, CI command, data reset, and every unsupported adapter here. A helper or lane not invoked by the one runner is not delivered.

## Trace to strategy and final state

| Strategy risk | Architecture support | Delivered evidence |
|---------------|----------------------|--------------------|
| RISK-001 | <fixture/helper + lane package> | <test/result path> |

Atlas records trade-offs; Kleio supplies the AI-collaboration and final-summary fragment. Link to `IMPLEMENTATION-REPORT.md` for delivered-versus-designed status rather than duplicating it.
