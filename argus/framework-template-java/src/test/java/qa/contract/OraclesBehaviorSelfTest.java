package qa.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.restassured.response.Response;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import qa.support.argus.StubServer;
import qa.support.argus.StubServer.StubResponse;
import qa.support.oracles.Concurrency;
import qa.support.oracles.Concurrency.DoubleSubmitResult;
import qa.support.oracles.Concurrency.RaceResult;
import qa.support.oracles.Http.RestState;
import qa.support.oracles.Scaling;
import qa.support.oracles.Scaling.Measurement;
import qa.support.oracles.Scaling.Sample;
import qa.support.oracles.Scaling.ScalingAnalysis;
import qa.support.oracles.Scaling.SizeMedian;
import qa.support.oracles.Scaling.Timed;
import qa.support.oracles.State;
import qa.support.oracles.State.IdList;
import qa.support.oracles.State.SweepReport;
import qa.support.oracles.Visual;
import qa.support.oracles.Visual.Bounds;
import qa.support.oracles.Visual.Rect;
import qa.support.oracles.Visual.Viewport;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Self-tests for the behaviour oracles, the Java port of oracles-behavior.selftest.spec.ts:
 * evaluateBounds and analyzeScaling as pure functions, n1Scaling over in-memory
 * measurements, and softDeleteSweep, doubleSubmit and concurrentRace against 127.0.0.1 stubs
 * that each live for one test: a soft delete that still lists the id, a double submit that
 * creates two effects, and a race that overbooks are RED; their correct twins are GREEN. No
 * browser starts and nothing contacts a real target. Negative cases assert the rejection
 * itself (a RED through {@code assertThrows(AssertionError.class, ...)}, misuse through
 * {@code IllegalArgumentException}), so a healthy run reports {@code product pass} for every
 * case.
 */
@Tag("contract-smoke")
class OraclesBehaviorSelfTest {

    /** What a faulty user service leaves behind after deleting user 2. */
    private enum Leftover { NONE, READABLE, TEAM_LISTED, CAN_LOG_IN, DELETE_ANSWERS_200 }

    private enum SeatFault { NONE, OVERBOOK, SERVER_ERROR_ON_THIRD }

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int DELETED_USER = 2;
    private static final int RACERS = 5;

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

