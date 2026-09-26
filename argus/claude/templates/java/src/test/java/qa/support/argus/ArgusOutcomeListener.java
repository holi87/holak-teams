package qa.support.argus;

import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Argus outcome adapter for the JUnit Platform (RUNNER-CONTRACT.md SD-1, SD-5, SD-6).
 *
 * <p>Registered through {@code META-INF/services/org.junit.platform.launcher.TestExecutionListener}
 * next to {@code SummaryListener}. It is inert unless {@code scripts/runner-lib.sh} exports
 * {@code ARGUS_RUNNER_MODE}, and inert in a collect-only pass ({@code ARGUS_INVENTORY_ONLY=1},
 * whose inventory {@link ArgusInventory} writes). When active it emits one event per test
 * through {@link ArgusEvents}, classified from the exception type, never from message text,
 * and finishes each native run by writing {@code reports/argus-adapter-status.txt}.
 *
 * <p>This version maps the {@code live} and {@code repeat} evidence passes. Any other
 * {@code ARGUS_EVIDENCE_PASS} fails closed as an adapter error rather than being reported as
 * a live run.
 */
public class ArgusOutcomeListener implements TestExecutionListener {

    private enum Kind { PASSED, ASSERTION, SKIPPED, OTHER }

    private record Outcome(Kind kind, String category, String reason) {
        static final Outcome PASSED = new Outcome(Kind.PASSED, "product", "passed");
        static final Outcome ASSERTION = new Outcome(Kind.ASSERTION, "product", "assertion-failed");
        static final Outcome SKIPPED = new Outcome(Kind.SKIPPED, "skip", "test-skipped");

        static Outcome fail(String category, String reason) {
            return new Outcome(Kind.OTHER, category, reason);
        }
    }

    private static final Set<String> TIMEOUTS = Set.of(
            "com.microsoft.playwright.TimeoutError",
            "java.util.concurrent.TimeoutException",
            "java.net.SocketTimeoutException",
            "org.awaitility.core.ConditionTimeoutException");
    private static final Set<String> PLAYWRIGHT = Set.of("com.microsoft.playwright.PlaywrightException");
    private static final Pattern REPETITION_VALUE = Pattern.compile("^[1-9][0-9]{0,2}$");
    private static final int MAX_REPETITION = 200;
    private static final int MAX_CHAIN = 64;

    private volatile boolean active;
    private volatile boolean broken;
    private String mode;
    private String pass;
    private String suffix;
    private TestPlan plan;
    private ArgusCaseIds ids;
    private ArgusLedger ledger;
    private ArgusEvents events;
    private final Set<String> reported = ConcurrentHashMap.newKeySet();

    @Override
    public void testPlanExecutionStarted(TestPlan testPlan) {
        Optional<String> runnerMode = ArgusEvents.activeMode();
        active = runnerMode.isPresent() && !"1".equals(System.getenv("ARGUS_INVENTORY_ONLY"));
        if (!active) return;
        mode = runnerMode.get();
        plan = testPlan;
        broken = false;
        reported.clear();
        events = new ArgusEvents(ArgusEvents.root());
        String requested = System.getenv("ARGUS_EVIDENCE_PASS");
        pass = requested == null || requested.isEmpty() ? "live" : requested;
        if (!pass.equals("live") && !pass.equals("repeat")) {
            abandon();
            return;
        }
        suffix = pass.equals("live") ? "" : "." + pass;
        try {
            ledger = ArgusLedger.load(ArgusEvents.root());
            ids = new ArgusCaseIds(testPlan);
        } catch (RuntimeException | LinkageError failed) {
            abandon();
        }
    }

    @Override
    public void executionSkipped(TestIdentifier identifier, String reason) {
        guard(() -> {
            if (ArgusCaseIds.isCase(identifier)) {
                emitCase(identifier, Outcome.SKIPPED, null);
                return;
            }
            // A skipped container is reported once; each test (or template) under it is a case.
            for (TestIdentifier descendant : plan.getDescendants(identifier)) {
                if (ArgusCaseIds.isCase(descendant)) emitCase(descendant, Outcome.SKIPPED, null);
            }
        });
    }

