# Solution Architecture — Python QA framework

> **Canonical owner and merge authority: Atlas.** Contributors submit immutable stable fragments through Odysseus; Atlas alone merges this document. Keep strategy in `TEST-STRATEGY.md` and final reconciliation in `IMPLEMENTATION-REPORT.md`.

## Selected stack and rationale

pytest provides one marker-based runner across lanes; httpx and jsonschema cover API/contract oracles; Playwright for Python covers the risk-derived UI and accessibility surface; pytest HTML/JSON/JUnit reporters serve humans, automation, and CI. Adjust this choice only from the persisted `template select` decision and target evidence.

## Layers and dependency direction

```
<selected-harness-root>/qa/       configuration, role-aware API client, schema oracle,
                                  page objects, and deterministic data factory
<selected-harness-root>/qa/oracles/  the shared oracle library (see "Oracle library" below)
<selected-test-root>/api/         API and contract checks
<selected-test-root>/ui/          funded risk-derived UI journeys and a11y checks
<selected-test-root>/perf/        stated-budget gates or characterisation checks
<selected-test-root>/security/    authorisation checks
<selected-test-root>/db/          explicitly enabled read-only integrity checks
<selected-test-root>/regression/  native regression marker + bug provenance
```

Tests depend on fixtures/pages/data, which depend on the API client and configuration. Tests never hardcode credentials, base URLs, or raw endpoint registries. Atlas owns the shared harness and top-level runner; lane engineers own disjoint test packages.

## Oracle library

Every test imports its oracles from `qa.oracles` (`<selected-harness-root>/qa/oracles/__init__.py`); no lane re-implements one. A RED raises `AssertionError` (a product failure); a misuse raises `TypeError` or `ValueError` (an automation failure); a missing OpenAPI document raises `ArgusPrerequisiteError` (infrastructure). The contract-smoke self-tests (`<selected-test-root>/contract/test_oracles_*_selftest.py`) prove each helper GREEN on a correct stub and RED on a faulty one. Modules are relative to `<selected-harness-root>/`.

| # | Helper | Module | Oracle |
|---|--------|--------|--------|
| 1 | `assert_schema(res, operation_id)` | `qa/oracles/schema.py` | the body matches the schema documented for that status; strict by default, so an undocumented field is RED |
| 2 | `assert_schema_strict(body, ref)` | `qa/oracles/schema.py` | a body matches a component schema with strict mode forced |
| 3 | `expect_status(res, exact)` | `qa/oracles/http.py` | one exact documented status code, never a class |
| 4 | `idempotent_replay` / `replay_with_idempotency_key` + `assert_rest_status(res, state)` | `qa/oracles/replay.py`, `qa/oracles/http.py` | a replay changes neither the response nor the state, and one idempotency key makes one effect; the REST-correct code per state (201 + Location, 204 empty, 405 + Allow) |
| 5 | `soft_delete_sweep` | `qa/oracles/state.py` | after the delete: 404 by id, absent from every list, and a deleted user's login answers 401 |
| 6 | `double_submit` | `qa/oracles/concurrency.py` | two simultaneous submits (one thread each, released by a Barrier) make exactly the contracted number of effects |
| 7 | `concurrent_race` | `qa/oracles/concurrency.py` | N simultaneous contenders: no 5xx, successes within capacity, the invariant holds |
| 8 | `i18n_charset` | `qa/oracles/i18n.py` | stored text round-trips code point for code point; a length limit counts characters, not bytes |
| 9 | `IDENTITY_VECTORS` + `credential_consistency` + `valid_email` / `INVALID_EMAILS` + `case_variants` | `qa/oracles/identity.py` | the canonical identity vectors; register and login agree byte for byte |
| 10 | `visual_bounds(locator)` (pure rules: `evaluate_bounds`) | `qa/oracles/visual.py` | at 375 px the element is not off-screen, not overflowing its box, and not covered |
| 11 | `n1_scaling` (pure analysis: `analyze_scaling`) | `qa/oracles/scaling.py` | read time and payload grow sub-linearly with the collection size (N+1, over-fetch) |
| 12 | `boundary3` + `money_reconciles` + `percentages_sum_to_100` | `qa/oracles/boundary.py` | B - step, B, B + step with the domain's smallest unit; exact minor-unit sums (`decimal.Decimal`); exactly 100% |
| 13 | `invalid_partitions` / `invalid_object_partitions` | `qa/oracles/partitions.py` | one invalid value per declared constraint, each rejected with the documented code |
| 14 | `paginate_all` + `assert_collection_conservation` | `qa/oracles/pagination.py` | two walks at a small page size: no duplicate, no gap, and the total matches |

`qa/oracles/openapi.py` loads and normalizes the `OPENAPI_PATH` document for the schema oracles. The ADAPT-ME examples in `<selected-test-root>/api/`, `<selected-test-root>/ui/`, and `<selected-test-root>/perf/` show each lane's use.

## Runner and evidence contract

`./run-tests.sh --mode <baseline|defect-evidence|candidate-regression|full-suite>` prepares the selected environment, checks readiness, invokes pytest, appends validated outcome events, and emits `reports/argus-runner-result.json`. Automatic reruns remain disabled. Expected RED is accepted only in defect-evidence mode; candidate and full modes are strict green gates. Raw and privacy-safe evidence stay under `reports/`.

## Extension decisions

Record target-specific paths, environment adapter or lock strategy, browser matrix, gated prerequisites, CI command, data reset, and every unsupported adapter here. A helper or lane not invoked by the one runner is not delivered.

## Trace to strategy and final state

| Strategy risk | Architecture support | Delivered evidence |
|---------------|----------------------|--------------------|
| RISK-001 | <fixture/helper + lane package> | <test/result path> |

Atlas records trade-offs; Kleio supplies the AI-collaboration and final-summary fragment. Link to `IMPLEMENTATION-REPORT.md` for delivered-versus-designed status rather than duplicating it.
