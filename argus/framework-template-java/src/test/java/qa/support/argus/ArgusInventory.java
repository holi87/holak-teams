package qa.support.argus;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.platform.commons.support.AnnotationSupport;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherFactory;

import java.io.IOException;
import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClasspathRoots;
import static org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder.request;

/**
 * Collect-only inventory pass (RUNNER-CONTRACT.md SD-3, SD-4, TEMPLATE-CONTRACT.md SD-10). Run
 * after test-compile with
 *
 * <pre>
 * mvn -q -B -ntp org.codehaus.mojo:exec-maven-plugin:3.1.1:java \
 *   -Dexec.mainClass=qa.support.argus.ArgusInventory -Dexec.classpathScope=test
 * </pre>
 *
 * <p>It discovers {@code target/test-classes} through the JUnit Platform Launcher, executes no
 * test, and atomically writes {@code reports/test-inventory.tsv} (one row per test and per
 * test-template or test-factory method), {@code reports/expected-bugs.txt}, and
 * {@code reports/counterfactual-plan.tsv} (one {@link Counterfactual} row per expected bug,
 * empty when there is none; only the evidence gate turns it into events). The inventory
 * is the full collection: no tag, lane, or Surefire include filter narrows it, so a test that
 * native selection would silently drop still shows up as not executed. Ledger problems are
 * reported as SD-4 events. Any failure throws, which exits Maven non-zero.
 */
public final class ArgusInventory {

    public static final String INVENTORY = "reports/test-inventory.tsv";
    public static final String EXPECTED_BUGS = "reports/expected-bugs.txt";

    private static final String CONDITION_PACKAGE = "org.junit.jupiter.api.condition";

    private ArgusInventory() {}

    public static void main(String[] args) throws IOException {
        Path root = ArgusEvents.root();
        String mode = ArgusEvents.activeMode().orElseThrow(() -> new IllegalStateException(
                "ArgusInventory: ARGUS_RUNNER_MODE must be one of " + new TreeSet<>(ArgusEvents.MODES)));
        Path classes = root.resolve("target").resolve("test-classes");
        if (!Files.isDirectory(classes)) {
            throw new IllegalStateException("ArgusInventory: target/test-classes is missing; run mvn test-compile first");
        }
        ArgusEvents events = new ArgusEvents(root);
        ArgusLedger ledger = ArgusLedger.load(root);
        if (ledger.state() == ArgusLedger.State.INVALID) {
            events.emit("bug-ledger", "policy", "denied", false, "n/a", "-", "bug-ledger-invalid");
        } else if (ledger.state() == ArgusLedger.State.MISSING && !mode.equals("baseline")) {
            events.emit("bug-ledger", "policy", "denied", false, "n/a", "-", "bug-ledger-missing");
        }

        TestPlan plan = LauncherFactory.create().discover(request().selectors(selectClasspathRoots(Set.of(classes))).build());
        ArgusCaseIds ids = new ArgusCaseIds(plan);
        List<String> rows = new ArrayList<>();
        for (TestIdentifier identifier : ArgusCaseIds.planOrder(plan)) {
            if (ArgusCaseIds.isCase(identifier)) rows.add(row(plan, ids, ledger, identifier));
        }
        Collections.sort(rows);
        ArgusEvents.writeAtomically(root.resolve(INVENTORY), lines(rows));
        ArgusEvents.writeAtomically(root.resolve(EXPECTED_BUGS), lines(ledger.expectedBugs()));
        ArgusEvents.writeAtomically(root.resolve(Counterfactual.PLAN),
                lines(Counterfactual.plan(root, ledger.expectedBugs()).stream().map(Counterfactual.PlanRow::line).toList()));
        if (events.failures() > 0) {
            throw new IllegalStateException("ArgusInventory: " + events.failures() + " ledger event(s) were not recorded");
        }
    }

    /** One SD-3 row: case_id, lane, regression, quarantine, bug_ids, unresolved, disabled, source. */
    static String row(TestPlan plan, ArgusCaseIds ids, ArgusLedger ledger, TestIdentifier identifier) {
        ArgusCaseIds.Markers markers = ArgusCaseIds.Markers.of(plan, identifier);
        Set<String> bugs = new TreeSet<>();
        Set<String> unresolved = new TreeSet<>();
        for (String token : markers.provenance()) {
            ledger.resolve(token).ifPresentOrElse(bugs::add, () -> unresolved.add(ArgusCaseIds.sanitize(token)));
        }
        return String.join("\t",
                ids.of(identifier),
                markers.lane(),
                Boolean.toString(markers.regression()),
                Boolean.toString(markers.quarantine()),
                bugs.isEmpty() ? "-" : String.join(",", bugs),
                unresolved.isEmpty() ? "-" : String.join(",", unresolved),
                disabled(identifier),
                ArgusCaseIds.source(identifier));
    }

    /**
     * {@code skip} for {@code @Disabled} on the method or its (enclosing {@code @Nested}) class,
     * {@code conditional} for any annotation from {@code org.junit.jupiter.api.condition}
     * (directly or as a meta-annotation), otherwise {@code -}.
     */
    static String disabled(TestIdentifier identifier) {
        if (!(identifier.getSource().orElse(null) instanceof MethodSource source)) return "-";
        List<AnnotatedElement> elements = new ArrayList<>();
        try {
            elements.add(source.getJavaMethod());
            for (Class<?> type = source.getJavaClass(); type != null; type = enclosingOfNested(type)) elements.add(type);
        } catch (RuntimeException | LinkageError unresolvable) {
            return "-";
        }
        if (elements.stream().anyMatch(element -> AnnotationSupport.isAnnotated(element, Disabled.class))) return "skip";
        if (elements.stream().anyMatch(element -> hasCondition(element.getAnnotations(), new HashSet<>()))) return "conditional";
        return "-";
    }

    private static Class<?> enclosingOfNested(Class<?> type) {
        return type.isAnnotationPresent(Nested.class) && !Modifier.isStatic(type.getModifiers()) ? type.getEnclosingClass() : null;
    }

    private static boolean hasCondition(Annotation[] annotations, Set<Class<?>> seen) {
        for (Annotation annotation : annotations) {
            Class<? extends Annotation> type = annotation.annotationType();
            if (type.getPackageName().equals(CONDITION_PACKAGE)) return true;
            if (!type.getPackageName().startsWith("java.") && seen.add(type) && hasCondition(type.getAnnotations(), seen)) return true;
        }
        return false;
    }

    private static String lines(List<String> lines) {
        return lines.isEmpty() ? "" : String.join("\n", lines) + "\n";
    }
}