    private static Response send(String method, String url, Object value) {
        try {
            return given().baseUri(url).contentType("application/json; charset=utf-8").body(MAPPER.writeValueAsBytes(value)).request(method);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Asserts a RED whose message contains every {@code expected} fragment. */
    private static String red(Executable call, String... expected) {
        String message = assertThrows(AssertionError.class, call).getMessage();
        for (String fragment : expected) assertTrue(message.contains(fragment), "expected '" + fragment + "' in: " + message);
        return message;
    }

    /** Asserts a usage error whose message contains {@code expected}. */
    private static void misuse(Executable call, String expected) {
        String message = assertThrows(IllegalArgumentException.class, call).getMessage();
        assertTrue(message.contains(expected), "expected '" + expected + "' in: " + message);
    }

    private static StubResponse items(Collection<Integer> ids) {
        return StubResponse.json(200, Map.of("items", new TreeSet<>(ids).stream().map(id -> Map.of("id", id)).toList()));
    }

    /**
     * Users 1-3 with GET /users, GET /teams/1/members, GET /users/{id}, DELETE /users/{id} and
     * POST /login {userId}. A correct service removes a deleted user everywhere; each fault
     * leaves one trace.
     */
    private static StubServer userStub(Leftover fault) {
        Set<Integer> live = ConcurrentHashMap.newKeySet();
        live.addAll(List.of(1, 2, 3));
        Set<Integer> deleted = ConcurrentHashMap.newKeySet();
        return StubServer.start(request -> {
            String path = request.path();
            if ("POST".equals(request.method()) && "/login".equals(path)) {
                int id = read(request.body()).path("userId").asInt();
                boolean allowed = live.contains(id) || (fault == Leftover.CAN_LOG_IN && deleted.contains(id));
                return StubResponse.json(allowed ? 200 : 401, Map.of());
            }
            if ("DELETE".equals(request.method()) && path.startsWith("/users/")) {
                int id = Integer.parseInt(path.substring("/users/".length()));
                if (!live.remove(id)) return StubResponse.json(404, Map.of("error", "no such user"));
                deleted.add(id);
                return fault == Leftover.DELETE_ANSWERS_200 ? StubResponse.json(200, Map.of("deleted", id)) : StubResponse.status(204);
            }
            if (!"GET".equals(request.method())) return null;
            if ("/users".equals(path)) return items(live);
            if ("/teams/1/members".equals(path)) {
                Set<Integer> members = new TreeSet<>(live);
                if (fault == Leftover.TEAM_LISTED) members.addAll(deleted);
                return items(members);
            }
            if (path.startsWith("/users/")) {
                int id = Integer.parseInt(path.substring("/users/".length()));
                boolean readable = live.contains(id) || (fault == Leftover.READABLE && deleted.contains(id));
                return readable ? StubResponse.json(200, Map.of("id", id)) : StubResponse.json(404, Map.of("error", "no such user"));
            }
            return null;
        });
    }

    private static List<Object> ids(StubServer stub, String path) {
        List<Object> ids = new ArrayList<>();
        read(given().baseUri(stub.url()).get(path).asByteArray()).path("items").forEach(item -> ids.add(item.path("id").asInt()));
        return ids;
    }

    private static List<IdList> lists(StubServer stub) {
        return List.of(() -> ids(stub, "/users"), () -> ids(stub, "/teams/1/members"));
    }

    private static SweepReport sweep(StubServer stub, Object id, boolean withLogin, RestState deleteState) {
        Supplier<Response> login = withLogin ? () -> send("POST", stub.url() + "/login", Map.of("userId", DELETED_USER)) : null;
        return State.softDeleteSweep(id,
                () -> given().baseUri(stub.url()).delete("/users/" + DELETED_USER),
                () -> given().baseUri(stub.url()).get("/users/" + DELETED_USER),
                lists(stub), login, deleteState);
    }

    /**
     * POST /orders {cart} and GET /orders/count. A correct service creates one order per cart
     * and answers a repeat with 409; a faulty one creates an order for every submission.
     */
    private static StubServer orderStub(boolean dedupe) {
        Set<String> carts = ConcurrentHashMap.newKeySet();
        AtomicInteger created = new AtomicInteger();
        return StubServer.start(request -> {
            if ("GET".equals(request.method()) && "/orders/count".equals(request.path())) return StubResponse.json(200, Map.of("count", created.get()));
            if (!"POST".equals(request.method()) || !"/orders".equals(request.path())) return null;
            boolean first = carts.add(read(request.body()).path("cart").asText());
            if (dedupe && !first) return StubResponse.json(409, Map.of("error", "already submitted"));
            return StubResponse.json(201, Map.of("id", created.incrementAndGet()));
        });
    }

    private static long orderCount(StubServer stub) {
        return read(given().baseUri(stub.url()).get("/orders/count").asByteArray()).path("count").asLong();
    }

    /**
     * POST /seats/7/book and GET /seats/7 over {@code capacity} seats. A correct service books
     * atomically and answers 409 once the seats are gone. OVERBOOK checks the remaining seats,
     * waits until every racer has checked, then books (check-then-act); SERVER_ERROR_ON_THIRD
     * answers the third booking with 500.
     */
    private static StubServer seatStub(int capacity, SeatFault fault) {
        AtomicInteger remaining = new AtomicInteger(capacity);
        AtomicInteger hits = new AtomicInteger();
        CountDownLatch checked = new CountDownLatch(RACERS);
        return StubServer.start(request -> {
            if ("GET".equals(request.method()) && "/seats/7".equals(request.path())) return StubResponse.json(200, Map.of("remaining", remaining.get()));
            if (!"POST".equals(request.method()) || !"/seats/7/book".equals(request.path())) return null;
            if (fault == SeatFault.SERVER_ERROR_ON_THIRD && hits.incrementAndGet() == 3) return StubResponse.json(500, Map.of("error", "internal"));
            if (fault == SeatFault.OVERBOOK) {
                int seen = remaining.get();
                checked.countDown();
                checked.await(10, TimeUnit.SECONDS);
                if (seen <= 0) return StubResponse.json(409, Map.of("error", "sold out"));
                remaining.decrementAndGet();
                return StubResponse.json(201, Map.of("seat", 7));
            }
            boolean booked = remaining.getAndUpdate(left -> left > 0 ? left - 1 : left) > 0;
            return booked ? StubResponse.json(201, Map.of("seat", 7)) : StubResponse.json(409, Map.of("error", "sold out"));
        });
    }

    private static int remainingSeats(StubServer stub) {
        return read(given().baseUri(stub.url()).get("/seats/7").asByteArray()).path("remaining").asInt();
    }

    private static Concurrency.RaceCall book(StubServer stub) {
        return index -> send("POST", stub.url() + "/seats/7/book", Map.of("racer", index));
    }

    private static long count(List<Integer> statuses, int status) {
        return statuses.stream().filter(value -> value == status).count();
    }

    private static Bounds bounds(double x, double y, double width, double scrollWidth, boolean topElementIsSelf) {
        return new Bounds(new Rect(x, y, width, 40), new Viewport(375, 667), scrollWidth, 375, topElementIsSelf);
    }

    private static List<Sample> samples(int size, double... ms) {
        List<Sample> out = new ArrayList<>();
        for (double value : ms) out.add(new Sample(size, value, 1000));
        return out;
    }

    private static List<Sample> concat(List<Sample> first, List<Sample> second) {
        List<Sample> out = new ArrayList<>(first);
        out.addAll(second);
        return out;
    }

    @Test
    void softDeleteSweep_passes_when_the_resource_is_gone_everywhere() {
        try (StubServer stub = userStub(Leftover.NONE)) {
            SweepReport report = sweep(stub, DELETED_USER, true, RestState.DELETED);
            assertEquals(new SweepReport(DELETED_USER, 204, 404, 2, 401), report);
            assertEquals(List.of(1, 3), ids(stub, "/teams/1/members"));
        }
    }

    @Test
    void softDeleteSweep_fails_when_a_list_still_serves_the_id() {
        try (StubServer stub = userStub(Leftover.TEAM_LISTED)) {
            String message = red(() -> sweep(stub, DELETED_USER, true, RestState.DELETED), "the resource survived its delete", "list 2: still serves the deleted id");
            assertFalse(message.contains("list 1"), message);
            assertFalse(message.contains("read-back"), message);
        }
        // A string id still matches a numeric listing: a type mismatch never hides a leftover.
        try (StubServer stub = userStub(Leftover.TEAM_LISTED)) {
            red(() -> sweep(stub, "2", false, RestState.DELETED), "list 2: still serves the deleted id");
        }
    }

    @Test
    void softDeleteSweep_fails_on_a_readable_resource_a_live_login_or_the_wrong_delete_status() {
        try (StubServer stub = userStub(Leftover.READABLE)) {
            red(() -> sweep(stub, DELETED_USER, false, RestState.DELETED), "read-back: missing: expected HTTP 404, got 200");
        }
        try (StubServer stub = userStub(Leftover.CAN_LOG_IN)) {
            red(() -> sweep(stub, DELETED_USER, true, RestState.DELETED), "login: unauthenticated: expected HTTP 401, got 200");
        }
        // The documented delete state decides the status: 200 is RED against the default 204 and GREEN when documented.
        try (StubServer stub = userStub(Leftover.DELETE_ANSWERS_200)) {
            red(() -> sweep(stub, DELETED_USER, true, RestState.DELETED), "delete: deleted: expected HTTP 204, got 200");
        }
        try (StubServer stub = userStub(Leftover.DELETE_ANSWERS_200)) {
            assertEquals(200, sweep(stub, DELETED_USER, true, RestState.OK).deleteStatus());
        }
    }

    @Test
    void softDeleteSweep_rejects_misuse() {
        Supplier<Response> never = () -> {
            throw new IllegalStateException("must not be called");
        };
        List<IdList> none = List.of(() -> List.of());
        misuse(() -> State.softDeleteSweep(null, never, never, none), "id");
        misuse(() -> State.softDeleteSweep(7, null, never, none), "deleteResource and getById");
        misuse(() -> State.softDeleteSweep(7, never, never, List.of()), "listIds");
        misuse(() -> State.softDeleteSweep(7, never, never, none, null, null), "expectedDeleteState");
        misuse(() -> State.softDeleteSweep(List.of(7), never, never, none), "string or a number");
        misuse(() -> State.softDeleteSweep(7, () -> null, never, none), "deleteResource returned null");
    }

    @Test
    void doubleSubmit_passes_when_a_repeated_submission_creates_one_effect() {
        try (StubServer stub = orderStub(true)) {
            DoubleSubmitResult<Response> result = Concurrency.doubleSubmit(() -> send("POST", stub.url() + "/orders", Map.of("cart", "cart-1")),
                    () -> orderCount(stub));
            assertEquals(1, result.delta());
            assertEquals(List.of(201, 409), result.results().stream().map(Response::statusCode).sorted().toList());
        }
    }

    @Test
    void doubleSubmit_fails_when_a_repeated_submission_creates_two_effects() {
        try (StubServer stub = orderStub(false)) {
            red(() -> Concurrency.doubleSubmit(() -> send("POST", stub.url() + "/orders", Map.of("cart", "cart-1")), () -> orderCount(stub)),
                    "changed the effect count by 2 (0 -> 2), expected exactly 1");
            assertEquals(2, orderCount(stub));
        }
        misuse(() -> Concurrency.doubleSubmit(() -> null, () -> 0, -1), "expectedDelta");
        misuse(() -> Concurrency.doubleSubmit(null, () -> 0), "action and countEffects");
    }

    @Test
    void concurrentRace_passes_when_exactly_the_capacity_is_booked() {
        try (StubServer stub = seatStub(1, SeatFault.NONE)) {
            RaceResult result = Concurrency.concurrentRace(RACERS, book(stub), 1,
                    race -> race.succeeded() == 1 && count(race.statuses(), 409) == RACERS - 1 && remainingSeats(stub) == 0);
            assertEquals(1, result.succeeded());
            assertEquals(RACERS - 1, result.failed());
            assertEquals(RACERS, result.statuses().size());
        }
    }

    @Test
    void concurrentRace_fails_when_the_race_overbooks() {
        try (StubServer stub = seatStub(1, SeatFault.OVERBOOK)) {
            red(() -> Concurrency.concurrentRace(RACERS, book(stub), 1, race -> true), RACERS + " calls succeeded for capacity 1 (overbooked)");
            assertEquals(1 - RACERS, remainingSeats(stub));
        }
    }

    @Test
    void concurrentRace_fails_on_a_server_error_or_a_broken_invariant() {
        try (StubServer stub = seatStub(RACERS, SeatFault.SERVER_ERROR_ON_THIRD)) {
            red(() -> Concurrency.concurrentRace(RACERS, book(stub), race -> true), "1 call(s) answered 5xx [500]");
        }
        try (StubServer stub = seatStub(1, SeatFault.NONE)) {
            red(() -> Concurrency.concurrentRace(RACERS, book(stub), 1, race -> race.succeeded() == 2), "the invariant does not hold");
        }
    }

    @Test
    void concurrentRace_rethrows_a_call_that_never_answered_instead_of_judging_it() throws IOException {
        int port;
        try (ServerSocket closed = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            port = closed.getLocalPort();
        }
        String refused = "http://127.0.0.1:" + port;
        Throwable thrown = assertThrows(Throwable.class, () -> Concurrency.concurrentRace(3, index -> given().baseUri(refused).get("/"), race -> true));
        assertFalse(thrown instanceof AssertionError, "a refused connection must not be a verdict: " + thrown);
        boolean socket = false;
        for (Throwable cause = thrown; cause != null; cause = cause.getCause()) socket |= cause instanceof SocketException;
        assertTrue(socket, "the refused connection is not in the cause chain: " + thrown);
        misuse(() -> Concurrency.concurrentRace(1, index -> null, race -> true), "n must be an integer from 2");
        misuse(() -> Concurrency.concurrentRace(RACERS, index -> null, null), "action and invariant");
        misuse(() -> Concurrency.concurrentRace(RACERS, index -> null, -1, race -> true), "capacity");
    }

    @Test
    void evaluateBounds_passes_inside_the_viewport_including_the_exact_edge() {
        Bounds exact = bounds(0, 0, 375, 375, true);
        assertSame(exact, Visual.evaluateBounds(exact));
        Visual.evaluateBounds(bounds(12.5, 800, 350, 375, true));
    }

    @Test
    void evaluateBounds_fails_on_each_violated_bound() {
        red(() -> Visual.evaluateBounds(bounds(-1, 0, 100, 375, true)), "renders at x=-1, left of the page");
        red(() -> Visual.evaluateBounds(bounds(0, -4, 100, 375, true)), "renders at y=-4, above the page");
        red(() -> Visual.evaluateBounds(bounds(300, 0, 75.5, 375, true)), "right edge 375.5 overflows the 375px viewport");
        red(() -> Visual.evaluateBounds(bounds(0, 0, 100, 420, true)), "the page scrolls horizontally (scrollWidth 420 > clientWidth 375)");
        red(() -> Visual.evaluateBounds(bounds(0, 0, 100, 375, false)), "another element covers the centre of its box (occluded)");
        String all = red(() -> Visual.evaluateBounds(bounds(-10, -10, 400, 500, false)), "visual bounds at 375px: ");
        assertEquals(5, all.split("; ").length, all);
    }

    @Test
    void evaluateBounds_rejects_misuse() {
        misuse(() -> Visual.evaluateBounds(null), "rect and viewport");
        misuse(() -> Visual.evaluateBounds(bounds(Double.NaN, 0, 10, 375, true)), "finite number");
        misuse(() -> Visual.evaluateBounds(bounds(0, 0, -1, 375, true)), "non-negative");
        misuse(() -> Visual.evaluateBounds(new Bounds(new Rect(0, 0, 1, 1), new Viewport(0, 667), 0, 0, true)), "positive size");
        misuse(() -> Visual.visualBounds(null), "locator");
    }

    @Test
    void analyzeScaling_takes_the_median_per_size_and_fits_the_growth_exponent() {
        ScalingAnalysis analysis = Scaling.analyzeScaling(concat(concat(samples(10, 2, 90, 2), samples(100, 3, 3)), samples(1000, 4, 4, 4, 400)));
        assertEquals(List.of(new SizeMedian(10, 3, 2, 1000), new SizeMedian(100, 2, 3, 1000), new SizeMedian(1000, 4, 4, 1000)), analysis.medians());
        assertEquals(Math.log(2) / Math.log(100), analysis.timeExponent(), 1e-12);
        assertEquals(0, analysis.bytesExponent(), 0);
        assertTrue(analysis.sublinear());
        Scaling.assertScaling(analysis);
        // The threshold is inclusive: 1 ms -> 10 ms over 10 -> 1000 items is exactly size^0.5.
        ScalingAnalysis edge = Scaling.analyzeScaling(concat(samples(10, 1), samples(1000, 10)));
        assertEquals(0.5, edge.timeExponent(), 0);
        assertTrue(edge.sublinear());
        // A body-less read at every size is flat.
        assertEquals(0, Scaling.analyzeScaling(List.of(new Sample(10, 1, 0), new Sample(1000, 1, 0))).bytesExponent(), 0);
    }

    @Test
    void analyzeScaling_reports_super_linear_time_and_payload_growth() {
        ScalingAnalysis slow = Scaling.analyzeScaling(concat(samples(10, 1), samples(1000, 10.5)));
        assertFalse(slow.sublinear());
        red(() -> Scaling.assertScaling(slow), "time grows as size^0.511 (max 0.5): 10 -> 1000 items took 1 ms -> 10.5 ms (median)");
        ScalingAnalysis unpaginated = Scaling.analyzeScaling(List.of(new Sample(10, 5, 400), new Sample(100, 5, 4000), new Sample(1000, 5, 40000)));
        assertEquals(1, unpaginated.bytesExponent(), 1e-12);
        red(() -> Scaling.assertScaling(unpaginated), "payload grows as size^1 (max 0.1): 10 -> 1000 items served 400 -> 40000 bytes (median)");
        // The thresholds are the documented contract: a linear payload passes when the strategy states maxBytesExponent 1.
        assertTrue(Scaling.analyzeScaling(List.of(new Sample(10, 5, 400), new Sample(1000, 5, 40000)), 0.5, 1).sublinear());
    }

    @Test
    void analyzeScaling_rejects_misuse() {
        misuse(() -> Scaling.analyzeScaling(samples(10, 1, 2)), "at least two distinct sizes");
        misuse(() -> Scaling.analyzeScaling(List.of(new Sample(10, 0, 1), new Sample(100, 1, 1))), "ms must be a finite number > 0");
        misuse(() -> Scaling.analyzeScaling(List.of(new Sample(0, 1, 1), new Sample(100, 1, 1))), "size must be a positive integer");
        misuse(() -> Scaling.analyzeScaling(List.of(new Sample(10, 1, -1), new Sample(100, 1, 1))), "bytes must be >= 0");
        misuse(() -> Scaling.analyzeScaling(List.of(new Sample(10, 1, 0), new Sample(100, 1, 50))), "a payload median of 0 at size 10");
        misuse(() -> Scaling.analyzeScaling(List.of(new Sample(10, 1, 1), new Sample(100, 1, 1)), Double.NaN, 0.1), "maxTimeExponent");
        misuse(() -> Scaling.analyzeScaling(List.of()), "non-empty");
    }

    @Test
    void n1Scaling_discards_the_warm_up_runs_and_asserts_the_analysis() {
        Map<Integer, AtomicInteger> calls = new ConcurrentHashMap<>();
        // The first read at the largest size is a cold 500 ms outlier; every other read takes 3 ms.
        Scaling.Measure coldLargest = size -> {
            int call = calls.computeIfAbsent(size, key -> new AtomicInteger()).getAndIncrement();
            return new Measurement(size == 1000 && call == 0 ? 500 : 3, 512);
        };
        ScalingAnalysis analysis = Scaling.n1Scaling(coldLargest, List.of(10, 100, 1000));
        assertEquals(List.of(10, 100, 1000), analysis.medians().stream().map(SizeMedian::size).toList());
        assertTrue(analysis.medians().stream().allMatch(median -> median.runs() == Scaling.DEFAULT_RUNS && median.ms() == 3));
        assertTrue(calls.values().stream().allMatch(count -> count.get() == Scaling.DEFAULT_WARMUP + Scaling.DEFAULT_RUNS));
        assertEquals(0, analysis.timeExponent(), 0);
        // Counted as a measurement, the same cold read is RED: one run per size, no warm-up.
        calls.clear();
        red(() -> Scaling.n1Scaling(coldLargest, List.of(10, 100, 1000), 1, 0, 0.5, 0.1), "time grows as size^1.11 (max 0.5)");

        red(() -> Scaling.n1Scaling(size -> new Measurement(size * 0.1, 512), List.of(10, 100, 1000)), "time grows as size^1 (max 0.5)");
        red(() -> Scaling.n1Scaling(size -> new Measurement(3, size * 40L), List.of(10, 100, 1000)), "payload grows as size^1 (max 0.1)");
    }

    @Test
    void n1Scaling_rejects_misuse_and_time_measures_a_real_read() {
        misuse(() -> Scaling.n1Scaling(size -> new Measurement(1, 1), List.of(10, 100)), "at least 3 sizes");
        misuse(() -> Scaling.n1Scaling(size -> new Measurement(1, 1), List.of(10, 10, 100)), "strictly ascending");
        misuse(() -> Scaling.n1Scaling(size -> new Measurement(1, 1), List.of(10, 100, 1000), 0, 1, 0.5, 0.1), "runs");
        misuse(() -> Scaling.n1Scaling(size -> null, List.of(10, 100, 1000)), "returned null");
        try (StubServer stub = StubServer.start(request -> "/blob".equals(request.path()) ? StubResponse.text(200, "a".repeat(1000)) : null)) {
            Timed timed = Scaling.time(() -> given().baseUri(stub.url()).get("/blob"));
            assertEquals(200, timed.response().statusCode());
            assertEquals(1000, timed.bytes());
            assertTrue(timed.ms() > 0, "a timed read takes positive time");
            assertEquals(new Measurement(timed.ms(), 1000), timed.measurement());
        }
    }
}
