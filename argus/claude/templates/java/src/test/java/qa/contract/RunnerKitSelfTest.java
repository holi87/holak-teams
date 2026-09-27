package qa.contract;

import io.restassured.builder.RequestSpecBuilder;
import io.restassured.specification.RequestSpecification;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.CreatedResources;
import qa.support.argus.ArgusCleanupError;
import qa.support.argus.ArgusPrerequisiteError;
import qa.support.argus.ArgusRestoreError;
import qa.support.argus.FaultInjector;
import qa.support.argus.FaultInjector.Fault;
import qa.support.argus.FaultInjector.Scope;
import qa.support.argus.Reproduction;
import qa.support.argus.StubServer;
import qa.support.argus.StubServer.Exchange;
import qa.support.argus.StubServer.ExchangeRequest;
import qa.support.argus.StubServer.RecordedRequest;
import qa.support.argus.StubServer.StubResponse;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Self-tests for the runner-kit helpers {@link FaultInjector}, {@link CreatedResources}, and
 * {@link Reproduction}, the Java port of runner-kit.selftest.spec.ts. Nothing contacts a real
 * target: faults are recorded calls, and cleanup DELETEs go to a 127.0.0.1 stub. Negative cases assert the
 * rejection itself, so a healthy run reports {@code product pass} for every case.
 */
@Tag("contract-smoke")
class RunnerKitSelfTest {

    private static final String SECRET = "argus-never-print-me";

    /** A fault whose hooks append to {@code calls}; hooks named in {@code failing} throw. */
    private static Fault recordedFault(List<String> calls, Scope scope, String... failing) {
        List<String> fail = List.of(failing);
        return new Fault("api-unavailable", scope, hook(calls, fail, "inject"), hook(calls, fail, "restore"), hook(calls, fail, "verify"));
    }

    private static Fault recordedFault(List<String> calls, String... failing) {
        return recordedFault(calls, Scope.CLIENT, failing);
    }

    private static FaultInjector.Step hook(List<String> calls, List<String> fail, String name) {
        return () -> {
            calls.add(name);
            if (fail.contains(name)) throw new IllegalStateException(name + " failed with " + SECRET);
        };
    }

    @Test
    void fault_injector_restores_and_verifies_after_a_passing_body() throws Exception {
        List<String> calls = new CopyOnWriteArrayList<>();
        FaultInjector injector = new FaultInjector();
        String value = injector.inject(recordedFault(calls), () -> {
            calls.add("body");
            assertTrue(injector.pending() && FaultInjector.active(), "the fault is not active during the body");
            return "body-result";
        });
        assertEquals("body-result", value);
        assertEquals(List.of("inject", "body", "restore", "verify"), calls);
        assertFalse(injector.pending() || FaultInjector.active(), "the fault stayed active after its verified restore");
    }

    @Test
    void fault_injector_restores_after_a_failing_body_and_rethrows_the_body_error() {
        List<String> calls = new CopyOnWriteArrayList<>();
        IllegalArgumentException bodyError = new IllegalArgumentException("assertion in the body");
        Exception thrown = assertThrows(Exception.class, () -> FaultInjector.run(recordedFault(calls), () -> {
            calls.add("body");
            throw bodyError;
        }));
        assertSame(bodyError, thrown);
        assertEquals(List.of("inject", "body", "restore", "verify"), calls);
    }

