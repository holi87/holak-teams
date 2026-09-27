package qa.security;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.ApiClient;
import qa.support.argus.ArgusPrerequisiteError;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.anyOf;
import static org.hamcrest.Matchers.is;

/**
 * @security lane — behind an explicit clearance so authz / IDOR / broken-access-control checks
 * never run by accident against an environment that hasn't been cleared for them.
 *
 * <p>The lane runs only when {@code solution/test-lanes.tsv} enables it, and then every case
 * requires {@code SECURITY_ENABLED=1}: any other value is reported through
 * {@link ArgusPrerequisiteError} as {@code prerequisite-missing}; the test never skips itself.
 * The checks below are role × operation DENY assertions — a principal that should NOT be able
 * to perform an operation must be refused (401/403). ADAPT-ME: replace the placeholder routes
 * with the real protected surface from recon + the OpenAPI / threat model.
 */
@Tag("security")
class AccessSmokeTest {

    private final ApiClient api = new ApiClient();

    @BeforeEach
    void environment_is_cleared_for_security_checks() {
        if (!"1".equals(ArgusPrerequisiteError.requireEnv("SECURITY_ENABLED"))) {
            throw new ArgusPrerequisiteError("SECURITY_ENABLED must be 1 once the target is cleared");
        }
    }

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
