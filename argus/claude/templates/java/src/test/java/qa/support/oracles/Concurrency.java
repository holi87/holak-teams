package qa.support.oracles;

import io.restassured.response.Response;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.LongSupplier;
import java.util.function.Predicate;

/**
 * Concurrency oracles, the Java port of concurrency.ts. Calls are released together: each
 * runs on its own thread of a fixed pool, parks on a {@link CountDownLatch} start gate, and
 * the gate opens only once every thread is parked, so the requests overlap as closely as the
 * client allows. Every call settles before the verdict. A call that throws instead of
 * answering leaves the race without a verdict: its exception is rethrown (a refused
 * connection reports target-unreachable, a hang test-timeout), never counted as a GREEN
 * failure. A RED throws {@link AssertionError}; misuse throws
 * {@link IllegalArgumentException}.
 */
public final class Concurrency {

    /** One racing call; {@code index} runs from 0 to n - 1, so each call can carry its own data. */
    @FunctionalInterface
    public interface RaceCall {
        Response send(int index) throws Exception;
    }

    /** Both submissions' results in submission order, and the effect count before and after. */
    public record DoubleSubmitResult<T>(List<T> results, long before, long after) {
        public long delta() {
            return after - before;
        }
    }

    /**
     * {@code succeeded} counts 2xx answers, {@code failed} every other answer, and
     * {@code statuses} holds each call's status in call order.
     */
    public record RaceResult(int succeeded, int failed, List<Integer> statuses) {}

    /** How long all calls of one release may take to settle. */
    public static final Duration SETTLE_TIMEOUT = Duration.ofSeconds(60);

    /** A race, not a load test: more parallel calls than this is misuse. */
    public static final int MAX_CALLS = 256;

    private Concurrency() {}

    public static <T> DoubleSubmitResult<T> doubleSubmit(Callable<T> action, LongSupplier countEffects) {
        return doubleSubmit(action, countEffects, 1);
    }

    /**
     * Fires {@code action} twice at once and requires the effect count to grow by exactly
     * {@code expectedDelta} (default 1: a double click, a retried submit, or a replayed form
     * creates one order, not two). {@code countEffects} reads the effect count before and
     * after, for example the size of the collection or the balance in minor units.
     */
    public static <T> DoubleSubmitResult<T> doubleSubmit(Callable<T> action, LongSupplier countEffects, long expectedDelta) {
        if (action == null || countEffects == null) throw new IllegalArgumentException("doubleSubmit: action and countEffects must not be null");
        if (expectedDelta < 0) throw new IllegalArgumentException("doubleSubmit: expectedDelta must be >= 0, got " + expectedDelta);
        long before = countEffects.getAsLong();
        List<T> results = release(2, index -> action.call());
        long after = countEffects.getAsLong();
        if (after - before != expectedDelta) {
            throw new AssertionError("doubleSubmit: two simultaneous submissions changed the effect count by " + (after - before)
                    + " (" + before + " -> " + after + "), expected exactly " + expectedDelta);
        }
        return new DoubleSubmitResult<>(Collections.unmodifiableList(results), before, after);
    }

    public static RaceResult concurrentRace(int n, RaceCall action, Predicate<RaceResult> invariant) {
        return concurrentRace(n, action, null, invariant);
    }

    /**
     * Fires {@code n} calls at a scarce resource at once and requires: no 5xx answer, at most
     * {@code capacity} successes when a capacity is given (no overbooking), and
     * {@code invariant} to hold for the result (for example exactly {@code capacity}
     * successes, every other answer the documented 409, and a read-back count that matches).
     * Returns the result.
     */
    public static RaceResult concurrentRace(int n, RaceCall action, Integer capacity, Predicate<RaceResult> invariant) {
        if (n < 2 || n > MAX_CALLS) throw new IllegalArgumentException("concurrentRace: n must be an integer from 2 to " + MAX_CALLS + ", got " + n);
        if (action == null || invariant == null) throw new IllegalArgumentException("concurrentRace: action and invariant must not be null");
        if (capacity != null && capacity < 0) throw new IllegalArgumentException("concurrentRace: capacity must be >= 0, got " + capacity);
        List<Response> responses = release(n, action::send);
        List<Integer> statuses = new ArrayList<>();
        for (int index = 0; index < n; index++) {
            Response response = responses.get(index);
            if (response == null) throw new IllegalArgumentException("concurrentRace: call " + index + " returned null instead of a response");
            statuses.add(response.statusCode());
        }
        int succeeded = (int) statuses.stream().filter(status -> status >= 200 && status < 300).count();
        RaceResult result = new RaceResult(succeeded, n - succeeded, List.copyOf(statuses));
        List<String> problems = new ArrayList<>();
        List<Integer> serverErrors = statuses.stream().filter(status -> status >= 500).toList();
        if (!serverErrors.isEmpty()) problems.add(serverErrors.size() + " call(s) answered 5xx " + serverErrors);
        if (capacity != null && succeeded > capacity) problems.add(succeeded + " calls succeeded for capacity " + capacity + " (overbooked)");
        if (problems.isEmpty() && !invariant.test(result)) problems.add("the invariant does not hold");
        if (!problems.isEmpty()) {
            throw new AssertionError("concurrentRace of " + n + " calls: " + String.join("; ", problems) + "; statuses " + statuses);
        }
        return result;
    }

    @FunctionalInterface
    private interface Indexed<T> {
        T call(int index) throws Exception;
    }

    /**
     * Runs {@code n} calls behind one start gate and returns their results in call order.
     * Rethrows the first call's exception (the others attached as suppressed) once every call
     * has settled.
     */
    private static <T> List<T> release(int n, Indexed<T> call) {
        ExecutorService pool = Executors.newFixedThreadPool(n, task -> {
            Thread thread = new Thread(task, "argus-race");
            thread.setDaemon(true);
            return thread;
        });
        CountDownLatch parked = new CountDownLatch(n);
        CountDownLatch gate = new CountDownLatch(1);
        try {
            List<Future<T>> futures = new ArrayList<>();
            for (int index = 0; index < n; index++) {
                int own = index;
                futures.add(pool.submit(() -> {
                    parked.countDown();
                    gate.await();
                    return call.call(own);
                }));
            }
            long deadline = System.nanoTime() + SETTLE_TIMEOUT.toNanos();
            if (!parked.await(SETTLE_TIMEOUT.toNanos(), TimeUnit.NANOSECONDS)) {
                throw new IllegalStateException("the racing threads did not start", new TimeoutException("start gate"));
            }
            gate.countDown();
            List<T> results = new ArrayList<>();
            Throwable first = null;
            for (int index = 0; index < n; index++) {
                try {
                    results.add(futures.get(index).get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS));
                } catch (ExecutionException settled) {
                    results.add(null);
                    Throwable cause = settled.getCause();
                    if (first == null) first = cause;
                    else if (cause != first) first.addSuppressed(cause);
                } catch (TimeoutException hung) {
                    throw new IllegalStateException(n + " simultaneous calls did not settle within " + SETTLE_TIMEOUT.toSeconds() + "s", hung);
                }
            }
            if (first instanceof RuntimeException unchecked) throw unchecked;
            if (first instanceof Error error) throw error;
            if (first != null) throw new IllegalStateException("a simultaneous call threw instead of answering", first);
            return results;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting for simultaneous calls", interrupted);
        } finally {
            gate.countDown();
            pool.shutdownNow();
        }
    }
}
