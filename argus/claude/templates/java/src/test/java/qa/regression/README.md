# Regression tests (bug-linked)

When Atalanta confirms a bug, a regression test goes here. **The app is NOT fixed during the engagement**, so the test asserts the SPEC-CORRECT behaviour and will be RED — that red, linked to its bug file, is your evidence that the suite catches the defect (evaluated criterion 4).

Use **red evidence** only: a plain failing test selected by `@Tag("regression")` whose
`@bug:` provenance maps to the canonical ID or one stable origin alias in
`solution/bug-ledger.json`. Run it in
`--mode defect-evidence`; a JUnit extension/listener must append the matching
`product/fail/expected=true/reproduced` event. Candidate/full modes remain strict green.

```java
package qa.regression;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;

import static io.restassured.RestAssured.given;
import static io.restassured.http.ContentType.JSON;
import static java.util.Map.of;

@Tag("regression")
class Bug007NegativeQuantityTest {

    private final ApiClient api = new ApiClient();

    // BUG-0007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
    @Test
    void bug_007_rejects_negative_quantity() {
        given().spec(api.apiAs("user")).contentType(JSON)
                .body(of("item", "x", "qty", -5))
                .when().post(ApiClient.ORDERS)
                .then().statusCode(400); // SPEC says reject; app returns 201 → RED = the bug
    }
}
```

Do **not** use expected-failure wrappers (`@Disabled`, assumptions, `assertThrows` hiding the
failure) for confirmed defects. A known bug must keep its regression RED until the application
is fixed. Determinism applies here too: no Surefire rerun — a flaky regression is itself a finding.

Every regression test carries the native regression tag plus `@bug:<canonical-or-origin>`, cites the oracle, and emits the lifecycle event
through `scripts/outcome-event.sh`. One regression test per confirmed bug. Lane:
`@Tag("regression")`.
