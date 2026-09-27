package qa.support;

import io.restassured.specification.RequestSpecification;
import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ExtensionContext.Namespace;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolutionException;
import org.junit.jupiter.api.extension.ParameterResolver;
import qa.support.argus.ArgusCleanupError;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Set;

import static io.restassured.RestAssured.given;

/**
 * Teardown cleanup for data a test creates through the API — use it when the app ships no
 * reset command (solution/environment.tsv); never rely on accumulating unique data alone.
 * The Java port of the TypeScript template's {@code createdResources} fixture.
 *
 * <pre>{@code
 * @ExtendWith(CreatedResources.class)
 * class OrdersApiTest {
 *     @Test
 *     void create_with_valid_data_succeeds(CreatedResources created) {
 *         RequestSpecification user = api.apiAs("user");
 *         String id = given().spec(user).contentType(JSON).body(order().build())
 *                 .when().post(ApiClient.ORDERS).then().statusCode(201).extract().path("id");
 *         created.register(user, ApiClient.ORDERS + "/" + id);
 *     }
 * }
 * }</pre>
 *
 * <p>Declare the parameter on the test method or on a {@code @BeforeEach} method; each test
 * gets its own registry. {@code afterEach} DELETEs every registered resource through the
 * spec it was created with, newest first, and attempts each one even after a failure. A
 * status outside 200/202/204/404 or any exception counts as a failure, and the test then
 * fails with {@link ArgusCleanupError} ({@code automation fail cleanup-failed}); when the
 * body already failed, JUnit attaches it as a suppressed error and the outcome listener adds
 * a secondary {@code <case>.cleanup} event. The message names only the count, never a path,
 * a status, or a body.
 *
 * <p>In a counterfactual evidence pass the DELETE goes to the stub like every other call, so
 * the fixture of a regression that registers resources records those exchanges too.
 */
public final class CreatedResources implements ParameterResolver, AfterEachCallback {

    /** A DELETE that answers one of these removed the resource or found it already gone. */
    private static final Set<Integer> CLEANUP_STATUSES = Set.of(200, 202, 204, 404);
    private static final Namespace NAMESPACE = Namespace.create(CreatedResources.class);
    private static final String REGISTRY = "registry";

    private record Resource(RequestSpecification spec, String path) {}

    private final List<Resource> resources = new ArrayList<>();

    /**
     * Queues {@code path} (relative to the spec's base URI, e.g. {@code /orders/42}) for a
     * DELETE through {@code spec} after the test; register right after a successful create.
     */
    public synchronized void register(RequestSpecification spec, String path) {
        Objects.requireNonNull(spec, "spec");
        if (path == null || !path.startsWith("/")) {
            throw new IllegalArgumentException("a created resource path must start with '/', relative to the spec's base URI");
        }
        resources.add(new Resource(spec, path));
    }

    /** How many resources are queued for cleanup. */
    public synchronized int size() {
        return resources.size();
    }

    /**
     * DELETEs every queued resource, newest first, and empties the queue. Throws
     * {@link ArgusCleanupError} naming the number of failed deletions.
     */
    public void cleanup() {
        List<Resource> pending;
        synchronized (this) {
            pending = new ArrayList<>(resources);
            resources.clear();
        }
        Collections.reverse(pending);
        int failures = 0;
        for (Resource resource : pending) {
            try {
                int status = given().spec(resource.spec()).when().delete(resource.path()).statusCode();
                if (!CLEANUP_STATUSES.contains(status)) failures++;
            } catch (Exception error) {
                failures++;
            }
        }
        if (failures > 0) throw new ArgusCleanupError("cleanup failed for " + failures + " resource(s)");
    }

    @Override
    public boolean supportsParameter(ParameterContext parameter, ExtensionContext context) {
        return parameter.getParameter().getType() == CreatedResources.class;
    }

    @Override
    public Object resolveParameter(ParameterContext parameter, ExtensionContext context) {
        if (context.getTestMethod().isEmpty()) {
            throw new ParameterResolutionException(
                    "CreatedResources is per test: declare it on the test method or a @BeforeEach method");
        }
        return context.getStore(NAMESPACE).getOrComputeIfAbsent(REGISTRY, key -> new CreatedResources(), CreatedResources.class);
    }

    @Override
    public void afterEach(ExtensionContext context) {
        CreatedResources registry = context.getStore(NAMESPACE).remove(REGISTRY, CreatedResources.class);
        if (registry != null) registry.cleanup();
    }
}
