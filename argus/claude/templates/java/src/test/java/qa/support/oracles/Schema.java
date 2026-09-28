package qa.support.oracles;

import com.fasterxml.jackson.databind.JsonNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.ValidationMessage;
import io.restassured.response.Response;
import qa.support.oracles.OpenApi.Direction;

import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Strict OpenAPI schema oracles (JSON Schema draft 2020-12, see {@link OpenApi}).
 *
 * <p>Strict is the default: an undocumented field anywhere in the body is RED. Opting out
 * needs a written reason ({@link Options#lenient(String)}), which stays visible in the test
 * source. Every overload without an {@link OpenApi} argument uses {@link OpenApi#configured()}
 * ({@code OPENAPI_PATH}, else {@code ./openapi.json}). A violation throws
 * {@link AssertionError} listing the messages and a redacted body excerpt of at most 500
 * characters; misuse (an unknown operationId or schema, lenient mode without a reason)
 * throws {@link IllegalArgumentException}.
 */
public final class Schema {

    /**
     * Strict by default; {@code strict=false} needs a non-empty reason. The direction applies to
     * {@code assertSchemaRef} only and defaults to the response view.
     */
    public record Options(boolean strict, String reason, Direction direction) {

        public static final Options STRICT = new Options(true, null);

        public Options {
            if (!strict && (reason == null || reason.isBlank())) {
                throw new IllegalArgumentException("strict=false needs a non-empty reason naming why undocumented fields are acceptable here");
            }
            direction = direction == null ? Direction.RESPONSE : direction;
        }

        public Options(boolean strict, String reason) {
            this(strict, reason, Direction.RESPONSE);
        }

        public static Options lenient(String reason) {
            return new Options(false, reason);
        }

        public Options withDirection(Direction next) {
            return new Options(strict, reason, next);
        }
    }

    private static final int MAX_MESSAGES = 20;
    private static final Pattern JSON_MEDIA = Pattern.compile("^application/([\\w.+-]+\\+)?json\\s*(;.*)?$", Pattern.CASE_INSENSITIVE);

    private Schema() {}

    public static void assertSchema(Response res, String operationId) {
        assertSchema(OpenApi.configured(), res, operationId, Options.STRICT);
    }

    public static void assertSchema(Response res, String operationId, Options options) {
        assertSchema(OpenApi.configured(), res, operationId, options);
    }

    public static void assertSchema(OpenApi doc, Response res, String operationId, Options options) {
        assertSchema(doc, res.statusCode(), res.asString(), operationId, options);
    }

    /**
     * Validates a body against {@code responses[key].content['application/json'].schema} of
     * {@code operationId}, where the key is the exact status, else its {@code NXX} range, else
     * {@code default} (OpenAPI 3.x); failure messages name a range or default key. A status
     * none of them covers is RED; a status documented without content requires an empty body.
     */
    public static void assertSchema(OpenApi doc, int status, String body, String operationId, Options options) {
        Optional<String> key = doc.responseKey(operationId, status);
        if (key.isEmpty()) {
            List<String> documented = doc.documentedStatuses(operationId);
            throw new AssertionError(operationId + ": HTTP " + status + " is not documented (documented: "
                    + (documented.isEmpty() ? "none" : String.join(", ", documented)) + "); body excerpt: " + Http.excerpt(body));
        }
        String label = operationId + ": HTTP " + status + (key.get().equals(Integer.toString(status)) ? "" : " via " + key.get());
        JsonNode content = doc.response(operationId, status).orElseThrow().path("content");
        if (!content.isObject() || content.isEmpty()) {
            if (body != null && !body.isEmpty()) {
                throw new AssertionError(label + " documents no content, but the body is not empty: " + Http.excerpt(body));
            }
            return;
        }
        String mediaType = content.has("application/json") ? "application/json" : null;
        for (Iterator<String> names = content.fieldNames(); mediaType == null && names.hasNext(); ) {
            String name = names.next();
            if (JSON_MEDIA.matcher(name).matches()) mediaType = name;
        }
        if (mediaType == null) {
            throw new IllegalArgumentException(label + " documents no JSON media type; assertSchema validates JSON bodies only");
        }
        JsonNode media = content.get(mediaType);
        if (!media.has("schema")) return;
        JsonSchema validator = doc.schemaFor(operationId + "|" + key.get() + "|" + mediaType, media.get("schema"), Direction.RESPONSE, options.strict());
        validate(validator, parse(body, label), body, label + " (" + mediaType + ")", options);
    }

    public static void assertSchemaRef(JsonNode body, String ref) {
        assertSchemaRef(OpenApi.configured(), body, ref, Options.STRICT);
    }

    public static void assertSchemaRef(String body, String ref) {
        assertSchemaRef(OpenApi.configured(), body, ref, Options.STRICT);
    }

    public static void assertSchemaRef(JsonNode body, String ref, Options options) {
        assertSchemaRef(OpenApi.configured(), body, ref, options);
    }

    public static void assertSchemaRef(String body, String ref, Options options) {
        assertSchemaRef(OpenApi.configured(), body, ref, options);
    }

    /** Validates a body against a local pointer such as {@code #/components/schemas/Order}. */
    public static void assertSchemaRef(OpenApi doc, JsonNode body, String ref, Options options) {
        JsonSchema validator = doc.schemaForRef(ref, options.direction(), options.strict());
        validate(validator, body, body == null ? null : body.toString(), ref, options);
    }

    /** As {@link #assertSchemaRef(OpenApi, JsonNode, String, Options)} for raw JSON text. */
    public static void assertSchemaRef(OpenApi doc, String body, String ref, Options options) {
        JsonSchema validator = doc.schemaForRef(ref, options.direction(), options.strict());
        validate(validator, parse(body, ref), body, ref, options);
    }

    public static void assertSchemaStrict(JsonNode body, String ref) {
        assertSchemaRef(OpenApi.configured(), body, ref, Options.STRICT);
    }

    public static void assertSchemaStrict(String body, String ref) {
        assertSchemaRef(OpenApi.configured(), body, ref, Options.STRICT);
    }

    public static void assertSchemaStrict(OpenApi doc, JsonNode body, String ref) {
        assertSchemaRef(doc, body, ref, Options.STRICT);
    }

    public static void assertSchemaStrict(OpenApi doc, String body, String ref) {
        assertSchemaRef(doc, body, ref, Options.STRICT);
    }

    private static JsonNode parse(String body, String label) {
        JsonNode json = Http.parse(body);
        if (json == null) throw new AssertionError(label + ": the body is not JSON: " + Http.excerpt(body));
        return json;
    }

    private static void validate(JsonSchema validator, JsonNode body, String raw, String label, Options options) {
        if (body == null) throw new AssertionError(label + ": no body to validate");
        List<String> messages = validator.validate(body).stream().map(ValidationMessage::getMessage).distinct().toList();
        if (messages.isEmpty()) return;
        StringBuilder message = new StringBuilder(label).append(": body does not match the schema")
                .append(options.strict() ? " (strict)" : " (lenient: " + options.reason() + ")");
        messages.stream().limit(MAX_MESSAGES).forEach(m -> message.append("\n  - ").append(m));
        if (messages.size() > MAX_MESSAGES) message.append("\n  - (+").append(messages.size() - MAX_MESSAGES).append(" more)");
        throw new AssertionError(message.append("\nbody excerpt: ").append(Http.excerpt(raw)).toString());
    }
}
