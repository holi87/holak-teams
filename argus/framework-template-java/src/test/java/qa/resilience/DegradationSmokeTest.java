package qa.resilience;

import com.microsoft.playwright.Page;
import com.microsoft.playwright.Route;
import com.microsoft.playwright.options.AriaRole;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import qa.support.Config;
import qa.support.PlaywrightFixture;
import qa.support.argus.ArgusCounterfactualExtension;
import qa.support.argus.FaultInjector;
import qa.support.argus.FaultInjector.Fault;
import qa.support.argus.FaultInjector.Scope;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

/**
 * @resilience lane example: graceful degradation while the API is unavailable.
 *
 * <p>A {@link Scope#CLIENT} fault stays inside this browser ({@code page.route}), so it needs
 * no {@code ARGUS_FAULT_INJECTION} grant; a {@link Scope#SERVER} fault that changes the shared
 * target does. {@link FaultInjector} records the restore before injecting, always restores,
 * and fails the run as {@code fault-restore-failed} when the restore cannot be verified; the
 * console guard ignores the fault's intended 503s while it is active. The lane runs only when
 * {@code solution/test-lanes.tsv} enables it.
 *
 * <p>ADAPT-ME: point {@link #PAGE} at a screen that loads data from the API and replace the
 * error-state locator with the app's real error banner or empty state. The API calls are
 * matched by {@code ARGUS_API_ROUTE_PATTERN}, else the real {@code API_URL} + {@code /**}.
 */
@Tag("resilience")
// Order matters: afterEach runs in reverse, so an abandoned fault settles before the page closes.
@ExtendWith({PlaywrightFixture.class, FaultInjector.class})
class DegradationSmokeTest {

    private static final String PAGE = "/"; // ADAPT-ME

    @Test
    void the_ui_shows_an_error_state_while_the_api_answers_503_and_recovers_afterwards(Page page, FaultInjector faults) throws Exception {
        String apiPattern = ArgusCounterfactualExtension.routePattern();
        String apiPrefix = Config.targetApiUrl().replaceAll("/+$", "");
        AtomicInteger intercepted = new AtomicInteger();
        Consumer<Route> unavailable = route -> {
            intercepted.incrementAndGet();
            route.fulfill(new Route.FulfillOptions()
                    .setStatus(503)
                    .setContentType("application/json")
                    .setBody("{\"error\":\"unavailable\"}"));
        };
        page.navigate(PAGE);
        faults.inject(new Fault("api-unavailable", Scope.CLIENT,
                        () -> page.route(apiPattern, unavailable),
                        () -> page.unroute(apiPattern, unavailable),
                        // The next API request must reach the real API again instead of the injected 503.
                        () -> {
                            int before = intercepted.get();
                            page.waitForResponse(response -> response.url().startsWith(apiPrefix), page::reload);
                            if (intercepted.get() != before) {
                                throw new IllegalStateException("an API request was still intercepted after the restore");
                            }
                        }),
                () -> {
                    page.reload();
                    assertThat(page.getByRole(AriaRole.ALERT)).isVisible(); // ADAPT-ME: the app's error state
                });
    }
}
