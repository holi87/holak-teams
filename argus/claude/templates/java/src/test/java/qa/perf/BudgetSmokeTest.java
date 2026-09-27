package qa.perf;

import org.awaitility.Awaitility;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;
import qa.support.argus.ArgusPrerequisiteError;

import java.util.concurrent.TimeUnit;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * @perf lane — a GATE, not a benchmark.
 *
 * <p>The lane runs only when {@code solution/test-lanes.tsv} enables it, with
 * {@code PERF_BUDGET_MS} as its prerequisite. A missing, non-numeric or non-positive budget is
 * reported through {@link ArgusPrerequisiteError} as {@code prerequisite-missing}; the test
 * never skips itself and never invents a threshold. When enabled, it demonstrates an
 * Awaitility wait against that stated budget. ADAPT-ME: once recon + the strategy name a real
 * budget and target, add the characterisation assertions (p50/p95/p99) or wire a dedicated
 * load probe.
 */
@Tag("perf")
class BudgetSmokeTest {

    private final ApiClient api = new ApiClient();

    @Test
    void perf_budget_is_a_positive_stated_number() {
        // Guard against a typo'd / non-numeric budget silently weakening the gate.
        assertTrue(budgetMs() > 0, "PERF_BUDGET_MS must be a positive number of milliseconds");
    }

    @Test
    void api_responds_within_the_stated_budget() {
        long budget = budgetMs();
        // Awaitility polls health until it answers below 400 within the budget. A slow or
        // unreachable API ends in ConditionTimeoutException (test-timeout), never a skip.
        Awaitility.await("health responds within PERF_BUDGET_MS")
                .atMost(budget, TimeUnit.MILLISECONDS)
                .pollInterval(50, TimeUnit.MILLISECONDS)
                .ignoreExceptions()
                .until(() -> given().spec(api.anon()).get(ApiClient.HEALTH).statusCode() < 400);
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