    @Override
    public void executionFinished(TestIdentifier identifier, TestExecutionResult result) {
        guard(() -> {
            if (identifier.isTest()) {
                Throwable throwable = result.getThrowable().orElse(null);
                emitCase(identifier, classify(result, throwable), throwable);
            } else if (result.getStatus() == TestExecutionResult.Status.FAILED) {
                // Children of a failed container never report; its id prefixes theirs.
                events.emit(ids.of(identifier) + suffix, "automation", "fail", false, "n/a", "-", "container-failed");
            } else if (result.getStatus() == TestExecutionResult.Status.ABORTED) {
                skipUnreported(identifier);
            }
        });
    }

    @Override
    public void testPlanExecutionFinished(TestPlan testPlan) {
        if (active) events.writeStatus();
    }

    private void emitCase(TestIdentifier identifier, Outcome outcome, Throwable throwable) {
        ArgusCaseIds.Markers markers = ArgusCaseIds.Markers.of(plan, identifier);
        String bug = regressionBug(markers);
        String caseId = ids.of(identifier) + suffix;
        reported.add(identifier.getUniqueId());
        switch (outcome.kind()) {
            case PASSED, ASSERTION -> emitProduct(caseId, markers, bug, outcome.kind() == Kind.PASSED);
            case SKIPPED -> {
                if (markers.regression()) events.emit(caseId, "policy", "denied", false, "n/a", bug, "regression-skipped");
                else events.emit(caseId, "skip", "skipped", false, "n/a", "-", "test-skipped");
            }
            case OTHER -> events.emit(caseId, outcome.category(), "fail", false, "n/a", bug, outcome.reason());
        }
        if (throwable != null && !outcome.reason().equals("cleanup-failed") && suppressesCleanup(throwable, Collections.newSetFromMap(new IdentityHashMap<>()))) {
            events.emit(caseId + ".cleanup", "automation", "fail", false, "n/a", bug, "cleanup-failed");
        }
    }

    /** SD-6 product events, including the intermittent-defect rules for a declared repetition. */
    private void emitProduct(String caseId, ArgusCaseIds.Markers markers, String bug, boolean passed) {
        if (bug.equals("-")) {
            events.emit(caseId, "product", passed ? "pass" : "fail", false, "n/a", "-", passed ? "passed" : "assertion-failed");
            return;
        }
        OptionalInt repetition = repetition(markers, bug);
        if (repetition.isEmpty()) {
            events.emit(caseId, "policy", "denied", false, "n/a", bug, "repetition-invalid");
        } else if (!mode.equals("defect-evidence")) {
            if (passed) events.emit(caseId, "product", "pass", false, "fixed", bug, "regression-green");
            else events.emit(caseId, "product", "fail", false, "automated", bug, "regression-red");
        } else if (!passed) {
            events.emit(caseId, "product", "fail", true, "reproduced", bug, pass.equals("live") ? "expected-red" : "expected-red-repeat");
        } else if (repetition.getAsInt() > 1) {
            events.emit(caseId, "product", "pass", false, "n/a", bug, "intermittent-unreproduced");
        } else if (pass.equals("live")) {
            events.emit(caseId, "product", "pass", true, "automated", bug, "expected-red-passed");
        } else {
            events.emit(caseId, "automation", "fail", false, "n/a", bug, "flaky-red");
        }
    }

    /**
     * The declared repetition n ({@code @Tag("repetition:<n>")}, absent means 1), or empty when
     * the declaration is invalid: not one integer in 1..200, above 1 for a deterministic entry,
     * or below the ledger's 95% bound for an intermittent one.
     */
    private OptionalInt repetition(ArgusCaseIds.Markers markers, String bug) {
        List<String> declared = markers.repetition();
        if (declared.size() > 1 || (declared.size() == 1 && !REPETITION_VALUE.matcher(declared.get(0)).matches())) return OptionalInt.empty();
        int n = declared.isEmpty() ? 1 : Integer.parseInt(declared.get(0));
        OptionalInt bound = ledger.repetitionBound(bug);
        boolean valid = n <= MAX_REPETITION && (bound.isEmpty() ? n == 1 : n >= bound.getAsInt());
        return valid ? OptionalInt.of(n) : OptionalInt.empty();
    }

