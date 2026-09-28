package qa.support.oracles;

import io.restassured.response.Response;
import qa.support.oracles.Http.RestState;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * State-transition oracles, the Java port of state.ts. A delete that answers correctly but
 * leaves the resource readable, listed, or able to log in is a soft-delete defect: the
 * product forgot one of the places the resource lives. A RED throws {@link AssertionError};
 * misuse throws {@link IllegalArgumentException}.
 */
public final class State {

    /** Returns the ids one collection serves right now (every page of it, see {@link Pagination}). */
    @FunctionalInterface
    public interface IdList {
        Collection<?> ids();
    }

    /**
     * What the sweep observed: the delete status, the read-back status, how many lists were
     * checked, and the login status (null without a login attempt).
     */
    public record SweepReport(Object id, int deleteStatus, int readStatus, int listsChecked, Integer loginStatus) {}

    private State() {}

    public static SweepReport softDeleteSweep(Object id, Supplier<Response> deleteResource, Supplier<Response> getById, List<IdList> listIds) {
        return softDeleteSweep(id, deleteResource, getById, listIds, null, RestState.DELETED);
    }

    /**
     * Deletes one resource and sweeps every place it can still live, in this order:
     * {@code deleteResource} must answer {@code expectedDeleteState} (see
     * {@link Http#assertRestStatus}; the default DELETED is 204 with an empty body),
     * {@code getById} must answer 404, every {@code listIds} collection must exclude
     * {@code id}, and {@code loginAttempt}, when given (a deleted user), must answer 401. Every
     * step runs even after an earlier one failed, and the RED lists every failed step. An id
     * matches a listed id by its decimal or string form, so 42 and "42" both count as still
     * listed: a type mismatch never hides a leftover.
     */
    public static SweepReport softDeleteSweep(Object id, Supplier<Response> deleteResource, Supplier<Response> getById, List<IdList> listIds,
                                              Supplier<Response> loginAttempt, RestState expectedDeleteState) {
        if (id == null || "".equals(id)) throw new IllegalArgumentException("softDeleteSweep: id must be the deleted resource's id");
        if (deleteResource == null || getById == null) throw new IllegalArgumentException("softDeleteSweep: deleteResource and getById must not be null");
        if (listIds == null || listIds.isEmpty() || listIds.stream().anyMatch(Objects::isNull)) {
            throw new IllegalArgumentException("softDeleteSweep: listIds must name every collection that can serve the resource (at least one)");
        }
        if (expectedDeleteState == null) throw new IllegalArgumentException("softDeleteSweep: expectedDeleteState must not be null");
        String key = key(id, "id");
        List<String> problems = new ArrayList<>();
        Response deleted = respond(deleteResource, "deleteResource");
        check(problems, "delete", () -> Http.assertRestStatus(deleted, expectedDeleteState));
        Response read = respond(getById, "getById");
        check(problems, "read-back", () -> Http.assertRestStatus(read, RestState.MISSING));
        for (int index = 0; index < listIds.size(); index++) {
            Collection<?> served = listIds.get(index).ids();
            if (served == null) throw new IllegalArgumentException("softDeleteSweep: list " + (index + 1) + " returned null instead of its ids");
            int list = index + 1;
            if (served.stream().anyMatch(listed -> listed != null && key.equals(key(listed, "list " + list + " id")))) {
                problems.add("list " + list + ": still serves the deleted id");
            }
        }
        Integer loginStatus = null;
        if (loginAttempt != null) {
            Response login = respond(loginAttempt, "loginAttempt");
            loginStatus = login.statusCode();
            check(problems, "login", () -> Http.assertRestStatus(login, RestState.UNAUTHENTICATED));
        }
        if (!problems.isEmpty()) {
            throw new AssertionError("softDeleteSweep " + Http.excerpt(String.valueOf(id)) + ": the resource survived its delete\n  - "
                    + String.join("\n  - ", problems));
        }
        return new SweepReport(id, deleted.statusCode(), read.statusCode(), listIds.size(), loginStatus);
    }

    private static Response respond(Supplier<Response> call, String label) {
        Response response = call.get();
        if (response == null) throw new IllegalArgumentException("softDeleteSweep: " + label + " returned null instead of a response");
        return response;
    }

    /** Runs one step and records its RED instead of stopping the sweep. */
    private static void check(List<String> problems, String step, Runnable assertion) {
        try {
            assertion.run();
        } catch (AssertionError red) {
            problems.add(step + ": " + red.getMessage());
        }
    }

    /** A string id is itself; a number is its plain decimal form, so 42, 42L, 42.0 and "42" match. */
    private static String key(Object id, String label) {
        if (id instanceof String text) return text;
        if (id instanceof BigDecimal decimal) return Boundary.normalize(decimal).toPlainString();
        if (id instanceof Double || id instanceof Float) {
            double value = ((Number) id).doubleValue();
            if (!Double.isFinite(value)) throw new IllegalArgumentException("softDeleteSweep: " + label + " must be finite, got " + value);
            return Boundary.normalize(BigDecimal.valueOf(value)).toPlainString();
        }
        if (id instanceof Integer || id instanceof Long || id instanceof Short || id instanceof Byte || id instanceof BigInteger) return id.toString();
        throw new IllegalArgumentException("softDeleteSweep: " + label + " must be a string or a number, got " + id.getClass().getSimpleName());
    }
}
