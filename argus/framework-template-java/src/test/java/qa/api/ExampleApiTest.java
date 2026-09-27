package qa.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.restassured.response.Response;
import io.restassured.specification.RequestSpecification;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import qa.support.ApiClient;
import qa.support.Config;
import qa.support.CreatedResources;
import qa.support.oracles.Boundary;
import qa.support.oracles.Http;
import qa.support.oracles.Http.RestState;
import qa.support.oracles.OpenApi;
import qa.support.oracles.Partitions;
import qa.support.oracles.Partitions.Partition;
import qa.support.oracles.Schema;

import java.math.BigDecimal;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static io.restassured.http.ContentType.JSON;
import static qa.support.DataFactory.order;

/**
 * ADAPT-ME: example API/contract tests. Replace endpoints/shapes with the real OpenAPI
 * surface. Put each resource/tag in its own class (e.g. {@code OrdersApiTest}) so parallel
 * writers don't collide. The {@code @Tag("api")} lane runs when {@code solution/test-lanes.tsv}
 * enables it ({@code run-tests.sh} selects it by tag); a plain {@code mvn test -Papi} runs it
 * alone.
 *
 * <p>Every assertion is exact: one documented status code ({@link Http#expectStatus},
 * {@link Http#assertRestStatus}), never a class such as "2xx" or "401 or 403"; a strict schema
 * by operationId ({@link Schema#assertSchema}), so an undocumented field is RED; and a
 * read-back of what a create stored. Whatever a test creates is registered with
 * {@link CreatedResources} right after the create, so a later RED still cleans up.
 *
 * <p>The schema and partition checks read the target's OpenAPI document
 * ({@code OPENAPI_PATH}, else {@code ./openapi.json}); a missing document is reported as
 * {@code prerequisite-missing}, never skipped. ADAPT-ME: if the target publishes no OpenAPI
 * document, delete those checks and record the missing contract oracle as a residual risk in
 * {@code solution/TEST-STRATEGY.md}.
 */
@Tag("api")
@ExtendWith(CreatedResources.class)
class ExampleApiTest {

    // ── The documented contract: from the OpenAPI document, never from observed behaviour ──
    /** The status the spec documents for an anonymous call to a protected route: one exact code, never "401 or 403". */
    private static final int SPEC_ANONYMOUS_STATUS = 401;     // <-- adapt
    /** The status the spec documents for a request body that violates the schema. */
    private static final int SPEC_INVALID_BODY_STATUS = 400;  // <-- adapt
    /** The documented lower bound of the order quantity; a count, so its step is 1. */
    private static final int QTY_MINIMUM = 1;                 // <-- adapt
    private static final String OP_GET_ME = "getMe";          // <-- adapt the operationIds
    private static final String OP_CREATE_ORDER = "createOrder";
    private static final String OP_GET_ORDER = "getOrder";
    /** JSON pointer to the create request's object schema; Partitions needs it resolved (no $ref, allOf, oneOf, anyOf). */
    private static final String ORDER_REQUEST_SCHEMA = "/components/schemas/NewOrder"; // <-- adapt

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ApiClient api = new ApiClient();

    @Test
    void health_endpoint_responds() {
        Response res = given().spec(api.anon()).when().get(ApiClient.HEALTH); // <-- adapt
        Http.expectStatus(res, 200); // <-- the documented status
    }

    @Test
    void authenticated_read_returns_the_contracted_shape() {
        Response res = given().spec(api.apiAs("user")).when().get(ApiClient.ME); // <-- adapt
        Http.expectStatus(res, 200);
        Schema.assertSchema(res, OP_GET_ME); // strict: an undocumented field is RED
    }

    @Test
    void create_then_read_back_returns_what_was_stored(CreatedResources created) {
        RequestSpecification user = api.apiAs("user");
        Map<String, Object> input = order().build(); // unique, override-friendly via DataFactory
        Response res = given().spec(user).contentType(JSON).body(input)
                .when().post(ApiClient.ORDERS); // <-- adapt resource
        Http.assertRestStatus(res, RestState.CREATED); // exactly 201 with a non-empty Location
        String location = resourcePath(res);
        created.register(user, location);
        Schema.assertSchema(res, OP_CREATE_ORDER);

        Response stored = given().spec(user).when().get(location);
        Http.expectStatus(stored, 200);
        Schema.assertSchema(stored, OP_GET_ORDER);
        assertStored(input, stored);
    }

