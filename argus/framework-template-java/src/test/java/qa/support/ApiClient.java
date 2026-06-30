package qa.support;

import io.restassured.builder.RequestSpecBuilder;
import io.restassured.response.ExtractableResponse;
import io.restassured.response.Response;
import io.restassured.specification.RequestSpecification;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static io.restassured.RestAssured.given;
import static io.restassured.http.ContentType.JSON;

/**
 * REST Assured request specs for the API/contract lane.
 *
 * <ul>
 *   <li><b>Endpoint paths live in ONE place</b> (the constants below) — specs reference
 *       {@code ApiClient.ORDERS}, never a raw literal scattered across files.</li>
 *   <li>{@link #anon()} — base spec, no auth.</li>
 *   <li>{@link #apiAs(String)} — base spec + a {@code Bearer} token for a role; the token
 *       is fetched ONCE per role and cached (one login, not one-per-test).</li>
 * </ul>
 *
 * ADAPT-ME: rename/extend the path constants per the real OpenAPI surface and adapt
 * {@link #login(String)} to the app's real auth (token field / header scheme).
 */
public class ApiClient {

    // ── Endpoint paths — the ONE place they are defined ──────────────────────
    public static final String LOGIN  = "/auth/login"; // <-- adapt
    public static final String HEALTH = "/health";     // <-- adapt
    public static final String ME     = "/me";         // <-- adapt
    public static final String ORDERS = "/orders";     // <-- adapt

    /** One token per role, shared across tests in the JVM (single reused fork). */
    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();

    /** Anonymous request spec (no Authorization header). */
    public RequestSpecification anon() {
        return new RequestSpecBuilder()
                .setBaseUri(Config.apiUrl())
                .build();
    }

    /** Authenticated request spec for a role — {@code Bearer <token>}. */
    public RequestSpecification apiAs(String role) {
        String token = TOKENS.computeIfAbsent(role, this::login);
        return new RequestSpecBuilder()
                .setBaseUri(Config.apiUrl())
                .addHeader("Authorization", "Bearer " + token) // <-- adapt scheme
                .build();
    }

    // Adapt the login flow to the app's real auth (token/JWT/session). Discover it from OpenAPI.
    private String login(String role) {
        Config.Account acc = Config.account(role);
        ExtractableResponse<Response> res = given()
                .baseUri(Config.apiUrl())
                .contentType(JSON)
                .body(Map.of("username", acc.username(), "password", acc.password())) // <-- adapt payload
                .when()
                .post(LOGIN)
                .then()
                .extract();

        if (res.statusCode() >= 400) {
            throw new IllegalStateException(
                    "login(" + role + ") failed: " + res.statusCode() + " " + res.asString());
        }
        String token = res.path("token");                    // <-- adapt token field
        if (token == null) token = res.path("accessToken");
        if (token == null) {
            throw new IllegalStateException(
                    "login(" + role + "): no token field in response — adapt ApiClient.login(): " + res.asString());
        }
        return token;
    }
}
