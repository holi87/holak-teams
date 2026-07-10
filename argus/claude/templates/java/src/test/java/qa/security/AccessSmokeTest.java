package qa.security;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import qa.support.ApiClient;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.anyOf;
import static org.hamcrest.Matchers.is;

/**
 * @security lane — GATED behind an explicit opt-in so authz / IDOR / broken-access-control
 * checks never run by accident against an environment that hasn't been cleared for them.
 *
 * <p>Skipped unless {@code SECURITY_ENABLED=1}: an unset run shows it SKIPPED, exit stays 0.
 * The checks below are role × operation DENY assertions — a principal that should NOT be able
 * to perform an operation must be refused (401/403). ADAPT-ME: replace the placeholder routes
 * with the real protected surface from recon + the OpenAPI / threat model.
 */
@Tag("security")
@EnabledIfEnvironmentVariable(named = "SECURITY_ENABLED", matches = "1")
class AccessSmokeTest {

    private final ApiClient api = new ApiClient();

    @Test
    void anonymous_is_denied_a_protected_route() {
        given().spec(api.anon())
                .when().get(ApiClient.ME) // <-- adapt: a real protected route from recon
                .then().statusCode(anyOf(is(401), is(403)));
    }

    @Test
    void non_admin_role_is_denied_an_admin_only_operation() {
        // A normal user must not be able to perform an admin-scoped operation.
        given().spec(api.apiAs("user"))
                .when().delete("/admin/users/1") // <-- adapt: a real admin-only operation
                .then().statusCode(anyOf(is(401), is(403)));
    }
}