    @Test
    void negative_protected_route_rejects_anonymous_access() {
        Response res = given().spec(api.anon()).when().get(ApiClient.ME); // <-- adapt protected route
        Http.expectStatus(res, SPEC_ANONYMOUS_STATUS);
    }

    /** Three-point boundary on the documented minimum: qty 0 is refused, 1 and 2 are created. */
    @Test
    void create_enforces_the_documented_qty_minimum(CreatedResources created) {
        RequestSpecification user = api.apiAs("user");
        Boundary.boundary3(BigDecimal.valueOf(QTY_MINIMUM), BigDecimal.ONE, qty -> {
            Response res = given().spec(user).contentType(JSON).body(order().qty(qty.intValueExact()).build())
                    .when().post(ApiClient.ORDERS);
            if (res.statusCode() == 201) {
                created.register(user, resourcePath(res));
                return true;
            }
            Http.expectStatus(res, SPEC_INVALID_BODY_STATUS); // a refusal is the documented one, never a 500
            return false;
        }, false, true, true);
    }

    /** One invalid body per declared constraint of the request schema; each must be refused with the documented status. */
    @Test
    void create_rejects_every_invalid_partition(CreatedResources created) {
        RequestSpecification user = api.apiAs("user");
        JsonNode schema = OpenApi.configured().document().at(ORDER_REQUEST_SCHEMA);
        if (!schema.isObject()) throw new IllegalStateException("ADAPT-ME: the OpenAPI document has no object schema at " + ORDER_REQUEST_SCHEMA);
        List<String> wrong = new ArrayList<>();
        for (Partition partition : Partitions.invalidObjectPartitions(schema, MAPPER.valueToTree(order().build()))) {
            Response res = given().spec(user).contentType(JSON).body(partition.value().toString())
                    .when().post(ApiClient.ORDERS);
            if (res.statusCode() == 201) created.register(user, resourcePath(res));
            if (res.statusCode() != SPEC_INVALID_BODY_STATUS) wrong.add(partition.label() + " -> HTTP " + res.statusCode());
        }
        if (!wrong.isEmpty()) {
            throw new AssertionError(wrong.size() + " invalid partition(s) not refused with HTTP " + SPEC_INVALID_BODY_STATUS
                    + ":\n  - " + String.join("\n  - ", wrong));
        }
    }

    /**
     * The created resource as a path relative to {@code API_URL}, for the read-back and the
     * cleanup. ADAPT-ME if {@code API_URL} carries a base path.
     */
    private static String resourcePath(Response created) {
        String location = created.getHeader("Location");
        if (location == null || location.isBlank()) {
            throw new AssertionError("HTTP " + created.statusCode() + " without a Location header: the created resource can be neither read back nor cleaned up");
        }
        String base = Config.apiUrl().endsWith("/") ? Config.apiUrl() : Config.apiUrl() + "/";
        return URI.create(base).resolve(location).getRawPath();
    }

    /** Every field the test sent comes back unchanged; the server may add fields such as the id. */
    private static void assertStored(Map<String, Object> input, Response stored) {
        JsonNode actual;
        try {
            actual = MAPPER.readTree(stored.asString());
        } catch (Exception notJson) {
            throw new AssertionError("the read-back body is not JSON: " + Http.excerpt(stored.asString()));
        }
        List<String> drift = new ArrayList<>();
        MAPPER.valueToTree(input).fields().forEachRemaining(field -> {
            JsonNode value = actual.get(field.getKey());
            if (!field.getValue().equals(value)) drift.add(field.getKey() + ": sent " + field.getValue() + ", stored " + value);
        });
        if (!drift.isEmpty()) throw new AssertionError("the read-back differs from the created input: " + String.join("; ", drift));
    }
}
