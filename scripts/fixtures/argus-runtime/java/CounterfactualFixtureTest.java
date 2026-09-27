package qa.api;

import io.restassured.response.Response;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;
import qa.support.oracles.Http;
import qa.support.oracles.Schema;

import static io.restassured.RestAssured.given;

/**
 * Counterfactual fixture for scripts/smoke-argus-runtime-java.sh (RUNNER-CONTRACT.md SD-6,
 * TEMPLATE-CONTRACT.md SD-10). Every case reaches the API only through {@link ApiClient}, so
 * in a cf-* evidence pass ArgusCounterfactualExtension answers from
 * solution/counterfactual/BUG-NNNN.json. The smoke points API_URL at a refused loopback port:
 * a case that escaped the stub would report target-unreachable instead of its verdict.
 */
@Tag("api")
class CounterfactualFixtureTest {

    private static final String WIDGET = "#/components/schemas/Widget";

    private final ApiClient api = new ApiClient();

    /** The regression: exact status and the strict contract body. */
    @Test
    @Tag("regression")
    @Tag("bug:ATA-001")
    void widget_matches_the_contract() {
        Response res = given(api.anon()).get("/widgets/1");
        Http.expectStatus(res, 200);
        Schema.assertSchemaRef(res.asString(), WIDGET);
    }

    /** A weakened copy that checks the status only, so a tamper that keeps 200 survives it. */
    @Test
    @Tag("regression")
    @Tag("bug:ATA-001")
    void widget_status_only() {
        Http.expectStatus(given(api.anon()).get("/widgets/1"), 200);
    }

    /** Passes its assertions, but also calls an endpoint the fixture does not record. */
    @Test
    @Tag("regression")
    @Tag("bug:ATA-001")
    void widget_with_an_undeclared_call() {
        given(api.anon()).get("/widgets/2");
        Response res = given(api.anon()).get("/widgets/1");
        Http.expectStatus(res, 200);
        Schema.assertSchemaRef(res.asString(), WIDGET);
    }

    /** Fails on the 501 of an unrecorded endpoint: that is not product evidence either. */
    @Test
    @Tag("regression")
    @Tag("bug:ATA-001")
    void undeclared_call_breaks_the_assertion() {
        Http.expectStatus(given(api.anon()).get("/widgets/2"), 200);
    }

    /** Claims not-applicable although its variant applies: an ordinary skip, never silence. */
    @Test
    @Tag("regression")
    @Tag("bug:ATA-001")
    void spoofed_not_applicable() {
        Assumptions.abort("argus-counterfactual-not-applicable");
    }

    /** BUG-0004 carries a front-end-logic exemption: proven once, in cf-correct, never run. */
    @Test
    @Tag("regression")
    @Tag("bug:PER-004")
    void exempt_front_end_regression() {
        Http.expectStatus(given(api.anon()).get("/widgets/1"), 200);
    }

    /** BUG-0003 has no fixture: the plan reports it, and no counterfactual pass runs the test. */
    @Test
    @Tag("regression")
    @Tag("bug:ATA-003")
    void regression_without_fixture() {
        Http.expectStatus(given(api.anon()).get("/widgets/1"), 200);
    }
}
