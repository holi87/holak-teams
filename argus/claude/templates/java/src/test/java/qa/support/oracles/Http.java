package qa.support.oracles;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.restassured.response.Response;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Exact HTTP status oracles. A status is one documented integer, never a class: "any 2xx" or
 * {@code anyOf(401, 403)} hides the defects Argus hunts. A RED throws {@link AssertionError};
 * misuse throws {@link IllegalArgumentException}.
 */
public final class Http {

    /** REST states and the one status code each maps to. */
    public enum RestState {
        CREATED(201, "created"),
        DELETED(204, "deleted"),
        MISSING(404, "missing"),
        METHOD_NOT_ALLOWED(405, "method-not-allowed"),
        UNSUPPORTED_MEDIA_TYPE(415, "unsupported-media-type"),
        MALFORMED(400, "malformed"),
        UNAUTHENTICATED(401, "unauthenticated"),
        FORBIDDEN(403, "forbidden"),
        CONFLICT(409, "conflict"),
        OK(200, "ok");

        private final int status;
        private final String label;

        RestState(int status, String label) {
            this.status = status;
            this.label = label;
        }

        public int status() {
            return status;
        }

        public String label() {
            return label;
        }

        public static RestState of(String label) {
            for (RestState state : values()) if (state.label.equals(label)) return state;
            throw new IllegalArgumentException("unknown REST state " + label);
        }
    }

    /** Parses whole bodies only: trailing content after a JSON value makes the body non-JSON. */
    static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private static final int EXCERPT_LIMIT = 500;
    private static final String REDACTED = "[REDACTED]";
    private static final Pattern SECRET_KEY = Pattern.compile("authorization|token|password|secret|cookie");
    private static final Pattern SCHEME_TOKEN = Pattern.compile("(?i)\\b(bearer|basic)\\s+[A-Za-z0-9._~+/=-]+");
    private static final Pattern SECRET_PAIR = Pattern.compile(
            "(?i)([A-Za-z0-9_-]*(?:authorization|token|password|secret|cookie)[A-Za-z0-9_-]*[\"']?\\s*[:=]\\s*[\"']?)[^\"'&\\s,;}]+");

    private Http() {}

    /** Fails unless the response status is exactly {@code exact}. */
    public static void expectStatus(Response res, int exact) {
        requireStatusCode(exact, "expectStatus: exact");
        if (res.statusCode() != exact) {
            throw new AssertionError("expected HTTP " + exact + ", got " + res.statusCode() + "; body excerpt: " + excerpt(res.asString()));
        }
    }

    public static void assertRestStatus(Response res, RestState state) {
        assertRestStatus(res, state, null);
    }

    /**
     * Asserts a REST state with its exact code: created=201 with a non-empty {@code Location},
     * deleted=204 with an empty body, method-not-allowed=405 with {@code Allow}, missing=404,
     * unsupported-media-type=415, malformed=400, unauthenticated=401, forbidden=403,
     * conflict=409, ok=200. {@code documentedStatus} replaces the code with the one the API
     * documents (one exact integer, never a class); the Location, empty-body and Allow
     * requirements belong to the standard code and apply only when it is the expected one.
     */
    public static void assertRestStatus(Response res, RestState state, Integer documentedStatus) {
        if (documentedStatus != null) requireStatusCode(documentedStatus, "assertRestStatus: documentedStatus (one exact code, never a class)");
        int expected = documentedStatus == null ? state.status() : documentedStatus;
        if (res.statusCode() != expected) {
            throw new AssertionError(state.label() + ": expected HTTP " + expected + ", got " + res.statusCode()
                    + "; body excerpt: " + excerpt(res.asString()));
        }
        if (expected != state.status()) return;
        String problem = switch (state) {
            case CREATED -> blank(res.getHeader("Location")) ? "HTTP 201 without a non-empty Location header" : null;
            case DELETED -> res.asByteArray().length > 0 ? "HTTP 204 with a non-empty body" : null;
            case METHOD_NOT_ALLOWED -> blank(res.getHeader("Allow")) ? "HTTP 405 without an Allow header" : null;
            default -> null;
        };
        if (problem != null) throw new AssertionError(state.label() + ": " + problem + "; body excerpt: " + excerpt(res.asString()));
    }

    /**
     * A single-line body excerpt of at most 500 characters. Values under keys naming
     * authorization, token, password, secret or cookie, and bearer/basic credentials, are
     * replaced by {@code [REDACTED]}.
     */
    public static String excerpt(String body) {
        if (body == null || body.isEmpty()) return "(empty)";
        JsonNode json = parse(body);
        String text = json == null
                ? SECRET_PAIR.matcher(SCHEME_TOKEN.matcher(body).replaceAll("$1 " + REDACTED)).replaceAll("$1" + REDACTED)
                : redact(json.deepCopy()).toString();
        text = text.replaceAll("[\\r\\n\\t]+", " ");
        return text.length() <= EXCERPT_LIMIT ? text : text.substring(0, EXCERPT_LIMIT - 3) + "...";
    }

    /** The body as JSON, or null when it is empty or not one complete JSON value. */
    static JsonNode parse(String body) {
        if (body == null || body.isBlank()) return null;
        try {
            return JSON.readTree(body);
        } catch (Exception notJson) {
            return null;
        }
    }

    private static JsonNode redact(JsonNode node) {
        if (node.isObject()) {
            ObjectNode object = (ObjectNode) node;
            List<String> keys = new ArrayList<>();
            object.fieldNames().forEachRemaining(keys::add);
            for (String key : keys) {
                if (SECRET_KEY.matcher(key.toLowerCase(Locale.ROOT)).find()) object.put(key, REDACTED);
                else redact(object.get(key));
            }
        } else if (node.isArray()) {
            node.forEach(Http::redact);
        }
        return node;
    }

    private static void requireStatusCode(int value, String label) {
        if (value < 100 || value > 599) throw new IllegalArgumentException(label + " must be one HTTP status code (100-599), got " + value);
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
