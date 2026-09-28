package qa.support.argus;

import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ExtensionContext.Namespace;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolutionException;
import org.junit.jupiter.api.extension.ParameterResolver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * Fault injection for the resilience lane (TEMPLATE-CONTRACT.md, RUNNER-CONTRACT.md SD-5), the
 * Java port of the TypeScript template's {@code src/argus/fault-injector.ts}. A fault is
 * injected only around one body and always restored afterwards:
 *
 * <ol>
 *   <li>A {@link Scope#SERVER} fault changes the shared target, so it needs the caller's
 *       explicit {@code ARGUS_FAULT_INJECTION=authorized}; anything else throws
 *       {@link ArgusPrerequisiteError} before anything is injected. Inside an engagement
 *       ({@link #insideEngagement()}) that value is only a request: the fault also needs
 *       {@code ARGUS_FAULT_INJECTION_GRANT}, which {@code scripts/runner-lib.sh} sets only after
 *       the chaos grant and the exclusive fault window. A {@link Scope#CLIENT} fault stays
 *       inside the test process ({@code page.route}, a stub) and needs no grant.</li>
 *   <li>The restore is recorded before {@code inject} runs, so a partial injection is undone
 *       too.</li>
 *   <li>{@code restore} runs in every case, then {@code verifyRestored} proves the target is
 *       back to normal. A failure in either throws {@link ArgusRestoreError}
 *       ({@code infrastructure fail fault-restore-failed}): the environment is in an unknown
 *       state and the run must stop trusting it. That error outranks an error of the body,
 *       which it carries as a suppressed exception.</li>
 * </ol>
 *
 * <p>Use the static {@link #run(Fault, Body)}, or declare a {@code FaultInjector} parameter
 * under {@code @ExtendWith(FaultInjector.class)}: its {@code afterEach} restores whatever
 * fault a test left active. {@link #active()} is true while any fault's restore is pending,
 * so the UI console guard ignores the fault's intended effects. Messages carry only the
 * fault name, never target data.
 */
public final class FaultInjector implements ParameterResolver, AfterEachCallback {

    /** {@code CLIENT} stays inside the test process; {@code SERVER} changes the target. */
    public enum Scope { CLIENT, SERVER }

    /** A fault hook; it may throw anything. */
    @FunctionalInterface
    public interface Step {
        void run() throws Exception;
    }

    /** The body that runs while the fault is active. */
    @FunctionalInterface
    public interface Body<T> {
        T call() throws Exception;
    }

    /**
     * One fault: a safe token {@code name} (for example {@code api-unavailable}), its scope,
     * and the inject/restore/verify hooks. {@code verifyRestored} throws when the target still
     * shows the fault after {@code restore}.
     */
    public record Fault(String name, Scope scope, Step inject, Step restore, Step verifyRestored) {
        public Fault {
            if (name == null || !FAULT_NAME.matcher(name).matches()) {
                throw new IllegalArgumentException("a fault name must be a lowercase token such as api-unavailable");
            }
            if (scope == null) throw new IllegalArgumentException("fault " + name + ": scope must be CLIENT or SERVER");
            if (inject == null || restore == null || verifyRestored == null) {
                throw new IllegalArgumentException("fault " + name + ": inject, restore and verifyRestored are required");
            }
        }
    }

    private static final Pattern FAULT_NAME = Pattern.compile("^[a-z0-9][a-z0-9-]{0,63}$");
    private static final Pattern LANE = Pattern.compile("^[a-z][a-z0-9-]*$");
    private static final Namespace NAMESPACE = Namespace.create(FaultInjector.class);
    private static final String INJECTOR = "injector";
    private static final AtomicInteger ACTIVE = new AtomicInteger();

    /** One recorded fault; restored and verified exactly once. */
    private static final class Recorded {
        private final Fault fault;
        private boolean restored;
        private ArgusRestoreError failure;

        private Recorded(Fault fault) {
            this.fault = fault;
        }
    }

    private final Set<Recorded> recorded = new LinkedHashSet<>();

    /** True while any fault in this JVM has been recorded and its restore is not yet verified. */
    public static boolean active() {
        return ACTIVE.get() > 0;
    }

    /** Injects {@code fault} around {@code body} and always restores it; see the class comment. */
    public static <T> T run(Fault fault, Body<T> body) throws Exception {
        return new FaultInjector().inject(fault, body);
    }

    /** As {@link #run(Fault, Body)} for a body without a result. */
    public static void run(Fault fault, Step body) throws Exception {
        new FaultInjector().inject(fault, () -> {
            body.run();
            return null;
        });
    }

    /** Whether one of this injector's faults is still waiting for its verified restore. */
    public synchronized boolean pending() {
        return !recorded.isEmpty();
    }

    /** The instance form of {@link #run(Fault, Body)}; {@link #settle()} restores what it leaves active. */
    public <T> T inject(Fault fault, Body<T> body) throws Exception {
        Objects.requireNonNull(fault, "fault");
        Objects.requireNonNull(body, "body");
        if (fault.scope() == Scope.SERVER) requireServerAuthorization(fault.name());
        Recorded entry = record(fault);
        T value;
        try {
            fault.inject().run();
            value = body.call();
        } catch (Throwable error) {
            try {
                restore(entry);
            } catch (ArgusRestoreError restoreFailure) {
                restoreFailure.addSuppressed(error);
                throw restoreFailure;
            }
            throw error;
        }
        restore(entry);
        return value;
    }

    /** As {@link #inject(Fault, Body)} for a body without a result. */
    public void inject(Fault fault, Step body) throws Exception {
        inject(fault, () -> {
            body.run();
            return null;
        });
    }

    /** Restores and verifies every fault still recorded, for example one a test abandoned. */
    public void settle() {
        List<Recorded> pending;
        synchronized (this) {
            pending = new ArrayList<>(recorded);
        }
        ArgusRestoreError first = null;
        for (Recorded entry : pending) {
            try {
                restore(entry);
            } catch (ArgusRestoreError failure) {
                if (first == null) first = failure;
            }
        }
        if (first != null) throw first;
    }

    @Override
    public boolean supportsParameter(ParameterContext parameter, ExtensionContext context) {
        return parameter.getParameter().getType() == FaultInjector.class;
    }

    @Override
    public Object resolveParameter(ParameterContext parameter, ExtensionContext context) {
        if (context.getTestMethod().isEmpty()) {
            throw new ParameterResolutionException(
                    "FaultInjector is per test: declare it on the test method or a @BeforeEach method");
        }
        return context.getStore(NAMESPACE).getOrComputeIfAbsent(INJECTOR, key -> new FaultInjector(), FaultInjector.class);
    }

    @Override
    public void afterEach(ExtensionContext context) {
        FaultInjector injector = context.getStore(NAMESPACE).remove(INJECTOR, FaultInjector.class);
        if (injector != null) injector.settle();
    }

    private synchronized Recorded record(Fault fault) {
        Recorded entry = new Recorded(fault);
        recorded.add(entry);
        ACTIVE.incrementAndGet();
        return entry;
    }

    // Each recorded fault is restored exactly once, whether inject() or settle() gets there
    // first; a later caller sees the same outcome.
    private void restore(Recorded entry) {
        synchronized (entry) {
            if (!entry.restored) {
                entry.restored = true;
                try {
                    entry.failure = restoreAndVerify(entry.fault);
                } finally {
                    synchronized (this) {
                        recorded.remove(entry);
                    }
                    ACTIVE.decrementAndGet();
                }
            }
            if (entry.failure != null) throw entry.failure;
        }
    }

    // A hook that throws an exception or an assertion is a failed restore; a JVM error still
    // propagates as itself.
    private static ArgusRestoreError restoreAndVerify(Fault fault) {
        try {
            fault.restore().run();
        } catch (Exception | AssertionError error) {
            return new ArgusRestoreError("fault " + fault.name() + ": restore failed", error);
        }
        try {
            fault.verifyRestored().run();
        } catch (Exception | AssertionError error) {
            return new ArgusRestoreError("fault " + fault.name() + ": the restore could not be verified", error);
        }
        return null;
    }

    private static void requireServerAuthorization(String name) {
        if (!"authorized".equals(ArgusPrerequisiteError.requireEnv("ARGUS_FAULT_INJECTION"))) {
            throw new ArgusPrerequisiteError("server-side fault " + name + " requires ARGUS_FAULT_INJECTION=authorized");
        }
        String grant = System.getenv("ARGUS_FAULT_INJECTION_GRANT");
        if (insideEngagement() && (grant == null || !LANE.matcher(grant).matches())) {
            throw new ArgusPrerequisiteError("server-side fault " + name + " inside an Argus engagement requires the grant"
                    + " scripts/runner-lib.sh issues after the chaos authorization; run it through run-tests.sh");
        }
    }

    /**
     * Whether this run belongs to an Argus engagement: {@code ARGUS_ENGAGEMENT_MANIFEST} is set, or
     * an {@code ai_agents_internal/engagement.json} sits in the working directory (the Maven
     * basedir) or an ancestor, as {@code argus-assets} finds one.
     */
    public static boolean insideEngagement() {
        String manifest = System.getenv("ARGUS_ENGAGEMENT_MANIFEST");
        if (manifest != null && !manifest.isEmpty()) return true;
        for (Path cursor = ArgusEvents.root(); cursor != null; cursor = cursor.getParent()) {
            if (Files.exists(cursor.resolve("ai_agents_internal").resolve("engagement.json"))) return true;
        }
        return false;
    }
}