    /** B for a regression test carrying exactly one provenance token that resolves, else {@code -}. */
    private String regressionBug(ArgusCaseIds.Markers markers) {
        if (!markers.regression() || markers.provenance().size() != 1) return "-";
        return ledger.resolve(markers.provenance().get(0)).orElse("-");
    }

    /** An aborted container: every case under it that never reported is a runtime skip. */
    private void skipUnreported(TestIdentifier container) {
        List<TestIdentifier> cases = new ArrayList<>();
        if (ArgusCaseIds.isCase(container)) cases.add(container);
        for (TestIdentifier descendant : plan.getDescendants(container)) {
            if (ArgusCaseIds.isCase(descendant)) cases.add(descendant);
        }
        for (TestIdentifier candidate : cases) {
            boolean covered = reported.contains(candidate.getUniqueId())
                    || plan.getDescendants(candidate).stream().anyMatch(child -> reported.contains(child.getUniqueId()));
            if (!covered) emitCase(candidate, Outcome.SKIPPED, null);
        }
    }

    /** SD-5 primary classification of a finished test. */
    private static Outcome classify(TestExecutionResult result, Throwable throwable) {
        switch (result.getStatus()) {
            case SUCCESSFUL: return Outcome.PASSED;
            case ABORTED: return Outcome.SKIPPED;
            default: break;
        }
        if (throwable == null) return Outcome.fail("automation", "uncaught-error");
        List<Throwable> chain = chain(throwable);
        for (Throwable cause : chain) {
            if (cause instanceof ArgusCleanupError) return Outcome.fail("automation", "cleanup-failed");
            if (cause instanceof ArgusPrerequisiteError) return Outcome.fail("infrastructure", "prerequisite-missing");
            if (cause instanceof ArgusRestoreError) return Outcome.fail("infrastructure", "fault-restore-failed");
            if (cause instanceof ArgusCounterfactualError) return Outcome.fail("automation", "counterfactual-unmatched-request");
        }
        if (throwable instanceof AssertionError) return Outcome.ASSERTION;
        if (chain.stream().anyMatch(cause -> cause instanceof ConnectException || cause instanceof UnknownHostException || cause instanceof NoRouteToHostException)) {
            return Outcome.fail("infrastructure", "target-unreachable");
        }
        if (chain.stream().anyMatch(cause -> named(cause, TIMEOUTS))) return Outcome.fail("automation", "test-timeout");
        if (chain.stream().anyMatch(cause -> cause instanceof InterruptedException)) return Outcome.fail("infrastructure", "test-interrupted");
        if (chain.stream().anyMatch(cause -> named(cause, PLAYWRIGHT))) return Outcome.fail("automation", "playwright-api-failed");
        return Outcome.fail("automation", "uncaught-error");
    }

    /** Matches by class name through the superclass chain, so optional libraries stay optional. */
    private static boolean named(Throwable throwable, Set<String> names) {
        for (Class<?> type = throwable.getClass(); type != null; type = type.getSuperclass()) {
            if (names.contains(type.getName())) return true;
        }
        return false;
    }

    private static List<Throwable> chain(Throwable throwable) {
        List<Throwable> chain = new ArrayList<>();
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Throwable cursor = throwable; cursor != null && chain.size() < MAX_CHAIN && seen.add(cursor); cursor = cursor.getCause()) {
            chain.add(cursor);
        }
        return chain;
    }

    /** A teardown ArgusCleanupError that JUnit attached to a different primary failure. */
    private static boolean suppressesCleanup(Throwable throwable, Set<Throwable> seen) {
        if (!seen.add(throwable) || seen.size() > MAX_CHAIN) return false;
        for (Throwable suppressed : throwable.getSuppressed()) {
            if (chain(suppressed).stream().anyMatch(cause -> cause instanceof ArgusCleanupError) || suppressesCleanup(suppressed, seen)) return true;
        }
        return false;
    }

    private void guard(Runnable action) {
        if (!active || broken) return;
        try {
            action.run();
        } catch (RuntimeException | LinkageError failed) {
            events.recordFailure();
        }
    }

    private void abandon() {
        broken = true;
        events.recordFailure();
    }
}
