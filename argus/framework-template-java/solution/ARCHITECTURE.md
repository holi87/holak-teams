# Solution Architecture — Java QA framework

> **Canonical owner and merge authority: Atlas.** Contributors submit immutable stable fragments through Odysseus; Atlas alone merges this document. Keep strategy in `TEST-STRATEGY.md` and final reconciliation in `IMPLEMENTATION-REPORT.md`.

## Selected stack and rationale

JUnit 5 provides one tagged runner across lanes; REST Assured and JSON Schema Validator cover API/contract oracles; Playwright for Java covers the risk-derived UI and accessibility surface; Awaitility handles genuinely asynchronous outcomes; Maven/Surefire emit CI-native results. Adjust this choice only from the persisted `template select` decision and target evidence.

## Layers and dependency direction

```
<selected-test-root>/qa/support/  Config, role-aware API client, schema oracle,
                                  Playwright fixture, data factory, summary listener
<selected-test-root>/qa/support/oracles/ the shared oracle library (see below)
<selected-test-root>/qa/api/      API and contract checks
<selected-test-root>/qa/ui/       funded risk-derived UI journeys and a11y checks
<selected-test-root>/qa/perf/     stated-budget gates or characterisation checks
<selected-test-root>/qa/security/ authorisation checks
<selected-test-root>/qa/db/       explicitly enabled read-only integrity checks
<selected-test-root>/qa/regression/ native regression selector + bug provenance
```

Tests depend on support helpers; helpers depend on configuration. Tests never hardcode credentials, base URLs, or raw endpoint registries. Atlas owns the shared harness and top-level runner; lane engineers own disjoint test packages.

## Oracle library

The fourteen shared oracle helpers ship as tested reference code in `qa/support/oracles/`: generic, black-box, and one canonical implementation each, so no lane improvises its own check. Every helper throws `AssertionError` on a RED (classified `product fail`) and `IllegalArgumentException` on misuse; each is self-tested in the `contract-smoke` lane against correct and faulty 127.0.0.1 stubs (`qa/contract/Oracles{Contract,Data,Behavior}SelfTest.java`).

| Helper | Class | Contract |
|---|---|---|
| `expectStatus` | `Http` | the exact documented status code, never a class such as 2xx or "401 or 403" |
| `assertRestStatus` | `Http` | the REST state with its exact code: 201 + `Location`, 204 empty, 405 + `Allow`, 404 not 500 |
| `assertSchema` | `Schema` | the response body against the operationId's documented status and schema, strict by default |
| `assertSchemaStrict` | `Schema` | a component schema with every object closed, so an undocumented field is RED |
| `idempotentReplay` | `Replay` | an idempotent request twice: independently read state stays equal; response equality is contract opt-in; a replayed idempotency key creates one effect |
| `invalidPartitions` / `invalidObjectPartitions` | `Partitions` | one invalid value per declared constraint, with fixed labels in a fixed order |
| `paginateAll` / `assertCollectionConservation` | `Pagination` | two walks at a small page size: no duplicate, nothing missing, a total that matches |
| `boundary3` / `moneyReconciles` / `percentagesSumTo100` | `Boundary` | B - step, B, B + step with step = the domain's smallest unit; exact sums in minor units |
| `IDENTITY_VECTORS` / `credentialConsistency` / `validEmail` / `INVALID_EMAILS` / `caseVariants` | `Identity` | the canonical name/email/password vectors; register and login agree byte for byte |
| `i18nCharset` | `I18n` | diacritics, emoji and NFD round-trip code point for code point; limits count characters, not bytes |
| `softDeleteSweep` | `State` | after a delete: the documented delete status, 404 on read-back, absent from every list, login refused with 401 |
| `doubleSubmit` / `concurrentRace` | `Concurrency` | calls released together behind a start gate: exactly one effect; no 5xx, no overbooking, the invariant holds |
| `visualBounds` / `evaluateBounds` | `Visual` | at 375px by default: no negative render, no viewport overflow, no horizontal scroll, no occlusion |
| `n1Scaling` / `analyzeScaling` | `Scaling` | median time and payload per collection size grow sub-linearly (default exponents 0.5 and 0.1), warm-up discarded |

The ADAPT-ME examples in `qa/api`, `qa/ui` and `qa/perf` use these helpers; engagement tests import them rather than re-implementing a check. A helper that no test run by `./run-tests.sh` exercises is not delivered.

## Runner and evidence contract

`./run-tests.sh --mode <baseline|defect-evidence|candidate-regression|full-suite>` compiles first, invokes the selected JUnit/Surefire suite, appends validated outcome events, and emits `reports/argus-runner-result.json`. Retries remain zero. Expected RED is accepted only in defect-evidence mode; candidate and full modes are strict green gates. Raw and privacy-safe evidence stay under `reports/`.

## Extension decisions

Record target-specific paths, build adapters, browser matrix, gated prerequisites, CI command, data reset, and every unsupported adapter here. A helper or lane not invoked by the one runner is not delivered.

## Trace to strategy and final state

| Strategy risk | Architecture support | Delivered evidence |
|---------------|----------------------|--------------------|
| RISK-001 | <support helper + lane package> | <test/result path> |

Atlas records trade-offs; Kleio supplies the AI-collaboration and final-summary fragment. Link to `IMPLEMENTATION-REPORT.md` for delivered-versus-designed status rather than duplicating it.
