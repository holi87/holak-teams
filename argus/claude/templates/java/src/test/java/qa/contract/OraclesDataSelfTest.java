package qa.contract;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import io.restassured.response.Response;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import qa.support.argus.StubServer;
import qa.support.argus.StubServer.StubResponse;
import qa.support.oracles.Boundary;
import qa.support.oracles.Boundary.BoundaryPoint;
import qa.support.oracles.Boundary.BoundaryPoints;
import qa.support.oracles.Boundary.MoneyReconciliation;
import qa.support.oracles.Boundary.Probe;
import qa.support.oracles.Http;
import qa.support.oracles.I18n;
import qa.support.oracles.I18n.I18nVector;
import qa.support.oracles.Identity;
import qa.support.oracles.Identity.CredentialAttempt;
import qa.support.oracles.Identity.CredentialCheck;
import qa.support.oracles.Identity.CredentialOptions;
import qa.support.oracles.Identity.CredentialReport;
import qa.support.oracles.Identity.Credentials;
import qa.support.oracles.Identity.InvalidEmail;
import qa.support.oracles.Identity.UnicodeEdge;
import qa.support.oracles.Identity.Whitespace;
import qa.support.oracles.Pagination;
import qa.support.oracles.Pagination.Mode;
import qa.support.oracles.Pagination.PageFetcher;
import qa.support.oracles.Pagination.PageResult;
import qa.support.oracles.Pagination.PaginationResult;
import qa.support.oracles.Partitions;
import qa.support.oracles.Partitions.Partition;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.UnaryOperator;
import java.util.stream.IntStream;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Self-tests for the data oracles, the Java port of oracles-data.selftest.spec.ts: every
 * helper passes on a correct in-memory or stub implementation and fails on a faulty one.
 * Nothing contacts a real target; each stub binds 127.0.0.1 on an ephemeral port and lives
 * for one test. Negative cases assert the rejection itself (a RED through
 * {@code assertThrows(AssertionError.class, ...)}, misuse through
 * {@code IllegalArgumentException}), so a healthy run reports {@code product pass} for every
 * case.
 */
@Tag("contract-smoke")
class OraclesDataSelfTest {

