package qa.support;

import java.util.Map;

/**
 * Central config for the target app — the SINGLE source of URLs and accounts.
 * Fill in at the start of an engagement from Kalchas's recon. Tests never read
 * {@code System.getenv} directly; they go through here.
 *
 * <p>Env overrides (all optional, sane localhost defaults):
 * {@code API_URL}, {@code UI_URL}, {@code HELPER_URL},
 * {@code ADMIN_USER}/{@code ADMIN_PASS}, {@code USER_USER}/{@code USER_PASS}.
 */
public final class Config {

    private Config() {}

    /** A seeded test account / role. ADAPT-ME: replace with the real seeded users. */
    public record Account(String username, String password) {}

    public static String apiUrl()    { return env("API_URL", "http://localhost:3001"); }
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

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }
}
