package qa.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.hamcrest.BaseMatcher;
import org.hamcrest.Description;
import org.hamcrest.Matcher;
import qa.support.oracles.OpenApi;
import qa.support.oracles.Schema;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Supplier;

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
 * <p>The matcher delegates to the strict {@link Schema#assertSchemaRef} (JSON Schema draft
 * 2020-12, undocumented fields are RED). Prefer {@link Schema#assertSchema} with an
 * operationId when the response status is part of the contract.
 *
 * <p>ADAPT-ME: point {@code OPENAPI_PATH} at the spec file Kalchas found (JSON; convert
 * YAML first), or fetch it from the live Swagger endpoint at setup and save it locally.
 * Default location: {@code ./openapi.json}.
 */
public final class SchemaOracle {

    private SchemaOracle() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Configured OpenAPI doc location ({@code OPENAPI_PATH} env, default {@code ./openapi.json}). */
    public static Path openApiPath() {
        return OpenApi.defaultPath();
    }

    /** True when the OpenAPI doc exists on disk. */
    public static boolean specAvailable() {
        return Files.exists(openApiPath());
    }

    /**
     * A Hamcrest matcher asserting the body strictly conforms to a named OpenAPI component,
     * e.g. {@code "#/components/schemas/Order"}, of the configured document.
     */
    public static Matcher<?> matchesSchema(String componentRef) {
        return new StrictSchemaMatcher(OpenApi::configured, componentRef);
    }

    /** As {@link #matchesSchema(String)} against an explicit document. */
    public static Matcher<?> matchesSchema(OpenApi document, String componentRef) {
        return new StrictSchemaMatcher(() -> document, componentRef);
    }

    private static final class StrictSchemaMatcher extends BaseMatcher<Object> {
        private final Supplier<OpenApi> document;
        private final String ref;
        private String failure;

        StrictSchemaMatcher(Supplier<OpenApi> document, String ref) {
            this.document = document;
            this.ref = ref;
        }

        @Override
        public boolean matches(Object body) {
            try {
                OpenApi doc = document.get();
                if (body instanceof String text) Schema.assertSchemaStrict(doc, text, ref);
                else if (body instanceof byte[] bytes) Schema.assertSchemaStrict(doc, new String(bytes, StandardCharsets.UTF_8), ref);
                else if (body instanceof JsonNode node) Schema.assertSchemaStrict(doc, node, ref);
                else Schema.assertSchemaStrict(doc, (JsonNode) MAPPER.valueToTree(body), ref);
                failure = null;
                return true;
            } catch (AssertionError e) {
                failure = e.getMessage();
                return false;
            }
        }

        @Override
        public void describeTo(Description description) {
            description.appendText("a body strictly matching " + ref);
        }

        @Override
        public void describeMismatch(Object item, Description description) {
            description.appendText(failure == null ? "did not match " + ref : failure);
        }
    }
}
