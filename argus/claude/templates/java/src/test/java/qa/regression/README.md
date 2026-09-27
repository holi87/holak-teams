# Regression tests (bug-linked)

When a bug is confirmed, its regression test asserts the SPEC-CORRECT behaviour. **The app
is NOT fixed during the engagement**, so the test is RED, and that RED, linked to the bug,
is the evidence that the suite catches the defect.

## Where they live

A regression lives in the package of the lane that owns the behaviour, for example
`src/test/java/qa/api/` or `src/test/java/qa/ui/`, never in this package: its lane `@Tag` is
what `solution/test-lanes.tsv` enables or disables, and there is no separate regression
lane. `@Tag("regression")` selects it in `defect-evidence` and `candidate-regression`;
`full-suite` runs it with everything else.

## Rules

- Tag it with `@Tag("regression")`, exactly one lane tag (`@Tag("api")`, `@Tag("ui")`, …),
  and exactly one `@Tag("bug:<token>")`. The token is the canonical `BUG-NNNN` or one stable
  origin alias of that bug in `solution/bug-ledger.json`. A missing, unknown, or second
  token, a second lane tag, or a bug that is not confirmed fails the inventory gate. Tags on
  the class apply to every method in it, so keep a regression's tags on its method when
  the class also holds ordinary tests.
- One regression per confirmed bug; cite the oracle next to the assertion.
- Never emit outcome events by hand. The Argus outcome adapter
  (`qa.support.argus.ArgusOutcomeListener`) turns each run into the lifecycle events:
  `expected-red` and `expected-red-repeat` in `defect-evidence`, `regression-green` or
  `regression-red` in `candidate-regression` and `full-suite`.
- Never disable or hide it: `@Disabled`, `@EnabledIf…`/`@DisabledIf…` conditions,
  assumptions, and `@Tag("quarantine")` are refused for a regression, and an `assertThrows`
  wrapped around the defect hides it. A known bug keeps its regression RED until the
  application is fixed.
  Determinism applies here too: no Surefire rerun — a flaky regression is itself a finding.
- Give it a counterfactual fixture, `solution/counterfactual/<BUG-NNNN>.json`, or a
  declared exemption. `defect-evidence` replays the fixture from a local stub: the test must
  pass on the spec-correct response and fail on every tamper, starting with the observed
  defect. Every request the test makes (a login included) must be one of the fixture's
  exchanges. Authoring rules and the exemption set: `solution/counterfactual/README.md`.
- An intermittent defect declares `@Tag("repetition:<n>")` from the ledger's reproduction
  record (RUNNER-CONTRACT.md SD-6), and its one test repeats the reproduction in its body:
  `Reproduction.reproduce(n, () -> { ... })` (`qa.support.argus`) runs up to n attempts, each
  from fresh state, and fails at the first violation. Never use `@RepeatedTest` or
  `@ParameterizedTest` for it: each of their invocations is a separate case, not an attempt.

```java
// src/test/java/qa/api/OrdersRegressionTest.java
package qa.api;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;

import static io.restassured.RestAssured.given;
import static io.restassured.http.ContentType.JSON;
import static java.util.Map.of;

@Tag("api")
class OrdersRegressionTest {

    private final ApiClient api = new ApiClient();

    // BUG-0007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
    @Test
    @Tag("regression")
    @Tag("bug:BUG-0007")
    void rejects_negative_quantity() {
        given().spec(api.apiAs("user")).contentType(JSON)
                .body(of("item", "x", "qty", -5))
                .when().post(ApiClient.ORDERS)
                .then().statusCode(400); // SPEC says reject; app returns 201 → RED = the bug
    }
}
```

Run it with `./run-tests.sh --mode defect-evidence`; after the product fix the same test
runs strict green with `--mode candidate-regression`.
