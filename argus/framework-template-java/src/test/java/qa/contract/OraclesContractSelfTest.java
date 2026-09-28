package qa.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.restassured.builder.ResponseBuilder;
import io.restassured.response.Response;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import qa.support.SchemaOracle;
import qa.support.argus.StubServer;
import qa.support.argus.StubServer.Exchange;
import qa.support.argus.StubServer.ExchangeRequest;
import qa.support.argus.StubServer.RecordedRequest;
import qa.support.argus.StubServer.StubResponse;
import qa.support.oracles.Http;
import qa.support.oracles.Http.RestState;
import qa.support.oracles.OpenApi;
import qa.support.oracles.OpenApi.Direction;
import qa.support.oracles.Replay;
import qa.support.oracles.Schema;
import qa.support.oracles.Schema.Options;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.function.LongSupplier;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Self-tests for the contract oracles, the Java port of oracles-contract.selftest.spec.ts over
 * the same openapi.selftest.json: every helper passes on a correct stub and fails on a faulty
 * one. Nothing contacts a real target; each stub binds 127.0.0.1 on an ephemeral port and
 * lives for one test. Negative cases assert the rejection itself, so a healthy run reports
 * {@code product pass} for every case.
 */
@Tag("contract-smoke")
class OraclesContractSelfTest {

