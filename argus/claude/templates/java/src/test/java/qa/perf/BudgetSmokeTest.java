package qa.perf;

import io.restassured.response.Response;
import io.restassured.specification.RequestSpecification;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import qa.support.ApiClient;
import qa.support.CreatedResources;
import qa.support.argus.ArgusPrerequisiteError;
import qa.support.oracles.Http;
import qa.support.oracles.Scaling;
import qa.support.oracles.Scaling.Timed;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

import static io.restassured.RestAssured.given;
import static io.restassured.http.ContentType.JSON;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static qa.support.DataFactory.order;

/**
 * @perf lane — a GATE, not a benchmark.
 *
 * <p>The lane runs only when {@code solution/test-lanes.tsv} enables it, with
 * {@code PERF_BUDGET_MS} as its prerequisite. A missing, non-numeric or non-positive budget is
 * reported through {@link ArgusPrerequisiteError} as {@code prerequisite-missing}; the test
 * never skips itself and never invents a threshold. When enabled, it measures an explicit p95
 * over a fixed number of timed requests (warm-up discarded, every sample the exact documented
 * status: a fast error is not a fast answer) against that stated budget, and checks that a
 * collection read scales sub-linearly with the collection ({@link Scaling#n1Scaling}).
 * ADAPT-ME: once recon + the strategy name the budgeted endpoints, point the constants at
 * them, or wire a dedicated load probe for throughput characterisation.
 */
@Tag("perf")
@ExtendWith(CreatedResources.class)
class BudgetSmokeTest {

    /** Requests discarded before measuring: connection setup, JIT and caches. */
    private static final int WARMUP_REQUESTS = 3;
    /** Timed requests; with 20 samples the nearest-rank p95 is the 19th fastest. */
    private static final int MEASURED_REQUESTS = 20;
    /** ADAPT-ME: collection sizes spread over a factor of ten or more; the example seeds this many orders. */
    private static final List<Integer> COLLECTION_SIZES = List.of(5, 25, 125);

    private final ApiClient api = new ApiClient();

    @Test
    void perf_budget_is_a_positive_stated_number() {
        // Guard against a typo'd / non-numeric budget silently weakening the gate.
        assertTrue(budgetMs() > 0, "PERF_BUDGET_MS must be a positive number of milliseconds");
    }

    @Test
    void api_p95_is_within_the_stated_budget() {
        long budget = budgetMs();
        RequestSpecification anon = api.anon();
        for (int i = 0; i < WARMUP_REQUESTS; i++) {
            Http.expectStatus(given().spec(anon).get(ApiClient.HEALTH), 200);
        }
        double[] samples = new double[MEASURED_REQUESTS];
        for (int i = 0; i < MEASURED_REQUESTS; i++) {
            Timed timed = Scaling.time(() -> given().spec(anon).get(ApiClient.HEALTH)); // <-- adapt the budgeted endpoint
            Http.expectStatus(timed.response(), 200); // <-- its documented status
            samples[i] = timed.ms();
        }
        double p95 = nearestRank(samples, 95);
        if (p95 > budget) {
            throw new AssertionError(String.format(Locale.ROOT, "p95 %.1f ms over %d requests exceeds PERF_BUDGET_MS=%d (median %.1f ms, max %.1f ms)",
                    p95, MEASURED_REQUESTS, budget, nearestRank(samples, 50), nearestRank(samples, 100)));
        }
    }

    /**
     * N+1 and unpaginated reads grow with the collection. The measure seeds only the missing
     * orders (registered for cleanup), then times one read; the defaults require time to grow
     * at most as size^0.5 and the payload at most as size^0.1 (a paginated read stays flat).
     * ADAPT-ME: the collection endpoint, its seeding path, and, when the contract returns the
     * whole collection, the maxBytesExponent the strategy states.
     */
    @Test
    void collection_read_scales_sublinearly(CreatedResources created) {
        RequestSpecification user = api.apiAs("user");
        AtomicInteger seeded = new AtomicInteger();
        Scaling.n1Scaling(size -> {
            while (seeded.get() < size) {
                Response res = given().spec(user).contentType(JSON).body(order().build()).when().post(ApiClient.ORDERS); // <-- adapt
                Http.expectStatus(res, 201);
                created.register(user, ApiClient.ORDERS + "/" + res.path("id")); // <-- adapt the id field
                seeded.incrementAndGet();
            }
            Timed timed = Scaling.time(() -> given().spec(user).get(ApiClient.ORDERS)); // <-- adapt the collection read
            Http.expectStatus(timed.response(), 200);
            return timed.measurement();
        }, COLLECTION_SIZES);
    }

    /** The nearest-rank percentile: the smallest sample with at least p% of the samples at or below it. */
    private static double nearestRank(double[] samples, int percentile) {
        double[] sorted = samples.clone();
        Arrays.sort(sorted);
        int rank = (int) Math.ceil(percentile / 100.0 * sorted.length);
        return sorted[Math.max(0, rank - 1)];
    }

    /** The stated budget in milliseconds; anything but a positive integer is a missing prerequisite. */
    private static long budgetMs() {
        String raw = ArgusPrerequisiteError.requireEnv("PERF_BUDGET_MS").trim();
        try {
            long ms = Long.parseLong(raw);
            if (ms > 0) return ms;
        } catch (NumberFormatException notANumber) {
            // reported below without echoing the value
        }
        throw new ArgusPrerequisiteError("PERF_BUDGET_MS must be a positive integer number of milliseconds");
    }
}
