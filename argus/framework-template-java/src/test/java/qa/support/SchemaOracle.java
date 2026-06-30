package qa.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.restassured.module.jsv.JsonSchemaValidator;
import org.hamcrest.Matcher;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Contract testing mechanised: validate live responses against the OpenAPI schema
 * instead of hand-rolled per-field assertions. The spec IS the oracle — every mismatch
 * this surfaces is a contract-drift bug candidate for Atalanta.
 *
 * <p>Usage in an API spec:
 * <pre>{@code
 *   given().spec(api.apiAs("user"))
 *     .when().get(ApiClient.ORDERS + "/1")
 *     .then().body(SchemaOracle.matchesSchema("#/components/schemas/Order"));
 * }</pre>
 *
 * <p>ADAPT-ME: point {@code OPENAPI_PATH} at the spec file Kalchas found (JSON; convert
 * YAML first), or fetch it from the live Swagger endpoint at setup and save it locally.
 * Default location: {@code ./openapi.json}. Tests should guard with
 * {@link #specAvailable()} so they self-skip when no spec is present.
 */
public final class SchemaOracle {

    private SchemaOracle() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static JsonNode doc; // cached parsed OpenAPI document

    /** Configured OpenAPI doc location ({@code OPENAPI_PATH} env, default {@code ./openapi.json}). */
    public static Path openApiPath() {
        String p = System.getenv("OPENAPI_PATH");
        return Paths.get((p == null || p.isBlank()) ? "openapi.json" : p);
    }

    /** True when the OpenAPI doc exists on disk — gate schema assertions on this. */
    public static boolean specAvailable() {
        return Files.exists(openApiPath());
    }

    private static synchronized JsonNode doc() {
        if (doc == null) {
            try {
                doc = MAPPER.readTree(openApiPath().toFile());
            } catch (Exception e) {
                throw new IllegalStateException(
                        "cannot read OpenAPI spec at " + openApiPath()
                                + " (set OPENAPI_PATH, or guard the test with SchemaOracle.specAvailable()): "
                                + e.getMessage(), e);
            }
        }
        return doc;
    }

    /**
     * Build a Hamcrest matcher asserting the response body conforms to a named OpenAPI
     * component, e.g. {@code "#/components/schemas/Order"}.
     *
     * <p>OpenAPI keeps reusable schemas under {@code components/schemas}; the JSON-Schema
     * validator wants a self-contained schema with a root {@code $ref}. We assemble one:
     * the component subtree under standard {@code definitions}, with all internal
     * {@code #/components/schemas/...} pointers rewritten to {@code #/definitions/...}.
     */
    public static Matcher<?> matchesSchema(String componentRef) {
        JsonNode schemas = doc().path("components").path("schemas");
        if (schemas.isMissingNode() || !schemas.isObject()) {
            throw new IllegalStateException("OpenAPI doc has no components.schemas at " + openApiPath());
        }
        ObjectNode root = MAPPER.createObjectNode();
        root.put("$schema", "http://json-schema.org/draft-04/schema#");
        root.set("definitions", schemas);
        root.put("$ref", componentRef);

        String schema;
        try {
            schema = MAPPER.writeValueAsString(root);
        } catch (Exception e) {
            throw new IllegalStateException("could not serialise generated schema for " + componentRef, e);
        }
        // Rewrite OpenAPI's #/components/schemas/X pointers to the standalone #/definitions/X scope.
        schema = schema.replace("#/components/schemas/", "#/definitions/");
        return JsonSchemaValidator.matchesJsonSchema(schema);
    }
}
