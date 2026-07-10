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
 * ADAPT-ME: critical-path UI smoke only. Keep UI tests few; push coverage to the API layer.
 * The fixture authenticates ONCE and seeds storageState, so the injected {@link Page} starts
 * AUTHENTICATED — no per-test login. Use role/label locators (getByRole/getByLabel), never
 * CSS tied to styling. Lane: {@code @Tag("ui")} (Playwright-Java, NO Selenium).
 */
@Tag("ui")
@ExtendWith(PlaywrightFixture.class)
class ExampleUiTest {

    private static final int CASE_I = Pattern.CASE_INSENSITIVE;

    @Test
    void authenticated_user_reaches_the_app(Page page) {
        page.navigate("/"); // storageState already carries the session
        assertThat(page).hasURL(Pattern.compile("dashboard|home|/$")); // <-- adapt the success signal
    }

    @Test
    void login_rejects_bad_credentials(Browser browser) {
        // Fresh, unauthenticated context for this test only (no storageState):
        BrowserContext anon = browser.newContext(new Browser.NewContextOptions().setBaseURL(Config.uiUrl()));
        try {
            Page page = anon.newPage();
            page.navigate("/"); // <-- adapt (e.g. "/login")
            page.getByLabel(Pattern.compile("email|username", CASE_I)).fill("nobody@example.com");
            page.getByLabel(Pattern.compile("password", CASE_I)).fill("wrong-password");
            page.getByRole(AriaRole.BUTTON,
                    new Page.GetByRoleOptions().setName(Pattern.compile("log\\s*in|sign\\s*in", CASE_I))).click();
            assertThat(page.getByText(Pattern.compile("invalid|incorrect|failed", CASE_I))).isVisible(); // <-- adapt
        } finally {
            anon.close();
        }
    }
}
