package qa.perf;

import org.awaitility.Awaitility;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import qa.support.ApiClient;

import java.util.concurrent.TimeUnit;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * @perf lane — GATED, not a benchmark.
 *
 * <p>The whole class is skipped unless {@code PERF_BUDGET_MS} is set: an unset run shows it
 * SKIPPED (not failed) and the exit code stays 0. When enabled, it asserts a budget was
 * explicitly STATED (never invents a threshold) and demonstrates an Awaitility wait against
 * that budget. ADAPT-ME: once recon + the strategy name a real budget and target, add the
 * characterisation assertions (p50/p95/p99) or wire a dedicated load probe.
 */
@Tag("perf")
@EnabledIfEnvironmentVariable(named = "PERF_BUDGET_MS", matches = ".+")
class BudgetSmokeTest {

    private final ApiClient api = new ApiClient();

    @Test
    void perf_budget_is_a_positive_stated_number() {
        String raw = System.getenv("PERF_BUDGET_MS");
        long ms;
        try {
            ms = Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            // Guard against a typo'd / non-numeric budget silently weakening the gate.
            assertTrue(false, "PERF_BUDGET_MS must be a number, got: '" + raw + "'");
            return;
        }
        assertTrue(ms > 0, "PERF_BUDGET_MS must be > 0, got: " + ms);
    }

    @Test
    void api_responds_within_the_stated_budget() {
        long budget = positiveBudgetOrSkip();
        // Optional probe: only when the API is reachable — otherwise self-skip (don't fail
        // the gate on infrastructure). Awaitility polls health until it answers 2xx in budget.
        assumeTrue(reachable(), "API_URL not reachable — skipping latency probe");
        Awaitility.await("health responds within PERF_BUDGET_MS")
                .atMost(budget, TimeUnit.MILLISECONDS)
                .pollInterval(50, TimeUnit.MILLISECONDS)
                .ignoreExceptions()
                .until(() -> given().spec(api.anon()).get(ApiClient.HEALTH).statusCode() < 400);
    }

    private long positiveBudgetOrSkip() {
        String raw = System.getenv("PERF_BUDGET_MS");
        try {
            long v = Long.parseLong(raw.trim());
            assumeTrue(v > 0, "PERF_BUDGET_MS not positive");
            return v;
        } catch (NumberFormatException e) {
            assumeTrue(false, "PERF_BUDGET_MS not numeric: '" + raw + "'");
            return -1; // unreachable
        }
    }

    private boolean reachable() {
        try {
            return given().spec(api.anon()).get(ApiClient.HEALTH).statusCode() < 500;
        } catch (Exception e) {
            return false;
        }
    }
}
