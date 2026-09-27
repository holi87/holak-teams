package qa.api;

import io.restassured.response.ValidatableResponse;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;

import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.equalTo;

/**
 * End-to-end api lane for scripts/smoke-argus-runtime-java.sh, installed as
 * qa/api/WidgetRegressionTest.java under the scaffold's test root.
 * scripts/fixtures/argus-runtime/faulty-target.mjs is the target.
 */
@Tag("api")
class WidgetRegressionTest {

    private final ApiClient api = new ApiClient();

    // BUG-0001 (origin ATA-001, oracle ORC-API-001): GET /widgets/1 returns the widget. The
    // target answers 500 in buggy mode, so the regression is RED until the target is fixed. The
    // smoke deletes the strict-body line to build a weakened copy that the missing-field tamper
    // survives.
    @Test
    @Tag("regression")
    @Tag("bug:ATA-001")
    void widget_read_returns_the_specified_widget() {
        ValidatableResponse response = given().spec(api.apiAs("user")).when().get("/widgets/1").then();
        response.statusCode(200);
        response.body("$", equalTo(Map.of("id", 1, "name", "widget"))); // argus-smoke: strict body
    }

    // A non-regression neighbour: baseline selects only this test while the known bug is RED,
    // and full-suite runs both.
    @Test
    void health_endpoint_reports_ok() {
        given().spec(api.anon()).when().get(ApiClient.HEALTH).then()
                .statusCode(200)
                .body("$", equalTo(Map.of("status", "ok")));
    }
}
