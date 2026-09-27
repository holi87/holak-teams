package qa.ui;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.options.AriaRole;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import qa.support.Config;
import qa.support.PlaywrightFixture;

import java.util.regex.Pattern;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

/**
 * ADAPT-ME: critical-path UI journeys of the funded, risk-derived UI lane; push field-level
 * coverage to the API layer. The fixture authenticates ONCE and seeds storageState, so the
 * injected {@link Page} starts AUTHENTICATED — no per-test login. Use role/label locators
 * (getByRole/getByLabel), never CSS tied to styling. Lane: {@code @Tag("ui")}
 * (Playwright-Java, NO Selenium).
 *
 * <p>Assertions are exact: the full URL and the exact heading or message the product
 * documents, never a pattern that several states would satisfy ("dashboard|home", "invalid|
 * failed"). Locators may stay tolerant; oracles may not.
 */
@Tag("ui")
@ExtendWith(PlaywrightFixture.class)
class ExampleUiTest {

    // ── The documented UI contract: from the spec or the recon notes, never from a screenshot of today's build ──
    private static final String HOME_PATH = "/dashboard";                    // <-- adapt (PlaywrightFixture's success signal)
    private static final String HOME_HEADING = "Dashboard";                  // <-- adapt
    private static final String LOGIN_PATH = "/login";                       // <-- adapt
    private static final String LOGIN_ERROR = "Invalid email or password";   // <-- adapt the documented message

    private static final int CASE_I = Pattern.CASE_INSENSITIVE;

    /** The absolute URL of an app path, as hasURL compares it. */
    private static String url(String path) {
        return Config.uiUrl().replaceAll("/+$", "") + path;
    }

    @Test
    void authenticated_user_reaches_the_app(Page page) {
        page.navigate(HOME_PATH); // storageState already carries the session
        assertThat(page).hasURL(url(HOME_PATH)); // a redirect to the login page is RED
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName(HOME_HEADING).setExact(true))).isVisible();
    }

    @Test
    void login_rejects_bad_credentials(Browser browser) {
        // Fresh, unauthenticated context for this test only (no storageState):
        BrowserContext anon = browser.newContext(new Browser.NewContextOptions().setBaseURL(Config.uiUrl()));
        try {
            Page page = anon.newPage();
            page.navigate(LOGIN_PATH);
            page.getByLabel(Pattern.compile("email|username", CASE_I)).fill("nobody@example.com");
            page.getByLabel(Pattern.compile("password", CASE_I)).fill("wrong-password");
            page.getByRole(AriaRole.BUTTON,
                    new Page.GetByRoleOptions().setName(Pattern.compile("log\\s*in|sign\\s*in", CASE_I))).click();
            assertThat(page.getByText(LOGIN_ERROR, new Page.GetByTextOptions().setExact(true))).isVisible();
            assertThat(page).hasURL(url(LOGIN_PATH)); // no session: the user stays on the login page
        } finally {
            anon.close();
        }
    }
}