    @Test
    void emailPartitionsDoNotRequireADottedDomain() {
        JsonSchema reference = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012)
                .getSchema(json("{'type':'string','format':'email'}"), REFERENCE_CONFIG);
        assertTrue(reference.validate(MAPPER.valueToTree("argus.qa@example")).isEmpty());
        for (InvalidEmail email : Identity.INVALID_EMAILS) {
            assertFalse(reference.validate(MAPPER.valueToTree(email.value())).isEmpty(), email.label());
        }
    }

    private record Item(int id) {}

    private enum AuthFault { TRIM_REGISTER, TRIM_LOGIN, TRIM_BOTH, CASE_INSENSITIVE_PASSWORD, CASE_SENSITIVE_EMAIL }

    /** Exact decimals: 0.06 parses as 0.06, never as the nearest double. */
    private static final ObjectMapper MAPPER = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);

    // JSON Schema 2020-12 with the native email assertion, including single-label domains.
    private static final JsonSchemaFactory REFERENCE = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
    private static final SchemaValidatorsConfig REFERENCE_CONFIG = SchemaValidatorsConfig.builder()
            .formatAssertionsEnabled(true).locale(Locale.ENGLISH).build();

    private static final String ORDER_SCHEMA = "{'type':'object','required':['sku','qty'],'properties':{"
            + "'id':{'type':'integer','readOnly':true},"
            + "'sku':{'type':'string','minLength':3,'maxLength':12,'pattern':'^[A-Za-z0-9-]+$'},"
            + "'qty':{'type':'integer','minimum':1,'maximum':99},"
            + "'note':{'type':['string','null'],'maxLength':20}},"
            + "'additionalProperties':false}";
    private static final String VALID_ORDER = "{'sku':'SKU-1','qty':2,'note':null}";
    private static final int PROFILE_MAX_LENGTH = 20;

    /** Parses JSON written with single quotes for readability. */
    private static JsonNode json(String text) {
        try {
            return MAPPER.readTree(text.replace('\'', '"'));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static JsonNode read(byte[] body) {
        try {
            return MAPPER.readTree(body);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static JsonNode read(String body) {
        return read(body.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] bytes(Object value) {
        try {
            return MAPPER.writeValueAsBytes(value);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static BigDecimal dec(String value) {
        return new BigDecimal(value);
    }

    /** Each partition as label=value, the value as JSON with single quotes. */
    private static List<String> render(List<Partition> partitions) {
        return partitions.stream().map(partition -> partition.label() + "=" + partition.value().toString().replace('"', '\'')).toList();
    }

    private static List<String> labels(List<Partition> partitions) {
        return partitions.stream().map(Partition::label).toList();
    }

    private static JsonNode valueOf(List<Partition> partitions, String label) {
        return partitions.stream().filter(partition -> partition.label().equals(label)).findFirst().map(Partition::value).orElse(null);
    }

    private static int[] codePoints(String value) {
        return value.codePoints().toArray();
    }

    /** Asserts a RED whose message contains every {@code expected} fragment. */
    private static String red(Executable call, String... expected) {
        String message = assertThrows(AssertionError.class, call).getMessage();
        for (String fragment : expected) assertTrue(message.contains(fragment), "expected '" + fragment + "' in: " + message);
        return message;
    }

    /** Asserts a usage error whose message contains {@code expected}. */
    private static String misuse(Executable call, String expected) {
        String message = assertThrows(IllegalArgumentException.class, call).getMessage();
        assertTrue(message.contains(expected), "expected '" + expected + "' in: " + message);
        return message;
    }

    private static boolean valid(JsonNode schema, JsonNode value) {
        return REFERENCE.getSchema(schema, REFERENCE_CONFIG).validate(value).isEmpty();
    }

    /** Sends {@code value} as exact UTF-8 JSON. */
    private static Response send(String method, String url, Object value) {
        return given().baseUri(url).contentType("application/json; charset=utf-8").body(bytes(value)).request(method);
    }

    /** POST /orders answers 201 when {@code schema} accepts the body and 400 otherwise. */
    private static StubServer.Handler orderEndpoint(JsonNode schema) {
        return request -> {
            if (!"POST".equals(request.method()) || !"/orders".equals(request.path())) return null;
            return valid(schema, read(request.body())) ? StubResponse.json(201, Map.of("id", 1)) : StubResponse.json(400, Map.of("error", "invalid order"));
        };
    }

    /**
     * GET /items?page=&pageSize= over {@code count} items with 1-based pages. Faults:
     * {@code overlap} starts every page after the first one item early (the last item of a
     * page repeats), {@code totalDrift} reports a wrong total, {@code ignorePage} serves the
     * first page for every page number.
     */
    private static StubServer pageStub(int count, boolean overlap, int totalDrift, boolean ignorePage) {
        return StubServer.start(request -> {
            if (!"GET".equals(request.method()) || !"/items".equals(request.path())) return null;
            int page = ignorePage ? 1 : Integer.parseInt(request.query().get("page"));
            int size = Integer.parseInt(request.query().get("pageSize"));
            int start = (page - 1) * size - (overlap && page > 1 ? 1 : 0);
            List<Map<String, Integer>> items = IntStream.rangeClosed(1, count).skip(start).limit(size).mapToObj(id -> Map.of("id", id)).toList();
            return StubResponse.json(200, Map.of("items", items, "total", count + totalDrift));
        });
    }

    private static StubServer pageStub(int count) {
        return pageStub(count, false, 0, false);
    }

    /**
     * GET /feed?cursor=&pageSize= over {@code count} items; the cursor is an offset. Faults:
     * {@code unstable} drops item 7 from the second walk, {@code cycle} points back to offset 5
     * once the offset reaches 10.
     */
    private static StubServer cursorStub(int count, String fault) {
        AtomicInteger walks = new AtomicInteger();
        return StubServer.start(request -> {
            if (!"GET".equals(request.method()) || !"/feed".equals(request.path())) return null;
            String cursor = request.query().get("cursor");
            int offset = cursor == null ? 0 : Integer.parseInt(cursor);
            int size = Integer.parseInt(request.query().get("pageSize"));
            if (offset == 0) walks.incrementAndGet();
            List<Integer> source = IntStream.rangeClosed(1, count).filter(id -> !("unstable".equals(fault) && walks.get() == 2 && id == 7)).boxed().toList();
            String nextCursor = offset + size < source.size() ? String.valueOf(offset + size) : null;
            if ("cycle".equals(fault) && offset >= 10) nextCursor = "5";
            List<Map<String, Integer>> items = source.stream().skip(offset).limit(size).map(id -> Map.of("id", id)).toList();
            ObjectNode body = MAPPER.createObjectNode();
            body.set("items", MAPPER.valueToTree(items));
            body.put("nextCursor", nextCursor);
            return new StubResponse(200, Map.of(), body);
        });
    }

    private static PageResult<Item> page(Response res) {
        JsonNode body = read(res.asByteArray());
        List<Item> items = new ArrayList<>();
        body.path("items").forEach(item -> items.add(new Item(item.path("id").asInt())));
        return new PageResult<>(items, body.hasNonNull("total") ? body.get("total").asLong() : null,
                body.hasNonNull("nextCursor") ? body.get("nextCursor").asText() : null);
    }

    private static PageFetcher<Item> pages(StubServer stub) {
        return request -> page(given().baseUri(stub.url()).queryParam("page", request.page() == null ? 1 : request.page())
                .queryParam("pageSize", request.pageSize()).get("/items"));
    }

    private static PageFetcher<Item> feed(StubServer stub) {
        return request -> {
            var spec = given().baseUri(stub.url()).queryParam("pageSize", request.pageSize());
            if (request.cursor() != null) spec = spec.queryParam("cursor", request.cursor());
            return page(spec.get("/feed"));
        };
    }

    private static List<Object> ids(int from, int to) {
        return IntStream.rangeClosed(from, to).boxed().map(Object.class::cast).toList();
    }

    /** POST /register and POST /login; a correct service keys email case-insensitively and compares passwords byte for byte. */
    private static StubServer authStub(AuthFault fault) {
        Map<String, String> accounts = new ConcurrentHashMap<>();
        return StubServer.start(request -> {
            if (!"POST".equals(request.method())) return null;
            JsonNode body = read(request.body());
            String email = body.path("email").asText();
            String key = fault == AuthFault.CASE_SENSITIVE_EMAIL ? email : email.toLowerCase(Locale.ROOT);
            if ("/register".equals(request.path())) {
                if (accounts.containsKey(key)) return StubResponse.json(409, Map.of("error", "exists"));
                boolean trim = fault == AuthFault.TRIM_REGISTER || fault == AuthFault.TRIM_BOTH;
                String password = body.path("password").asText();
                accounts.put(key, trim ? password.strip() : password);
                return StubResponse.json(201, Map.of());
            }
            if ("/login".equals(request.path())) {
                boolean trim = fault == AuthFault.TRIM_LOGIN || fault == AuthFault.TRIM_BOTH;
                String offered = trim ? body.path("password").asText().strip() : body.path("password").asText();
                String stored = accounts.get(key);
                boolean matches = stored != null && (fault == AuthFault.CASE_INSENSITIVE_PASSWORD
                        ? stored.toLowerCase(Locale.ROOT).equals(offered.toLowerCase(Locale.ROOT)) : stored.equals(offered));
                return StubResponse.json(matches ? 200 : 401, Map.of());
            }
            return null;
        });
    }

    private static CredentialAttempt register(StubServer stub) {
        return credentials -> send("POST", stub.url() + "/register", credentialBody(credentials)).statusCode() == 201;
    }

    private static CredentialAttempt login(StubServer stub) {
        return credentials -> send("POST", stub.url() + "/login", credentialBody(credentials)).statusCode() == 200;
    }

    private static Map<String, String> credentialBody(Credentials credentials) {
        return Map.of("email", credentials.email(), "password", credentials.password());
    }

    /** PUT /profile stores {@code store(name)} (null refuses with 400); GET /profile reads it back. */
    private static StubServer profileStub(UnaryOperator<String> store) {
        AtomicReference<String> name = new AtomicReference<>("");
        return StubServer.start(request -> {
            if (!"/profile".equals(request.path())) return null;
            if ("GET".equals(request.method())) return StubResponse.json(200, Map.of("name", name.get()));
            if (!"PUT".equals(request.method())) return null;
            String stored = store.apply(read(request.body()).path("name").asText());
            if (stored == null) return StubResponse.json(400, Map.of("error", "invalid name"));
            name.set(stored);
            return StubResponse.json(200, Map.of());
        });
    }

    private static I18n.Submit submit(StubServer stub) {
        return value -> send("PUT", stub.url() + "/profile", Map.of("name", value)).statusCode() == 200;
    }

    private static I18n.ReadBack readBack(StubServer stub) {
        return () -> read(given().baseUri(stub.url()).get("/profile").asByteArray()).path("name").asText();
    }

    private static boolean withinLimit(String value) {
        return value.codePointCount(0, value.length()) <= PROFILE_MAX_LENGTH;
    }

    @Test
    void partitions_an_email_field_yields_the_email_labels_then_the_string_labels() {
        assertEquals(List.of(
                "email.missing-at='argus.qa.example.com'",
                "email.missing-domain='argus.qa@'",
                "email.missing-local-part='@example.com'",
                "email.double-at='argus.qa@@example.com'",
                "email.embedded-whitespace='argus qa@example.com'",
                "string.above-max-length='" + "a".repeat(65) + "'",
                "type.number-for-string=1",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'string','format':'email','maxLength':64}"))));
        assertEquals(Identity.INVALID_EMAILS.stream().map(InvalidEmail::label).toList(),
                labels(Partitions.invalidPartitions(json("{'type':'string','format':'email'}"))).subList(0, 5));
    }

    @Test
    void partitions_string_length_and_pattern_constraints_in_order() {
        assertEquals(List.of(
                "string.below-min-length='a'",
                "string.above-max-length='aaaaaa'",
                "string.pattern-mismatch=''",
                "string.empty=''",
                "type.number-for-string=1",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'string','minLength':2,'maxLength':5,'pattern':'^[a-z]+$'}"))));
        // The first candidate the pattern rejects wins; a pattern that accepts all of them has no mismatch.
        assertEquals(" ", valueOf(Partitions.invalidPartitions(json("{'type':'string','pattern':'^[a-z]*$'}")), "string.pattern-mismatch").textValue());
        assertEquals("0", valueOf(Partitions.invalidPartitions(json("{'type':'string','pattern':'^[^0-9]*$'}")), "string.pattern-mismatch").textValue());
        assertNull(valueOf(Partitions.invalidPartitions(json("{'type':'string','pattern':'.*'}")), "string.pattern-mismatch"));
        assertEquals(List.of("string.below-min-length=''", "string.empty=''"),
                render(Partitions.invalidPartitions(json("{'type':'string','minLength':1}"))).subList(0, 2));
        assertEquals(List.of("type.number-for-string", "type.null-for-non-nullable"), labels(Partitions.invalidPartitions(json("{'type':'string','minLength':0}"))));
    }

    @Test
    void partitions_integer_bounds_fractional_unsafe_and_multipleOf_values() {
        assertEquals(List.of(
                "number.below-minimum=0",
                "number.above-maximum=11",
                "number.fractional-for-integer=1.5",
                "type.string-for-number='1'",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'integer','minimum':1,'maximum':10}"))));
        assertEquals(List.of(
                "number.below-minimum=-1",
                "number.fractional-for-integer=0.5",
                "number.unsafe-integer=9007199254740992",
                "type.string-for-number='0'",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'integer','minimum':0}"))));
        // An integer multipleOf is the step, so every value breaks exactly one constraint.
        assertEquals(List.of(
                "number.below-minimum=5",
                "number.above-maximum=55",
                "number.fractional-for-integer=10.5",
                "number.multiple-of-violation=11",
                "type.string-for-number='10'",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'integer','minimum':10,'maximum':50,'multipleOf':5}"))));
        List<Partition> enumerated = Partitions.invalidPartitions(json("{'type':'integer','enum':[1,2,3]}"));
        assertEquals(List.of("number.fractional-for-integer", "number.unsafe-integer", "type.string-for-number", "enum.out-of-enum",
                "type.null-for-non-nullable"), labels(enumerated));
        assertEquals(json("4"), valueOf(enumerated, "enum.out-of-enum"));
    }

    @Test
    void partitions_number_steps_come_from_multipleOf_or_numberStep_never_a_blind_plus_minus_one() {
        assertEquals(List.of(
                "number.below-minimum=-0.01",
                "number.above-maximum=100.01",
                "number.multiple-of-violation=0.005",
                "type.string-for-number='0'",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'number','minimum':0,'maximum':100,'multipleOf':0.01}"))));
        assertEquals(List.of(
                "number.exclusive-minimum-equal=0",
                "number.exclusive-maximum-equal=1",
                "type.string-for-number='0.1'",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'number','exclusiveMinimum':0,'exclusiveMaximum':1}"), dec("0.1"))));
        // Exact cents where floating point drifts: 0.07 - 0.01 is 0.060000000000000005 as doubles.
        assertEquals(List.of("number.below-minimum=0.06", "number.above-maximum=0.71"),
                render(Partitions.invalidPartitions(json("{'type':'number','minimum':0.07,'maximum':0.7}"), dec("0.01"))).subList(0, 2));
        // OpenAPI 3.0: a boolean exclusiveMinimum and nullable read the same as the 3.1 forms.
        assertEquals(List.of(
                "number.above-maximum=5.5",
                "number.exclusive-minimum-equal=0",
                "type.string-for-number='0.5'"), render(Partitions.invalidPartitions(json("{'type':'number','minimum':0,'exclusiveMinimum':true,'maximum':5,'nullable':true}"), dec("0.5"))));
        misuse(() -> Partitions.invalidPartitions(json("{'type':'number','minimum':0}")), "numberStep");
        misuse(() -> Partitions.invalidPartitions(json("{'type':'number','maximum':1}"), BigDecimal.ZERO), "numberStep");
        // An unbounded number needs no step.
        assertEquals(List.of("type.string-for-number='0'", "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'number'}"))));
    }

    @Test
    void partitions_enum_boolean_nullable_and_usage_errors() {
        assertEquals(List.of(
                "type.number-for-string=1",
                "enum.out-of-enum='argus-out-of-enum'",
                "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'string','enum':['red','blue']}"))));
        assertEquals(List.of("type.string-for-boolean='true'", "type.null-for-non-nullable=null"), render(Partitions.invalidPartitions(json("{'type':'boolean'}"))));
        assertEquals(json("false"), valueOf(Partitions.invalidPartitions(json("{'type':'boolean','enum':[true]}")), "enum.out-of-enum"));
        assertEquals(List.of("string.above-max-length", "type.number-for-string"), labels(Partitions.invalidPartitions(json("{'type':['string','null'],'maxLength':2}"))));
        assertEquals(List.of("enum.out-of-enum"), labels(Partitions.invalidPartitions(json("{'enum':['a',null]}"))));
        assertEquals(List.of(), Partitions.invalidPartitions(json("{}")));
        misuse(() -> Partitions.invalidPartitions(json("{'$ref':'#/components/schemas/Order'}")), "resolve $ref");
        misuse(() -> Partitions.invalidPartitions(json("{'type':['string','integer']}")), "one field type is required");
        misuse(() -> Partitions.invalidPartitions(json("{'type':'string','pattern':'('}")), "not a valid regular expression");
        misuse(() -> Partitions.invalidPartitions(json("{'type':'string','minLength':-1}")), "minLength must be a non-negative integer");
        misuse(() -> Partitions.invalidPartitions(json("{'type':'file'}")), "unsupported type");
        misuse(() -> Partitions.invalidPartitions(null), "invalidPartitions: the schema must be a schema object");
    }

    @Test
    void partitions_every_value_violates_its_schema_and_a_valid_value_does_not() {
        record Case(String schema, JsonNode valid, BigDecimal numberStep) {}
        List<Case> cases = List.of(
                new Case("{'type':'string','format':'email','minLength':6,'maxLength':64}", MAPPER.getNodeFactory().textNode(Identity.validEmail(1)), null),
                new Case("{'type':'string','minLength':2,'maxLength':5,'pattern':'^[a-z]+$'}", json("'abc'"), null),
                new Case("{'type':'integer','minimum':1,'maximum':10}", json("5"), null),
                new Case("{'type':'integer','minimum':10,'maximum':50,'multipleOf':5}", json("25"), null),
                new Case("{'type':'integer','minimum':0}", json("3"), null),
                new Case("{'type':'number','minimum':0,'maximum':100,'multipleOf':0.01}", json("19.99"), null),
                new Case("{'type':'number','exclusiveMinimum':0,'exclusiveMaximum':1}", json("0.5"), dec("0.1")),
                new Case("{'type':'number','minimum':0.07,'maximum':0.7}", json("0.5"), dec("0.01")),
                new Case("{'type':'string','enum':['red','blue']}", json("'red'"), null),
                new Case("{'type':'boolean'}", json("true"), null));
        for (Case example : cases) {
            JsonNode schema = json(example.schema());
            assertTrue(valid(schema, example.valid()), "the valid example of " + example.schema());
            List<Partition> partitions = Partitions.invalidPartitions(schema, example.numberStep());
            assertFalse(partitions.isEmpty(), example.schema());
            for (Partition partition : partitions) {
                // 2^53 is a valid JSON Schema integer: number.unsafe-integer probes precision loss, not the schema.
                if (partition.label().equals("number.unsafe-integer")) continue;
                assertFalse(valid(schema, partition.value()), partition.label() + " must violate " + example.schema());
            }
        }
    }

    @Test
    void object_partitions_labels_in_schema_order_each_a_fresh_copy() {
        JsonNode validOrder = json(VALID_ORDER);
        List<Partition> partitions = Partitions.invalidObjectPartitions(json(ORDER_SCHEMA), validOrder);
        assertEquals(List.of(
                "object.missing-required.sku",
                "object.missing-required.qty",
                "object.extra-field",
                "object.null-body",
                "object.wrong-type-body",
                "field.sku.string.below-min-length",
                "field.sku.string.above-max-length",
                "field.sku.string.pattern-mismatch",
                "field.sku.string.empty",
                "field.sku.type.number-for-string",
                "field.sku.type.null-for-non-nullable",
                "field.qty.number.below-minimum",
                "field.qty.number.above-maximum",
                "field.qty.number.fractional-for-integer",
                "field.qty.type.string-for-number",
                "field.qty.type.null-for-non-nullable",
                "field.note.string.above-max-length",
                "field.note.type.number-for-string"), labels(partitions));
        assertEquals(json("{'qty':2,'note':null}"), valueOf(partitions, "object.missing-required.sku"));
        assertEquals(json("{'sku':'SKU-1','qty':2,'note':null,'argusUndocumentedField':'argus'}"), valueOf(partitions, "object.extra-field"));
        assertTrue(valueOf(partitions, "object.null-body").isNull());
        assertEquals(json("[" + VALID_ORDER + "]"), valueOf(partitions, "object.wrong-type-body"));
        assertEquals(json("{'sku':'SKU-1','qty':100,'note':null}"), valueOf(partitions, "field.qty.number.above-maximum"));
        assertEquals(json("{'sku':null,'qty':2,'note':null}"), valueOf(partitions, "field.sku.type.null-for-non-nullable"));
        assertEquals(json(VALID_ORDER), validOrder);
        Set<JsonNode> distinct = Collections.newSetFromMap(new IdentityHashMap<>());
        partitions.forEach(partition -> distinct.add(partition.value()));
        assertEquals(partitions.size(), distinct.size());
        // A schema that allows extra fields has no extra-field partition.
        ObjectNode open = (ObjectNode) json(ORDER_SCHEMA);
        open.put("additionalProperties", true);
        assertFalse(labels(Partitions.invalidObjectPartitions(open, validOrder)).contains("object.extra-field"));
        JsonNode priced = json("{'type':'object','properties':{'price':{'type':'number','minimum':0}}}");
        misuse(() -> Partitions.invalidObjectPartitions(priced, json("{'price':1}")), "property price: a bounded number field without multipleOf needs numberStep");
        assertTrue(labels(Partitions.invalidObjectPartitions(priced, json("{'price':1}"), null, Map.of("price", dec("0.01"))))
                .contains("field.price.number.below-minimum"));
        misuse(() -> Partitions.invalidObjectPartitions(json(ORDER_SCHEMA), json("{'qty':2}")), "lacks the required field sku");
        misuse(() -> Partitions.invalidObjectPartitions(json("{'type':'object','properties':{'owner':{'$ref':'#/components/schemas/User'}}}"), json("{}")),
                "property owner: resolve $ref");
        misuse(() -> Partitions.invalidObjectPartitions(json("{'type':'string'}"), json("{}")), "must describe an object");
    }

    @Test
    void object_partitions_a_correct_endpoint_rejects_all_of_them_a_faulty_one_is_red() {
        JsonNode schema = json(ORDER_SCHEMA);
        List<Partition> partitions = Partitions.invalidObjectPartitions(schema, json(VALID_ORDER));
        try (StubServer stub = StubServer.start(orderEndpoint(schema))) {
            Http.expectStatus(send("POST", stub.url() + "/orders", json(VALID_ORDER)), 201);
            for (Partition partition : partitions) Http.expectStatus(send("POST", stub.url() + "/orders", partition.value()), 400);
        }
        // The faulty endpoint forgot the sku maxLength and the qty maximum.
        ObjectNode lenient = (ObjectNode) json(ORDER_SCHEMA);
        ((ObjectNode) lenient.at("/properties/sku")).remove("maxLength");
        ((ObjectNode) lenient.at("/properties/qty")).remove("maximum");
        try (StubServer stub = StubServer.start(orderEndpoint(lenient))) {
            List<String> accepted = new ArrayList<>();
            for (Partition partition : partitions) {
                if (send("POST", stub.url() + "/orders", partition.value()).statusCode() != 400) accepted.add(partition.label());
            }
            assertEquals(List.of("field.sku.string.above-max-length", "field.qty.number.above-maximum"), accepted);
            JsonNode overLimit = valueOf(partitions, "field.qty.number.above-maximum");
            Response res = send("POST", stub.url() + "/orders", overLimit);
            red(() -> Http.expectStatus(res, 400), "expected HTTP 400, got 201");
        }
    }

    @Test
    void pagination_a_conserving_page_walk_is_green() {
        try (StubServer stub = pageStub(24)) {
            PaginationResult result = Pagination.paginateAll(pages(stub), Mode.PAGE, 5, Item::id);
            assertEquals(new PaginationResult(ids(1, 24), 24L, List.of(), List.of(), 5, true, List.of()), result);
            Pagination.assertCollectionConservation(result);
            assertEquals(10, stub.requests().size());
        }
        // An exact multiple of the page size ends on an empty page.
        try (StubServer stub = pageStub(20)) {
            PaginationResult result = Pagination.paginateAll(pages(stub), Mode.PAGE, 5, Item::id);
            assertEquals(5, result.pages());
            Pagination.assertCollectionConservation(result);
        }
    }

    @Test
    void pagination_a_page_boundary_that_repeats_an_item_is_red() {
        try (StubServer stub = pageStub(23, true, 0, false)) {
            PaginationResult result = Pagination.paginateAll(pages(stub), Mode.PAGE, 5, Item::id);
            assertEquals(List.of(5), result.duplicates());
            red(() -> Pagination.assertCollectionConservation(result), "1 id(s) served more than once: 5");
        }
    }

    @Test
    void pagination_a_total_that_drifts_from_the_items_is_red() {
        try (StubServer stub = pageStub(23, false, 1, false)) {
            PaginationResult result = Pagination.paginateAll(pages(stub), Mode.PAGE, 5, Item::id);
            assertEquals(List.of(), result.duplicates());
            red(() -> Pagination.assertCollectionConservation(result), "total 24 reported, 23 distinct ids served");
        }
    }

    @Test
    void pagination_an_ignored_page_parameter_stops_at_maxPages_and_is_red() {
        try (StubServer stub = pageStub(23, false, 0, true)) {
            PaginationResult result = Pagination.paginateAll(pages(stub), Mode.PAGE, 5, Item::id, 4, Pagination.DEFAULT_FIRST_PAGE);
            assertEquals(4, result.pages());
            assertFalse(result.consistent());
            red(() -> Pagination.assertCollectionConservation(result), "did not end within maxPages=4");
        }
    }

    @Test
    void pagination_a_stable_cursor_walk_is_green() {
        try (StubServer stub = cursorStub(12, null)) {
            PaginationResult result = Pagination.paginateAll(feed(stub), Mode.CURSOR, 5, Item::id);
            assertEquals(ids(1, 12), result.ids());
            assertNull(result.total());
            assertEquals(3, result.pages());
            Pagination.assertCollectionConservation(result);
        }
    }

    @Test
    void pagination_an_unstable_or_looping_cursor_walk_is_red() {
        try (StubServer stub = cursorStub(12, "unstable")) {
            PaginationResult result = Pagination.paginateAll(feed(stub), Mode.CURSOR, 5, Item::id);
            assertEquals(List.of(7), result.missing());
            red(() -> Pagination.assertCollectionConservation(result), "served in one walk only: 7");
        }
        try (StubServer stub = cursorStub(20, "cycle")) {
            PaginationResult result = Pagination.paginateAll(feed(stub), Mode.CURSOR, 5, Item::id);
            assertEquals(3, result.pages());
            red(() -> Pagination.assertCollectionConservation(result), "repeated an earlier cursor");
        }
    }

    @Test
    void pagination_usage_errors_are_illegal_arguments() {
        PageFetcher<Item> fetchPage = request -> new PageResult<>(List.of(new Item(1)), null, null);
        misuse(() -> Pagination.paginateAll(fetchPage, null, 5, Item::id), "mode");
        misuse(() -> Pagination.paginateAll(fetchPage, Mode.PAGE, 0, Item::id), "pageSize");
        misuse(() -> Pagination.paginateAll(fetchPage, Mode.PAGE, 5, item -> Map.of("id", item.id())), "idOf");
        misuse(() -> Pagination.paginateAll(request -> null, Mode.PAGE, 5, Item::id), "fetchPage");
        misuse(() -> Pagination.assertCollectionConservation(null), "pass the result of paginateAll");
    }

    @Test
    void boundary3_an_exact_validator_is_green_at_both_edges_of_a_range() {
        Probe accepts = value -> value.compareTo(BigDecimal.ONE) >= 0 && value.compareTo(BigDecimal.TEN) <= 0;
        BoundaryPoints upper = Boundary.boundary3(BigDecimal.TEN, BigDecimal.ONE, accepts, true, true, false);
        assertEquals(List.of(dec("9"), dec("10"), dec("11")), List.of(upper.below().value(), upper.at().value(), upper.above().value()));
        assertEquals(new BoundaryPoint(dec("11"), "rejected", "rejected"), upper.above());
        Boundary.boundary3(BigDecimal.ONE, BigDecimal.ONE, accepts, false, true, true);
    }

    @Test
    void boundary3_an_off_by_one_validator_is_red() {
        Probe offByOne = value -> value.compareTo(BigDecimal.ONE) >= 0 && value.compareTo(BigDecimal.TEN) < 0;
        red(() -> Boundary.boundary3(BigDecimal.TEN, BigDecimal.ONE, offByOne, true, true, false), "value 10 expected accepted, got rejected");
        Probe lenient = value -> value.compareTo(BigDecimal.ONE) >= 0;
        red(() -> Boundary.boundary3(BigDecimal.TEN, BigDecimal.ONE, lenient, true, true, false), "value 11 expected rejected, got accepted");
    }

    @Test
    void boundary3_a_money_step_probes_exact_cents_a_bad_step_throws() {
        List<BigDecimal> probed = new ArrayList<>();
        Probe probe = value -> {
            probed.add(value);
            return value.compareTo(dec("0.07")) <= 0;
        };
        Boundary.boundary3(dec("0.07"), dec("0.01"), probe, true, true, false);
        assertEquals(List.of(dec("0.06"), dec("0.07"), dec("0.08")), probed);
        // The floating-point path this avoids.
        assertNotEquals(0.06, 0.07 - 0.01);
        for (BigDecimal step : Arrays.asList(BigDecimal.ZERO, dec("-0.01"), null)) {
            misuse(() -> Boundary.boundary3(BigDecimal.ONE, step, probe, true, true, false), "step must be a number > 0");
        }
        misuse(() -> Boundary.boundary3(BigDecimal.ONE, BigDecimal.ONE, null, true, true, false), "probe");
        misuse(() -> Boundary.boundary3(null, BigDecimal.ONE, probe, true, true, false), "boundary");
    }

    @Test
    void moneyReconciles_exact_minor_units_are_green_penny_drift_is_red() {
        assertEquals(new MoneyReconciliation("0.08", "0.08"), Boundary.moneyReconciles(List.of("0.07", "0.01"), "0.08"));
        assertEquals(new MoneyReconciliation("15.00", "15.00"), Boundary.moneyReconciles(List.of(19.99, 0.01, "-5.00"), "15"));
        assertEquals(new MoneyReconciliation("350", "350"), Boundary.moneyReconciles(List.of("100", "250"), "350", 0));
        assertEquals(new MoneyReconciliation("1.50", "1.50"), Boundary.moneyReconciles(List.of("1.500"), "1.50"));
        assertEquals(new MoneyReconciliation("16.30", "16.30"), Boundary.moneyReconciles(List.of(dec("12.30"), 4L), dec("16.3")));
        red(() -> Boundary.moneyReconciles(List.of("33.33", "33.33", "33.33"), "100.00"), "the parts sum to 99.99, the total is 100.00 (difference -0.01)");
        // Floating-point money surfaces as sub-cent precision.
        red(() -> Boundary.moneyReconciles(List.of(0.1 + 0.2), "0.30"), "more than 2 decimal places");
        red(() -> Boundary.moneyReconciles(List.of("12,50"), "12.50"), "not a plain decimal");
        misuse(() -> Boundary.moneyReconciles(List.of("1"), "1", -1), "minorUnits");
        misuse(() -> Boundary.moneyReconciles(null, "1"), "parts must be a list");
        misuse(() -> Boundary.moneyReconciles(List.of(Map.of("amount", 1)), "1"), "must be a decimal string or a number");
    }

    @Test
    void percentagesSumTo100_an_exact_breakdown_is_green_a_rounded_one_is_red() {
        assertEquals("100.00", Boundary.percentagesSumTo100(List.of(33.33, 33.33, 33.34), 2));
        assertEquals("100", Boundary.percentagesSumTo100(List.of("50", "50")));
        red(() -> Boundary.percentagesSumTo100(List.of(33.33, 33.33, 33.33), 2), "sum to 99.99, not exactly 100");
        red(() -> Boundary.percentagesSumTo100(List.of(33.3, 33.3, 33.4)), "more than 0 decimal places");
        misuse(() -> Boundary.percentagesSumTo100(List.of()), "non-empty");
    }

    @Test
    void identity_the_vectors_carry_the_exact_code_points() {
        assertArrayEquals(new int[] {0x17B, 0xF3, 0x142, 0x107, 0x20, 0x104, 0x107, 0x119, 0x142, 0x144}, codePoints(Identity.IDENTITY_VECTORS.diacritics().get(0)));
        assertArrayEquals(new int[] {0x5A, 0x6F, 0xEB, 0x20, 0x53, 0x61, 0x6C, 0x64, 0x61, 0xF1, 0x61}, codePoints(Identity.IDENTITY_VECTORS.diacritics().get(1)));
        UnicodeEdge edge = Identity.IDENTITY_VECTORS.unicodeEdge();
        assertArrayEquals(new int[] {0xE9}, codePoints(edge.nfc()));
        assertArrayEquals(new int[] {0x65, 0x301}, codePoints(edge.nfd()));
        assertEquals(edge.nfd(), edge.combining());
        assertEquals(edge.nfc(), Normalizer.normalize(edge.nfd(), Normalizer.Form.NFC));
        assertArrayEquals(new int[] {0x202E, 0x61, 0x62, 0x63}, codePoints(edge.rtl()));
        assertArrayEquals(new int[] {0x61, 0x200B, 0x62}, codePoints(edge.zeroWidth()));
        assertTrue(Arrays.stream(codePoints(edge.emoji())).allMatch(point -> point > 0xFFFF));
        assertEquals(1025, edge.overlong().length());
        assertEquals(new Whitespace(" Argus", "Argus ", "Argus QA", "Argus\tQA", "   "), Identity.IDENTITY_VECTORS.whitespace());
        assertEquals("!@#$%^&*()\"'<>", Identity.IDENTITY_VECTORS.special());
        assertThrows(UnsupportedOperationException.class, () -> Identity.IDENTITY_VECTORS.diacritics().add("mutated"));
        assertThrows(UnsupportedOperationException.class, () -> Identity.INVALID_EMAILS.add(new InvalidEmail("x", "y")));
        assertEquals(5, Identity.INVALID_EMAILS.size());
        assertEquals("argus.qa+7@example.com", Identity.validEmail(7));
        assertEquals("argus.qa+run-42@example.com", Identity.validEmail("run-42"));
        misuse(() -> Identity.validEmail(-1), "seq");
        misuse(() -> Identity.validEmail("Run 1"), "seq");
        assertEquals(List.of("argus qa+1@example.com", "ARGUS QA+1@EXAMPLE.COM", "ArGuS qA+1@eXaMpLe.CoM"), Identity.caseVariants("Argus QA+1@Example.com"));
        assertFalse(new Credentials("argus.qa@example.com", "correct-horse").toString().contains("correct-horse"));
    }

    @Test
    void credentialConsistency_a_byte_exact_account_service_is_green() {
        try (StubServer stub = authStub(null)) {
            CredentialReport report = Identity.credentialConsistency(register(stub), login(stub));
            assertTrue(report.email().matches("argus\\.qa\\+[1-9][0-9]*@example\\.com"), report.email());
            assertEquals(List.of(
                    new CredentialCheck("byte-identical", "accepted", "accepted"),
                    new CredentialCheck("case-variant-email", "accepted", "accepted"),
                    new CredentialCheck("case-variant-password", "rejected", "rejected"),
                    new CredentialCheck("trailing-space-password", "rejected", "rejected")), report.checks());
            String registered = read(stub.requests().get(0).body()).path("password").asText();
            assertTrue(registered.endsWith(" "));
            assertTrue(Arrays.stream(new int[] {0x17B, 0xF3, 0x142, 0x107}).allMatch(point -> registered.codePoints().anyMatch(own -> own == point)));
        }
    }

    @Test
    void credentialConsistency_trimming_on_one_side_only_is_red() {
        for (AuthFault fault : List.of(AuthFault.TRIM_REGISTER, AuthFault.TRIM_LOGIN)) {
            try (StubServer stub = authStub(fault)) {
                String message = red(() -> Identity.credentialConsistency(register(stub), login(stub)), "byte-identical login expected accepted, got rejected");
                assertFalse(message.contains("Qa7"), "the failure leaked the password");
            }
        }
    }

    @Test
    void credentialConsistency_silent_trimming_case_folded_passwords_and_case_sensitive_emails_are_red() {
        Map<AuthFault, String> cases = Map.of(
                AuthFault.TRIM_BOTH, "trailing-space-password login expected rejected, got accepted",
                AuthFault.CASE_INSENSITIVE_PASSWORD, "case-variant-password login expected rejected, got accepted",
                AuthFault.CASE_SENSITIVE_EMAIL, "case-variant-email login expected accepted, got rejected");
        for (AuthFault fault : List.of(AuthFault.TRIM_BOTH, AuthFault.CASE_INSENSITIVE_PASSWORD, AuthFault.CASE_SENSITIVE_EMAIL)) {
            try (StubServer stub = authStub(fault)) {
                red(() -> Identity.credentialConsistency(register(stub), login(stub)), cases.get(fault));
            }
        }
        // A documented case-sensitive email contract turns the same service GREEN.
        try (StubServer stub = authStub(AuthFault.CASE_SENSITIVE_EMAIL)) {
            Identity.credentialConsistency(register(stub), login(stub), CredentialOptions.defaults().withEmailCaseInsensitive(false));
        }
    }

    @Test
    void credentialConsistency_usage_errors_are_illegal_arguments() {
        CredentialAttempt ok = credentials -> true;
        misuse(() -> Identity.credentialConsistency(ok, ok, CredentialOptions.defaults().withPassword("12345678")), "no cased letter");
        misuse(() -> Identity.credentialConsistency(null, ok), "register and login must not be null");
        misuse(() -> Identity.credentialConsistency(ok, ok, CredentialOptions.defaults().withEmail("")), "non-empty");
    }

    @Test
    void i18nCharset_a_character_exact_store_is_green() {
        assertEquals(List.of("diacritics.0", "diacritics.1", "emoji", "nfd"), I18n.I18N_VECTORS.stream().map(I18nVector::label).toList());
        try (StubServer stub = profileStub(value -> withinLimit(value) ? value : null)) {
            List<String> checked = I18n.i18nCharset(submit(stub), readBack(stub), PROFILE_MAX_LENGTH);
            assertEquals(List.of("diacritics.0", "diacritics.1", "emoji", "nfd", "max-length.20", "max-length.21"), checked);
            I18n.i18nCharset(submit(stub), readBack(stub));
        }
    }

    @Test
    void i18nCharset_a_byte_truncating_store_is_red() {
        // A column sized in bytes: the value keeps its first PROFILE_MAX_LENGTH UTF-8 bytes.
        UnaryOperator<String> truncate = value -> {
            if (!withinLimit(value)) return null;
            byte[] utf8 = value.getBytes(StandardCharsets.UTF_8);
            return new String(utf8, 0, Math.min(utf8.length, PROFILE_MAX_LENGTH), StandardCharsets.UTF_8);
        };
        try (StubServer stub = profileStub(truncate)) {
            red(() -> I18n.i18nCharset(submit(stub), readBack(stub), PROFILE_MAX_LENGTH),
                    "max-length.20: sent 20 code points (40 UTF-8 bytes): U+017C", "read back 10 code points");
        }
    }

    @Test
    void i18nCharset_normalization_stripped_emoji_and_byte_counted_limits_are_red() {
        List<Map.Entry<String, UnaryOperator<String>>> faults = List.of(
                Map.entry("nfd: sent 2 code points (3 UTF-8 bytes): U+0065 U+0301, read back 1 code points",
                        value -> withinLimit(value) ? Normalizer.normalize(value, Normalizer.Form.NFC) : null),
                Map.entry("emoji: sent 3 code points",
                        value -> withinLimit(value) ? value.codePoints().filter(point -> point <= 0xFFFF)
                                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append).toString() : null),
                Map.entry("max-length.20: refused 20 code points (40 UTF-8 bytes)",
                        value -> value.getBytes(StandardCharsets.UTF_8).length <= PROFILE_MAX_LENGTH ? value : null),
                Map.entry("accepted maxLength + 1 = 21 characters", value -> value));
        for (Map.Entry<String, UnaryOperator<String>> fault : faults) {
            try (StubServer stub = profileStub(fault.getValue())) {
                red(() -> I18n.i18nCharset(submit(stub), readBack(stub), PROFILE_MAX_LENGTH), fault.getKey());
            }
        }
    }

    @Test
    void i18nCharset_usage_errors_are_illegal_arguments() {
        I18n.Submit submit = value -> true;
        I18n.ReadBack readBack = () -> "";
        misuse(() -> I18n.i18nCharset(submit, readBack, 0), "maxLength");
        misuse(() -> I18n.i18nCharset(null, readBack), "submit and readBack must not be null");
        misuse(() -> I18n.i18nCharset(submit, () -> null), "readBack must return");
    }
}