    private static final OpenApi DOC = OpenApi.fromClasspath("openapi.selftest.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String SCHEMAS = "#/components/schemas/";
    private static final String BASE = SCHEMAS + "Base";
    private static final String WIDGET = SCHEMAS + "Widget";
    private static final String USER = SCHEMAS + "User";
    private static final String SECRET = "argus-never-print-me";
    private static final String WIDGET_BODY = "{\"id\":1,\"name\":\"widget\",\"color\":\"red\",\"weight\":2.5}";

    private static JsonNode json(String text) {
        try {
            return MAPPER.readTree(text.replace('\'', '"'));
        } catch (Exception e) {
            throw new IllegalArgumentException(e);
        }
    }

    private static void green(String body, String ref) {
        Schema.assertSchemaRef(DOC, json(body), ref, Options.STRICT);
    }

    /** Asserts a RED whose message contains {@code expected}. */
    private static String red(Executable call, String expected) {
        String message = assertThrows(AssertionError.class, call).getMessage();
        assertTrue(message.contains(expected), "expected '" + expected + "' in: " + message);
        return message;
    }

    private static String red(String body, String ref, String expected) {
        return red(() -> green(body, ref), expected);
    }

    private static Exchange exchange(String id, String method, String path, StubResponse response) {
        return new Exchange(id, new ExchangeRequest(method, path, Map.of()), response);
    }

    private static StubServer stub(StubServer.Handler handler, Exchange... exchanges) {
        StubServer stub = StubServer.start(handler);
        stub.load(Arrays.asList(exchanges));
        return stub;
    }

    private static Response record(int status, String body, String... header) {
        ResponseBuilder builder = new ResponseBuilder().setStatusCode(status).setStatusLine("HTTP/1.1 " + status);
        if (body != null) builder.setBody(body).setContentType("application/json");
        if (header.length == 2) builder.setHeader(header[0], header[1]);
        return builder.build();
    }

    @Test
    void strict_schema_an_undocumented_field_is_red() {
        green("{'id':1,'name':'widget'}", BASE);
        red("{'id':1,'name':'widget','surprise':true}", BASE, "surprise");
    }

    @Test
    void strict_schema_a_valid_allOf_body_is_green() {
        green(WIDGET_BODY, WIDGET);
        green("{'id':2,'name':'plain'}", WIDGET);
    }

    @Test
    void strict_schema_an_allOf_body_with_an_extra_field_is_red() {
        red("{'id':1,'name':'widget','color':'red','weight':2.5,'surprise':1}", WIDGET, "surprise");
    }

    @Test
    void strict_schema_a_oneOf_body_is_green_and_an_extra_field_in_it_is_red() {
        green("{'kind':'cat','meows':true}", SCHEMAS + "Pet");
        green("{'kind':'dog','barks':false}", SCHEMAS + "Pet");
        // Members are closed too, so a body of loose members matches exactly one of them.
        green("{'radius':2}", SCHEMAS + "Shape");
        assertThrows(AssertionError.class, () -> green("{'kind':'cat','meows':true,'barks':true}", SCHEMAS + "Pet"));
    }

    @Test
    void strict_schema_a_use_site_that_declares_patternProperties_stays_open() {
        green("{'name':'labels','x-trace':'abc','other':1}", SCHEMAS + "Labels");
        red("{'x-trace':5}", SCHEMAS + "Labels", "x-trace");
    }

    @Test
    void openapi_3_0_nullable_null_is_green_where_documented() {
        green("{'id':7,'email':'qa@example.com','nickname':null,'manager':null}", USER);
        green("{'id':7,'email':'qa@example.com','manager':{'id':1,'name':'lead'}}", USER);
        green("{'id':1,'name':'widget','color':null}", WIDGET);
        assertThrows(AssertionError.class, () -> green("{'id':1,'name':null}", BASE));
    }

    @Test
    void openapi_3_0_boolean_exclusiveMinimum_is_enforced() {
        green("{'id':1,'name':'widget','weight':0.5}", WIDGET);
        red("{'id':1,'name':'widget','weight':0}", WIDGET, "weight");
    }

    @Test
    void response_direction_a_writeOnly_field_in_a_response_is_red_and_redacted() {
        String leaked = "{'id':7,'email':'qa@example.com','password':'" + SECRET + "'}";
        String message = red(leaked, USER, "password");
        assertTrue(message.contains("[REDACTED]"), message);
        assertFalse(message.contains(SECRET), "the failure leaked a secret value");
        // The response direction drops the writeOnly property from required as well.
        green("{'id':7,'email':'qa@example.com'}", USER);
    }

    @Test
    void request_direction_readOnly_fields_are_removed() {
        Options request = Options.STRICT.withDirection(Direction.REQUEST);
        Schema.assertSchemaRef(DOC, json("{'email':'qa@example.com','password':'correct-horse'}"), USER, request);
        red(() -> Schema.assertSchemaRef(DOC, json("{'id':7,'email':'qa@example.com','password':'correct-horse'}"), USER, request), "'id'");
    }

    @Test
    void documented_additionalProperties_map_extra_keys_are_green() {
        green("{'widgets':3,'orders':0,'any key':12}", SCHEMAS + "Counters");
        red("{'widgets':'three'}", SCHEMAS + "Counters", "widgets");
    }

    @Test
    void array_of_objects_an_item_with_an_extra_field_is_red() {
        green("[{'id':1,'name':'a'},{'id':2,'name':'b'}]", SCHEMAS + "WidgetList");
        red("[{'id':1,'name':'a'},{'id':2,'name':'b','surprise':true}]", SCHEMAS + "WidgetList", "surprise");
    }

    @Test
    void nested_inline_object_an_extra_field_is_red() {
        green("{'id':1,'shipping':{'city':'Gdansk','zip':'80-001'}}", SCHEMAS + "Order");
        red("{'id':1,'shipping':{'city':'Gdansk','surprise':true}}", SCHEMAS + "Order", "shipping");
    }

    @Test
    void operation_lookup_an_undocumented_status_is_red() {
        try (StubServer stub = stub(null,
                exchange("widget-ok", "GET", "/widgets/1", new StubResponse(200, Map.of(), json(WIDGET_BODY))),
                exchange("widget-created", "GET", "/widgets/2", new StubResponse(201, Map.of(), json(WIDGET_BODY))))) {
            Schema.assertSchema(DOC, given().baseUri(stub.url()).get("/widgets/1"), "getWidget", Options.STRICT);
            Response created = given().baseUri(stub.url()).get("/widgets/2");
            red(() -> Schema.assertSchema(DOC, created, "getWidget", Options.STRICT), "HTTP 201 is not documented");
        }
        red(() -> Schema.assertSchema(DOC, 500, "{\"error\":\"boom\"}", "getWidget", Options.STRICT), "HTTP 500 is not documented");
    }

    @Test
    void operation_lookup_referenced_and_bodiless_responses() {
        Schema.assertSchema(DOC, 404, "{\"error\":\"no such user\"}", "getUser", Options.STRICT);
        red(() -> Schema.assertSchema(DOC, 404, "{\"error\":\"no such user\",\"trace\":\"x\"}", "getUser", Options.STRICT), "trace");
        Schema.assertSchema(DOC, 204, "", "deleteWidget", Options.STRICT);
        red(() -> Schema.assertSchema(DOC, 204, "{\"deleted\":true}", "deleteWidget", Options.STRICT), "documents no content");
        String misuse = assertThrows(IllegalArgumentException.class,
                () -> Schema.assertSchema(DOC, 200, "{}", "noSuchOperation", Options.STRICT)).getMessage();
        assertTrue(misuse.contains("not defined"), misuse);
    }

    @Test
    void operation_lookup_resolves_the_exact_code_then_its_range_then_default() {
        // 404 has its own key, so the 4XX schema's extra field is RED there.
        Schema.assertSchema(DOC, 404, "{\"error\":\"no such gadget\"}", "getGadget", Options.STRICT);
        red(() -> Schema.assertSchema(DOC, 404, "{\"error\":\"no such gadget\",\"fields\":[]}", "getGadget", Options.STRICT), "fields");
        // 422 falls under 4XX, which requires fields: the default Error body alone is RED.
        Schema.assertSchema(DOC, 422, "{\"error\":\"invalid\",\"fields\":[\"name\"]}", "getGadget", Options.STRICT);
        red(() -> Schema.assertSchema(DOC, 422, "{\"error\":\"invalid\"}", "getGadget", Options.STRICT), "HTTP 422 via 4XX");
        // 500 falls under default.
        Schema.assertSchema(DOC, 500, "{\"error\":\"boom\"}", "getGadget", Options.STRICT);
        red(() -> Schema.assertSchema(DOC, 500, "{\"error\":\"boom\",\"trace\":\"x\"}", "getGadget", Options.STRICT), "HTTP 500 via default");
    }

    @Test
    void strict_false_with_a_reason_is_green_without_a_reason_it_throws() {
        String drifted = "{\"id\":1,\"name\":\"widget\",\"legacyField\":true}";
        Schema.assertSchema(DOC, 200, drifted, "getWidget", Options.lenient("legacyField is a recorded, accepted drift"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> new Options(false, null)).getMessage().contains("reason"));
        assertThrows(IllegalArgumentException.class, () -> Options.lenient("  "));
        red(() -> Schema.assertSchema(DOC, 200, drifted, "getWidget", Options.STRICT), "legacyField");
    }

    @Test
    void assertSchemaStrict_and_the_schema_oracle_matcher_are_strict() {
        red(() -> Schema.assertSchemaStrict(DOC, "{\"id\":1,\"name\":\"widget\",\"surprise\":1}", BASE), "surprise");
        red(() -> Schema.assertSchemaStrict(DOC, "{\"id\":1,\"name\":\"widget\"} trailing", BASE), "not JSON");
        try (StubServer stub = stub(null,
                exchange("plain", "GET", "/plain", StubResponse.json(200, Map.of("id", 1, "name", "widget"))),
                exchange("drift", "GET", "/drift", StubResponse.json(200, Map.of("id", 1, "name", "widget", "surprise", 1))))) {
            given().baseUri(stub.url()).get("/plain").then().body(SchemaOracle.matchesSchema(DOC, BASE));
            Response drift = given().baseUri(stub.url()).get("/drift");
            red(() -> drift.then().body(SchemaOracle.matchesSchema(DOC, BASE)), "surprise");
        }
    }

    @Test
    void normalize_component_roots_and_allOf_members_stay_open_use_sites_close() {
        String defs = "#/$defs/";
        assertEquals(json("{'allOf':[{'$ref':'" + defs + "Widget'}],'unevaluatedProperties':false}"),
                DOC.normalize(json("{'$ref':'" + WIDGET + "'}"), Direction.RESPONSE, true));
        // A use site whose target declares additionalProperties is left as the author wrote it.
        assertEquals(json("{'$ref':'" + defs + "Counters'}"), DOC.normalize(json("{'$ref':'" + SCHEMAS + "Counters'}"), Direction.RESPONSE, true));
        ObjectNode response = DOC.schemas(Direction.RESPONSE, true);
        assertFalse(response.get("Base").has("unevaluatedProperties"));
        assertEquals(json("{'allOf':[{'$ref':'" + defs + "Base'},{'$ref':'" + defs + "Ext'}]}"), response.get("Widget"));
        assertEquals(json("{'allOf':[{'type':'string'}],'unevaluatedProperties':false}"), response.at("/Base/properties/name"));
        assertFalse(response.at("/Order/properties/shipping/unevaluatedProperties").asBoolean(true));
        assertEquals(json("{'type':'object','additionalProperties':{'allOf':[{'type':'integer'}],'unevaluatedProperties':false}}"), response.get("Counters"));
        assertEquals(json("{'type':'number','exclusiveMinimum':0}"), response.at("/Ext/properties/weight/allOf/0"));
        assertEquals(json("{'type':['string','null'],'enum':['red','blue',null]}"), response.at("/Ext/properties/color/allOf/0"));
        assertFalse(response.at("/User/properties").has("password"));
        assertEquals(json("['id','email']"), response.at("/User/required"));
        assertEquals(json("{'type':['string','null']}"), response.at("/User/properties/nickname/allOf/0"));
        assertTrue(response.at("/User/properties/manager").toString().contains("\"anyOf\""));
        ObjectNode request = DOC.schemas(Direction.REQUEST, false);
        assertEquals(json("['email','password']"), request.at("/User/required"));
        assertFalse(request.at("/User/properties").has("id"));
        assertEquals(json("{'type':'string'}"), request.at("/Base/properties/name"));
        assertEquals(json("['id','email','password']"), DOC.document().at("/components/schemas/User/required"));
    }

    @Test
    void expectStatus_compares_one_exact_status_code() {
        StubResponse created = StubResponse.json(201, Map.of("id", 9, "token", SECRET)).withHeader("location", "/widgets/9");
        try (StubServer stub = stub(null, exchange("create", "POST", "/widgets", created))) {
            Response res = given().baseUri(stub.url()).body("{\"name\":\"widget\"}").post("/widgets");
            Http.expectStatus(res, 201);
            String message = red(() -> Http.expectStatus(res, 200), "expected HTTP 200, got 201");
            assertTrue(message.contains("[REDACTED]"), message);
            assertFalse(message.contains(SECRET), "the failure leaked a secret value");
            assertThrows(IllegalArgumentException.class, () -> Http.expectStatus(res, 2));
        }
        String text = Http.excerpt("Authorization: Bearer abc123\npassword=hunter2&user=u");
        assertFalse(text.contains("abc123") || text.contains("hunter2"), text);
        assertTrue(Http.excerpt("x".repeat(900)).length() <= 500);
    }

    @Test
    void assertRestStatus_every_state_is_green_on_a_conforming_stub() {
        assertEquals(10, RestState.values().length);
        Map<RestState, String> methods = Map.of(RestState.CREATED, "POST", RestState.DELETED, "DELETE",
                RestState.METHOD_NOT_ALLOWED, "PATCH", RestState.UNSUPPORTED_MEDIA_TYPE, "PUT", RestState.MALFORMED, "POST",
                RestState.CONFLICT, "PUT");
        List<Exchange> exchanges = new ArrayList<>();
        for (RestState state : RestState.values()) {
            StubResponse response = switch (state) {
                case CREATED -> StubResponse.json(201, Map.of("id", 9)).withHeader("location", "/widgets/9");
                case DELETED -> StubResponse.status(204);
                case MISSING -> StubResponse.json(404, Map.of("error", "missing"));
                case METHOD_NOT_ALLOWED -> StubResponse.status(405).withHeader("allow", "GET, DELETE");
                case MALFORMED -> StubResponse.json(400, Map.of("error", "malformed"));
                case OK -> StubResponse.json(200, Map.of("id", 1));
                default -> StubResponse.status(state.status());
            };
            exchanges.add(exchange(state.label(), methods.getOrDefault(state, "GET"), "/rest/" + state.label(), response));
        }
        try (StubServer stub = stub(null, exchanges.toArray(Exchange[]::new))) {
            for (RestState state : RestState.values()) {
                Response res = given().baseUri(stub.url()).request(methods.getOrDefault(state, "GET"), "/rest/" + state.label());
                Http.assertRestStatus(res, state);
                assertEquals(state, RestState.of(state.label()));
            }
            assertEquals(List.of(), stub.unmatched());
        }
    }

    @Test
    void http_201_uses_target_uri_when_location_is_absent() {
        try (StubServer stub = stub(null,
                exchange("created-at-target", "PUT", "/widgets/9", StubResponse.json(201, Map.of("id", 9))))) {
            Http.assertRestStatus(given().baseUri(stub.url()).put("/widgets/9"), RestState.CREATED);
        }
        Http.assertRestStatus(record(201, "{\"id\":9}"), RestState.CREATED, 201);
        Http.assertRestStatus(record(201, null, "Location", "/widgets/9"), RestState.CREATED, null, true);
        red(() -> Http.assertRestStatus(record(200, null, "Content-Type", "application/json"), RestState.CREATED, 200, true), "API contract requires a non-empty Location");
    }

    @Test
    void explicit_json_null_is_content_in_response_records() {
        red(() -> Schema.assertSchema(DOC, 204, "null", "deleteWidget", Options.STRICT), "documents no content");
        red(() -> Http.assertRestStatus(record(204, "null"), RestState.DELETED), "non-empty body");
        Schema.assertSchema(DOC, 204, "", "deleteWidget", Options.STRICT);
        Http.assertRestStatus(record(204, ""), RestState.DELETED);
    }

    @Test
    void assertRestStatus_a_wrong_code_or_a_missing_location_allow_or_empty_body_is_red() {
        try (StubServer stub = stub(null,
                exchange("no-location", "POST", "/no-location", StubResponse.json(201, Map.of("id", 1))),
                exchange("no-allow", "PATCH", "/no-allow", StubResponse.status(405)),
                exchange("gone", "GET", "/gone", StubResponse.status(410)),
                exchange("no-content", "GET", "/no-content", StubResponse.status(204)))) {
            String url = stub.url();
            red(() -> Http.assertRestStatus(given().baseUri(url).post("/no-location"), RestState.CREATED, null, true), "Location");
            red(() -> Http.assertRestStatus(given().baseUri(url).patch("/no-allow"), RestState.METHOD_NOT_ALLOWED), "Allow");
            red(() -> Http.assertRestStatus(given().baseUri(url).get("/gone"), RestState.MISSING), "expected HTTP 404, got 410");
            red(() -> Http.assertRestStatus(given().baseUri(url).get("/no-content"), RestState.OK), "expected HTTP 200, got 204");
        }
        // HTTP drops content on a 204, so a body can only be shown through a built response.
        red(() -> Http.assertRestStatus(record(204, "{\"deleted\":true}"), RestState.DELETED), "non-empty body");
        red(() -> Http.assertRestStatus(record(201, null, "Location", " "), RestState.CREATED, null, true), "Location");
        assertThrows(IllegalArgumentException.class, () -> RestState.of("fine"));
    }

    @Test
    void assertRestStatus_documentedStatus_overrides_the_code_never_a_class() {
        Http.assertRestStatus(record(200, "{\"id\":9}"), RestState.CREATED, 200);
        red(() -> Http.assertRestStatus(record(201, null, "Location", "/x/9"), RestState.CREATED, 200), "expected HTTP 200, got 201");
        Http.assertRestStatus(record(422, null), RestState.MALFORMED, 422);
        String misuse = assertThrows(IllegalArgumentException.class, () -> Http.assertRestStatus(record(400, null), RestState.MALFORMED, 4)).getMessage();
        assertTrue(misuse.contains("never a class"), misuse);
    }

    @Test
    void idempotentReplay_is_green_on_a_deterministic_stub() {
        AtomicInteger requestId = new AtomicInteger();
        StubServer.Handler handler = request -> switch (request.method() + " " + request.path()) {
            case "PUT /widgets/1" -> StubResponse.json(200, Map.of("id", 1, "name", "widget", "meta", Map.of("requestId", requestId.incrementAndGet())));
            case "GET /widgets/1" -> StubResponse.json(200, Map.of("id", 1, "name", "widget"));
            default -> null;
        };
        try (StubServer stub = stub(handler)) {
            Response first = Replay.idempotentReplay(() -> given().baseUri(stub.url()).body("{\"name\":\"widget\"}").put("/widgets/1"),
                    () -> given().baseUri(stub.url()).get("/widgets/1").asString(), "requestId");
            assertEquals(200, first.statusCode());
            assertEquals(2, requestId.get());
        }
    }

    @Test
    void idempotentReplay_is_red_on_a_counter_stub() {
        AtomicInteger version = new AtomicInteger();
        AtomicInteger visits = new AtomicInteger();
        StubServer.Handler handler = request -> switch (request.method() + " " + request.path()) {
            case "PUT /widgets/1" -> StubResponse.json(200, Map.of("id", 1, "version", version.incrementAndGet()));
            case "POST /visits" -> {
                visits.incrementAndGet();
                yield StubResponse.status(204);
            }
            case "GET /visits" -> StubResponse.json(200, Map.of("total", visits.get()));
            default -> null;
        };
        try (StubServer stub = stub(handler)) {
            red(() -> Replay.idempotentReplay(() -> given().baseUri(stub.url()).put("/widgets/1")), "changed the body");
            // Identical responses, but the state keeps counting.
            red(() -> Replay.idempotentReplay(() -> given().baseUri(stub.url()).post("/visits"),
                    () -> given().baseUri(stub.url()).get("/visits")), "changed the state");
        }
    }

    /** POST /orders creates an order; with {@code honourKeys} a repeated idempotency key replays the first one. */
    private static StubServer orderStub(boolean honourKeys) {
        List<Integer> orders = new ArrayList<>();
        Map<String, Integer> byKey = new HashMap<>();
        return StubServer.start(request -> {
            synchronized (orders) {
                if ("POST".equals(request.method()) && "/orders".equals(request.path())) {
                    String key = request.headers().get("idempotency-key");
                    if (honourKeys && key != null && byKey.containsKey(key)) return StubResponse.json(200, Map.of("id", byKey.get(key)));
                    int id = orders.size() + 1;
                    orders.add(id);
                    if (key != null) byKey.put(key, id);
                    return StubResponse.json(201, Map.of("id", id)).withHeader("location", "/orders/" + id);
                }
                if ("GET".equals(request.method()) && "/orders/count".equals(request.path())) return StubResponse.json(200, Map.of("count", orders.size()));
                return null;
            }
        });
    }

    @Test
    void replayWithIdempotencyKey_is_green_when_the_key_deduplicates_the_create() {
        try (StubServer stub = orderStub(true)) {
            LongSupplier count = () -> given().baseUri(stub.url()).get("/orders/count").<Integer>path("count");
            Function<Response, Object> idOf = res -> res.path("id");
            Replay.KeyedReplay result = Replay.replayWithIdempotencyKey(
                    key -> given().baseUri(stub.url()).header("Idempotency-Key", key).body("{\"sku\":\"A-1\"}").post("/orders"), count, idOf);
            assertTrue(result.key().matches("argus-idem-[1-9][0-9]*"), result.key());
            assertEquals(1, result.id());
            List<String> keys = stub.requests().stream().filter(r -> "POST".equals(r.method())).map(r -> r.headers().get("idempotency-key")).toList();
            assertEquals(List.of(result.key(), result.key()), keys);
        }
    }

    @Test
    void replayWithIdempotencyKey_is_red_when_the_key_is_ignored() {
        try (StubServer stub = orderStub(false)) {
            red(() -> Replay.replayWithIdempotencyKey(
                    key -> given().baseUri(stub.url()).header("Idempotency-Key", key).body("{\"sku\":\"A-1\"}").post("/orders"),
                    () -> given().baseUri(stub.url()).get("/orders/count").<Integer>path("count"), res -> res.path("id")), "exactly one effect");
        }
    }

    @Test
    void stub_an_unmatched_request_gets_501_and_is_recorded() {
        Exchange pageTwo = new Exchange("page-two", new ExchangeRequest("GET", "/widgets", Map.of("page", "2")), StubResponse.json(200, List.of()));
        try (StubServer stub = stub(null, exchange("widget", "GET", "/widgets/1", StubResponse.json(200, Map.of("id", 1, "name", "widget"))), pageTwo)) {
            Response hit = given().baseUri(stub.url()).get("/widgets/1");
            Http.expectStatus(hit, 200);
            assertEquals("application/json", hit.getHeader("content-type"));
            assertEquals(json("{'id':1,'name':'widget'}"), json(hit.asString()));
            Http.expectStatus(given().baseUri(stub.url()).get("/widgets?page=2&sort=name"), 200);
            Response miss = given().baseUri(stub.url()).get("/widgets?page=3");
            Http.expectStatus(miss, 501);
            assertEquals(json("{'argusStub':'unmatched'}"), json(miss.asString()));
            Http.expectStatus(given().baseUri(stub.url()).post("/widgets/1"), 501);
            assertEquals(List.of("GET /widgets", "POST /widgets/1"), stub.unmatched().stream().map(r -> r.method() + " " + r.path()).toList());
            assertEquals(Arrays.asList("widget", "page-two", null, null), stub.requests().stream().map(RecordedRequest::matched).toList());
            stub.load(List.of());
            assertEquals(List.of(), stub.requests());
        }
    }

    @Test
    void stub_resolve_serves_exchanges_without_the_network_a_failing_handler_answers_500() {
        StubServer.Handler handler = request -> {
            if ("/explode".equals(request.path())) throw new IllegalStateException("handler failure on purpose");
            return null;
        };
        Exchange pageTwo = new Exchange("page-two", new ExchangeRequest("GET", "/widgets", Map.of("page", "2")), StubResponse.json(200, List.of()));
        try (StubServer stub = stub(handler, exchange("widget", "GET", "/widgets/1", StubResponse.json(200, Map.of("id", 1))), pageTwo)) {
            assertEquals(StubResponse.json(200, Map.of("id", 1)), stub.resolve("GET", "/widgets/1", null));
            assertEquals(StubResponse.json(200, List.of()), stub.resolve("get", "/widgets?page=2", null));
            assertNull(stub.resolve("GET", "/widgets", Map.of("page", "3")));
            assertEquals(List.of("/widgets"), stub.unmatched().stream().map(RecordedRequest::path).toList());
            Response exploded = given().baseUri(stub.url()).get("/explode");
            Http.expectStatus(exploded, 500);
            assertEquals(json("{'argusStub':'handler-error'}"), json(exploded.asString()));
            List<RecordedRequest> log = stub.requests();
            assertEquals("handler-error", log.get(log.size() - 1).matched());
        }
    }

    @Test
    void stub_invalid_exchanges_are_refused() {
        Exchange valid = exchange("ok", "GET", "/ok", StubResponse.status(200));
        try (StubServer stub = StubServer.start()) {
            Map<String, List<Exchange>> cases = new LinkedHashMap<>();
            cases.put("invalid stub exchange id", List.of(exchange("Not Valid", "GET", "/ok", StubResponse.status(200))));
            cases.put("duplicate", List.of(valid, valid));
            cases.put("uppercase", List.of(exchange("ok", "get", "/ok", StubResponse.status(200))));
            cases.put("start with", List.of(exchange("ok", "GET", "ok", StubResponse.status(200))));
            cases.put("lowercase", List.of(exchange("ok", "GET", "/ok", new StubResponse(200, Map.of("Content-Type", "text/plain"), null))));
            cases.put("status", List.of(exchange("ok", "GET", "/ok", StubResponse.status(42))));
            cases.forEach((expected, exchanges) -> {
                String message = assertThrows(IllegalArgumentException.class, () -> stub.load(exchanges)).getMessage();
                assertTrue(message.contains(expected), "expected '" + expected + "' in: " + message);
            });
        }
    }
}
