package qa.support;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.BrowserType;
import com.microsoft.playwright.ConsoleMessage;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.Response;
import com.microsoft.playwright.options.AriaRole;
import org.junit.jupiter.api.extension.AfterAllCallback;
import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolutionException;
import org.junit.jupiter.api.extension.ParameterResolver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Playwright lifecycle as a JUnit 5 extension — the UI lane's fixture (its DI).
 *
 * <ul>
 *   <li>{@code beforeAll}: launch one Playwright + Chromium browser, then <b>auth ONCE</b>
 *       and persist {@code .auth/user.json} (storageState) — the canonical Playwright pattern.</li>
 *   <li>{@code beforeEach}: a fresh {@link BrowserContext} + {@link Page}, seeded with the
 *       saved storageState so every UI test starts <b>already authenticated</b>.</li>
 *   <li><b>consoleGuard</b>: every UI test inherits a console-error + 5xx-response guard on the
 *       injected {@link Page}; {@code afterEach} fails the test if anything was collected —
 *       silent JS errors and broken XHRs are the cheapest high-yield web signal. Mirrors the
 *       TypeScript template's {@code consoleGuard} auto-fixture.</li>
 *   <li>Parameter injection: declare {@code Page}, {@code BrowserContext} or {@code Browser}
 *       on a test method and it is supplied here — specs never new-up Playwright themselves.</li>
 * </ul>
 *
 * Use with {@code @ExtendWith(PlaywrightFixture.class)}. Determinism: parallel execution is
 * disabled (junit-platform.properties), so the single reused instance's per-test fields are safe.
 *
 * ADAPT-ME: the login selectors in {@link #ensureStorageState()} and the success-URL signal.
 */
public class PlaywrightFixture
        implements BeforeAllCallback, AfterAllCallback, BeforeEachCallback, AfterEachCallback, ParameterResolver {

    private static final Path STORAGE_STATE = Paths.get(".auth", "user.json");
    private static final int CASE_I = Pattern.CASE_INSENSITIVE;

    private Playwright playwright;
    private Browser browser;
    private BrowserContext context;
    private Page page;

    /** Console-error + 5xx guard: allowlist (known noise) and the per-test violation list. */
    private List<Pattern> consoleGuardAllow = List.of();
    private List<String> consoleGuardViolations;

    @Override
    public void beforeAll(ExtensionContext ctx) {
        playwright = Playwright.create();
        boolean headed = "1".equals(System.getenv("HEADED"));
        browser = playwright.chromium().launch(new BrowserType.LaunchOptions().setHeadless(!headed));
        consoleGuardAllow = consoleGuardAllowlist();
        ensureStorageState();
    }

    /**
     * Log in via the UI exactly once and persist the session. Best-effort: if the app
     * isn't up or the selectors need adapting, we warn and fall back to anonymous contexts
     * (the UI tests then fail cleanly on their assertions rather than erroring in setup).
     */
    private void ensureStorageState() {
        if (Files.exists(STORAGE_STATE)) return;
        BrowserContext tmp = null;
        try {
            tmp = browser.newContext(new Browser.NewContextOptions().setBaseURL(Config.uiUrl()));
            Page p = tmp.newPage();
            p.navigate("/"); // <-- adapt (e.g. "/login")
            Config.Account user = Config.account("user");
            p.getByLabel(Pattern.compile("email|username", CASE_I)).fill(user.username());
            p.getByLabel(Pattern.compile("password", CASE_I)).fill(user.password());
            p.getByRole(AriaRole.BUTTON,
                    new Page.GetByRoleOptions().setName(Pattern.compile("log\\s*in|sign\\s*in", CASE_I))).click();
            p.waitForURL(Pattern.compile("dashboard|home|/$")); // <-- adapt the success signal
            Files.createDirectories(STORAGE_STATE.getParent());
            tmp.storageState(new BrowserContext.StorageStateOptions().setPath(STORAGE_STATE));
        } catch (Exception e) {
            System.err.println("[PlaywrightFixture] auth-once failed — ADAPT-ME login flow / app not up: " + e.getMessage());
            try { Files.deleteIfExists(STORAGE_STATE); } catch (Exception ignored) { /* nothing to clean */ }
        } finally {
            if (tmp != null) tmp.close();
        }
    }

    @Override
    public void beforeEach(ExtensionContext ctx) {
        Browser.NewContextOptions opts = new Browser.NewContextOptions().setBaseURL(Config.uiUrl());
        if (Files.exists(STORAGE_STATE)) {
            opts.setStorageStatePath(STORAGE_STATE);
        }
        context = browser.newContext(opts);
        page = context.newPage();
        attachConsoleGuard(page);
    }

    @Override
    public void afterEach(ExtensionContext ctx) {
        // consoleGuard assertion FIRST, then teardown (in finally so the context always closes).
        try {
            if (consoleGuardViolations != null && !consoleGuardViolations.isEmpty()) {
                throw new AssertionError(
                        "consoleGuard caught silent failures:\n" + String.join("\n", consoleGuardViolations));
            }
        } finally {
            if (context != null) context.close();
            context = null;
            page = null;
            consoleGuardViolations = null;
        }
    }

    /**
     * Auto-guard for every UI test: a {@code console.error} or any HTTP response with status
     * &ge; 500 on the fixture-managed page is collected here and asserted empty in
     * {@link #afterEach}. Silent JS errors and broken XHRs are signals the assertions alone
     * would miss. Mirrors the TypeScript template's {@code consoleGuard} auto-fixture.
     */
    private void attachConsoleGuard(Page p) {
        consoleGuardViolations = new ArrayList<>();
        p.onConsoleMessage((ConsoleMessage msg) -> {
            if ("error".equals(msg.type()) && !consoleGuardAllowed(msg.text())) {
                consoleGuardViolations.add("console.error: " + msg.text());
            }
        });
        p.onResponse((Response res) -> {
            if (res.status() >= 500 && !consoleGuardAllowed(res.url())) {
                consoleGuardViolations.add(
                        "HTTP " + res.status() + ": " + res.request().method() + " " + res.url());
            }
        });
    }

    private boolean consoleGuardAllowed(String text) {
        for (Pattern allow : consoleGuardAllow) {
            if (allow.matcher(text).find()) return true;
        }
        return false;
    }

    /**
     * Known-noise patterns the console guard ignores (3rd-party scripts, expected 401 probes,
     * favicons). Empty by default; override to extend. Each pattern is matched with
     * {@link java.util.regex.Matcher#find()} against the console text / response URL.
     *
     * <p>ADAPT-ME: allowlist only real, understood noise — never silence a genuine defect.
     */
    protected List<Pattern> consoleGuardAllowlist() {
        return List.of(
                // Pattern.compile("favicon\\.ico"),
        );
    }

    @Override
    public void afterAll(ExtensionContext ctx) {
        if (browser != null) browser.close();
        if (playwright != null) playwright.close();
    }

    @Override
    public boolean supportsParameter(ParameterContext pc, ExtensionContext ec) {
        Class<?> t = pc.getParameter().getType();
        return t == Page.class || t == BrowserContext.class || t == Browser.class;
    }

    @Override
    public Object resolveParameter(ParameterContext pc, ExtensionContext ec) {
        Class<?> t = pc.getParameter().getType();
        if (t == Page.class) return page;
        if (t == BrowserContext.class) return context;
        if (t == Browser.class) return browser;
        throw new ParameterResolutionException("PlaywrightFixture cannot resolve " + t);
    }
}
