package qa.support;

import qa.support.argus.ArgusCounterfactualExtension;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Map;

/**
 * Central config for the target app — the SINGLE source of URLs and accounts.
 * Fill in at the start of an engagement from Kalchas's recon. Tests never read
 * {@code System.getenv} directly; they go through here.
 *
 * <p>Env overrides (all optional, sane localhost defaults):
 * {@code API_URL}, {@code UI_URL}, {@code HELPER_URL},
 * {@code ADMIN_USER}/{@code ADMIN_PASS}, {@code USER_USER}/{@code USER_PASS}.
 *
 * <p>During a counterfactual evidence pass ({@code ARGUS_EVIDENCE_PASS=cf-*}) {@link #apiUrl()}
 * answers with the per-test loopback stub that {@code ArgusCounterfactualExtension} loaded, so
 * no API test reaches the real target; {@link #targetApiUrl()} always stays the real one.
 */
public final class Config {

    private Config() {}

    /** A seeded test account / role. ADAPT-ME: replace with the real seeded users. */
    public record Account(String username, String password) {}

    /** The API tests call: the counterfactual stub during a {@code cf-*} pass, else {@link #targetApiUrl()}. */
    public static String apiUrl() {
        String stub = counterfactualApiUrl();
        return stub != null ? stub : targetApiUrl();
    }

    /** The real target API; the UI lane routes this origin to the stub during a {@code cf-*} pass. */
    public static String targetApiUrl() { return env("API_URL", "http://localhost:3001"); }
    public static String uiUrl()     { return env("UI_URL", "http://localhost:3000"); }
    public static String helperUrl() { return env("HELPER_URL", "http://localhost:3002"); }

    // Test accounts — replace with the real seeded accounts/roles from the docs.
    private static final Map<String, Account> ACCOUNTS = Map.of(
            "admin", new Account(env("ADMIN_USER", "admin@example.com"), env("ADMIN_PASS", "CHANGE_ME")),
            "user",  new Account(env("USER_USER", "user@example.com"),   env("USER_PASS", "CHANGE_ME"))
    );

    /** Look up a role's account; throws on an unknown role (typo guard). */
    public static Account account(String role) {
        Account a = ACCOUNTS.get(role);
        if (a == null) {
            throw new IllegalArgumentException("unknown role '" + role + "' — known roles: " + ACCOUNTS.keySet());
        }
        return a;
    }

    /**
     * The stub URL for the current test, honoured only while {@code ARGUS_EVIDENCE_PASS} starts
     * with {@code cf-} and only for {@code http://127.0.0.1}, so a stray property can never
     * redirect a live run or point a counterfactual pass at another host.
     */
    private static String counterfactualApiUrl() {
        String pass = System.getenv("ARGUS_EVIDENCE_PASS");
        String url = System.getProperty(ArgusCounterfactualExtension.API_URL_PROPERTY);
        if (pass == null || !pass.startsWith("cf-") || url == null) return null;
        try {
            URI uri = new URI(url);
            return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) ? url : null;
        } catch (URISyntaxException malformed) {
            return null;
        }
    }

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }
}
