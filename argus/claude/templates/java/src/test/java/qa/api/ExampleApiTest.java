package qa.api;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;
import qa.support.SchemaOracle;

import static io.restassured.RestAssured.given;
import static io.restassured.http.ContentType.JSON;
import static org.hamcrest.Matchers.anyOf;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.notNullValue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static qa.support.DataFactory.order;

/**
 * ADAPT-ME: example API/contract tests. Replace endpoints/shapes with the real OpenAPI
 * surface. Put each resource/tag in its own class (e.g. {@code OrdersApiTest}) so parallel
 * writers don't collide. The {@code @Tag("api")} lane is selected by
 * {@code -Dgroups=api} / {@code -Papi}; with no selection it runs as part of the full suite.
 */
@Tag("api")
class ExampleApiTest {

    private final ApiClient api = new ApiClient();

    @Test
    void health_endpoint_responds() {
        given().spec(api.anon())
                .when().get(ApiClient.HEALTH) // <-- adapt
                .then().statusCode(anyOf(is(200), is(204)));
    }

    @Test
    void authenticated_read_returns_the_contracted_shape() {
        given().spec(api.apiAs("user"))
                .when().get(ApiClient.ME) // <-- adapt
                .then().statusCode(200)
                .body("id", notNullValue()); // <-- assert the real contract from OpenAPI
    }

    @Test
    void create_with_valid_data_succeeds() {
        given().spec(api.apiAs("user")).contentType(JSON)
                .body(order().build()) // unique, override-friendly via DataFactory
                .when().post(ApiClient.ORDERS) // <-- adapt resource
                .then().statusCode(201); // <-- assert per OpenAPI
    }

    @Test
    void negative_protected_route_rejects_anonymous_access() {
        given().spec(api.anon())
                .when().get(ApiClient.ME) // <-- adapt protected route
                .then().statusCode(anyOf(is(401), is(403)));
    }

    /**
     * Contract oracle: the response must conform to the OpenAPI component schema. Self-skips
     * when no OpenAPI doc is present (set OPENAPI_PATH / drop ./openapi.json to enable).
     */
    @Test
    void response_conforms_to_the_openapi_schema() {
        assumeTrue(SchemaOracle.specAvailable(),
                "no OpenAPI doc at " + SchemaOracle.openApiPath() + " — set OPENAPI_PATH to enable the schema oracle");
        given().spec(api.apiAs("user"))
                .when().get(ApiClient.ORDERS + "/1") // <-- adapt
                .then().statusCode(200)
                .body(SchemaOracle.matchesSchema("#/components/schemas/Order")); // <-- adapt component
    }
}