    @Test
    void reproduce_repeats_the_attempt_and_stops_at_the_first_violation() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        Reproduction.reproduce(3, attempts::incrementAndGet);
        assertEquals(3, attempts.get());
        attempts.set(0);
        AssertionError violation = assertThrows(AssertionError.class, () -> Reproduction.reproduce(5, () -> {
            if (attempts.incrementAndGet() == 2) throw new AssertionError("synthetic violation");
        }));
        assertEquals("synthetic violation", violation.getMessage());
        assertEquals(2, attempts.get());
        assertThrows(IllegalArgumentException.class, () -> Reproduction.reproduce(0, () -> {}));
        assertThrows(IllegalArgumentException.class, () -> Reproduction.reproduce(201, () -> {}));
    }

    @Test
    void fault_injector_restores_a_partial_injection() {
        List<String> calls = new CopyOnWriteArrayList<>();
        Exception thrown = assertThrows(Exception.class, () -> FaultInjector.run(recordedFault(calls, "inject"), () -> calls.add("body")));
        assertTrue(thrown.getMessage().contains("inject failed"), "the injection error was not rethrown");
        assertEquals(List.of("inject", "restore", "verify"), calls);
    }

    @Test
    void a_failed_restore_or_verification_is_a_restore_error_that_outranks_the_body_error() {
        for (String failing : List.of("restore", "verify")) {
            List<String> calls = new CopyOnWriteArrayList<>();
            IllegalArgumentException bodyError = new IllegalArgumentException("assertion in the body");
            ArgusRestoreError error = assertThrows(ArgusRestoreError.class, () -> FaultInjector.run(recordedFault(calls, failing), () -> {
                throw bodyError;
            }));
            assertTrue(List.of(error.getSuppressed()).contains(bodyError), "the body error is not kept with the " + failing + " failure");
            assertFalse(error.getMessage().contains(SECRET), "the restore error echoed hook details");
            assertTrue(error.getMessage().contains("api-unavailable"), "the restore error does not name the fault");
            assertFalse(FaultInjector.active(), "a failed " + failing + " left the fault marked active");
        }
    }

    @Test
    void a_server_fault_needs_argus_fault_injection_authorized_before_anything_is_injected() throws Exception {
        List<String> calls = new CopyOnWriteArrayList<>();
        // The runner never sets the grant for a contract smoke; an engagement sets it only with
        // the chaos grant and the exclusive fault window.
        if ("authorized".equals(System.getenv("ARGUS_FAULT_INJECTION"))) {
            FaultInjector.run(recordedFault(calls, Scope.SERVER), () -> calls.add("body"));
            assertEquals(List.of("inject", "body", "restore", "verify"), calls);
        } else {
            assertThrows(ArgusPrerequisiteError.class, () -> FaultInjector.run(recordedFault(calls, Scope.SERVER), () -> calls.add("body")));
            assertEquals(List.of(), calls);
            assertFalse(FaultInjector.active(), "a refused server fault was recorded");
        }
    }

    @Test
    void settle_restores_a_fault_the_test_left_active_exactly_once() throws Exception {
        List<String> calls = new CopyOnWriteArrayList<>();
        FaultInjector injector = new FaultInjector();
        CountDownLatch injected = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread abandoned = new Thread(() -> {
            try {
                injector.inject(recordedFault(calls), () -> {
                    injected.countDown();
                    assertTrue(release.await(10, TimeUnit.SECONDS), "the abandoned body was never released");
                });
            } catch (Throwable error) {
                failure.set(error);
            }
        });
        abandoned.start();
        assertTrue(injected.await(10, TimeUnit.SECONDS), "the fault was never injected");
        injector.settle();
        assertEquals(List.of("inject", "restore", "verify"), calls);
        assertFalse(injector.pending() || FaultInjector.active(), "settle left the fault active");
        release.countDown();
        abandoned.join(10_000);
        assertFalse(abandoned.isAlive(), "the abandoned body did not finish");
        if (failure.get() != null) throw new AssertionError("the abandoned run failed", failure.get());
        assertEquals(List.of("inject", "restore", "verify"), calls);
    }

    @Test
    void an_invalid_fault_is_refused_before_it_is_injected() {
        List<String> calls = new CopyOnWriteArrayList<>();
        FaultInjector.Step step = () -> calls.add("hook");
        assertThrows(IllegalArgumentException.class, () -> new Fault("Not A Token", Scope.CLIENT, step, step, step));
        assertThrows(IllegalArgumentException.class, () -> new Fault("api-unavailable", null, step, step, step));
        assertThrows(IllegalArgumentException.class, () -> new Fault("api-unavailable", Scope.CLIENT, step, null, step));
        assertEquals(List.of(), calls);
    }

    @Test
    void created_resources_cleanup_attempts_every_delete_newest_first_and_counts_failures() {
        StubServer refused = StubServer.start();
        RequestSpecification unreachable = spec(refused);
        refused.stop();
        try (StubServer stub = StubServer.start()) {
            stub.load(List.of(
                    delete("already-gone", "/items/1", StubResponse.status(404)),
                    delete("deleted", "/items/2", StubResponse.status(204)),
                    delete("refused", "/items/3", StubResponse.json(409, Map.of("detail", SECRET))),
                    delete("accepted", "/items/4", StubResponse.status(202)),
                    delete("ok", "/items/5", StubResponse.status(200))));
            RequestSpecification live = spec(stub);
            CreatedResources created = new CreatedResources();
            created.register(live, "/items/1");
            created.register(live, "/items/2");
            created.register(unreachable, "/items/6");
            created.register(live, "/items/3");
            created.register(live, "/items/4");
            created.register(live, "/items/5");
            ArgusCleanupError error = assertThrows(ArgusCleanupError.class, created::cleanup);
            assertEquals("cleanup failed for 2 resource(s)", error.getMessage());
            assertEquals(List.of("/items/5", "/items/4", "/items/3", "/items/2", "/items/1"),
                    stub.requests().stream().map(RecordedRequest::path).toList());
            assertEquals(0, created.size(), "cleanup left resources queued");
        }
    }

    @Test
    void created_resources_cleanup_passes_when_every_delete_succeeds_or_finds_nothing() {
        try (StubServer stub = StubServer.start()) {
            stub.load(List.of(
                    delete("deleted", "/items/1", StubResponse.status(204)),
                    delete("already-gone", "/items/2", StubResponse.status(404))));
            CreatedResources created = new CreatedResources();
            created.register(spec(stub), "/items/1");
            created.register(spec(stub), "/items/2");
            created.cleanup();
            assertEquals(2, stub.requests().size());
            assertTrue(stub.unmatched().isEmpty(), "cleanup sent an undeclared request");
        }
    }

    @Test
    void created_resources_refuse_a_path_outside_the_spec_base() {
        CreatedResources created = new CreatedResources();
        RequestSpecification spec = new RequestSpecBuilder().setBaseUri("http://127.0.0.1:9").build();
        assertThrows(IllegalArgumentException.class, () -> created.register(spec, "https://elsewhere.example/items/1"));
        assertThrows(IllegalArgumentException.class, () -> created.register(spec, "items/1"));
        assertEquals(0, created.size());
    }

    private static RequestSpecification spec(StubServer stub) {
        return new RequestSpecBuilder().setBaseUri(stub.url()).build();
    }

    private static Exchange delete(String id, String path, StubResponse response) {
        return new Exchange(id, new ExchangeRequest("DELETE", path, Map.of()), response);
    }
}
