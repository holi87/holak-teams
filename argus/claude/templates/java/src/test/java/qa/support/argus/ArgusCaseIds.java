package qa.support.argus;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.TestTemplate;
import org.junit.platform.commons.support.AnnotationSupport;
import org.junit.platform.commons.support.HierarchyTraversalMode;
import org.junit.platform.commons.support.ReflectionSupport;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.UniqueId;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Case ids (RUNNER-CONTRACT.md SD-2) and markers (TEMPLATE-CONTRACT.md SD-11) derived from
 * JUnit Platform {@link TestIdentifier}s.
 *
 * <p>The discovery-time inventory and the execution-time listener must produce the same id
 * for the same test even though Surefire prunes the plan by tag. Everything an id depends on
 * is therefore computed from the test class by reflection, never from which neighbours happen
 * to be selected: overloads and same-class collisions are ranked over every testable method
 * of the class in name order (the template's {@code MethodOrderer$MethodName}).
 */
public final class ArgusCaseIds {

    /** SD-3 lane values a single lane tag may take. */
    public static final Set<String> LANES = Set.of("api", "ui", "perf", "security", "db", "resilience", "contract-smoke", "setup");

    private static final Pattern UNSAFE = Pattern.compile("[^A-Za-z0-9_.:-]+");
    private static final Pattern UNSAFE_SOURCE = Pattern.compile("[^A-Za-z0-9_./:-]+");
    private static final Pattern EDGE_DASHES = Pattern.compile("^-+|-+$");
    private static final Pattern INVOCATION_VALUE = Pattern.compile("^#([0-9]+)$");
    private static final Pattern PROVENANCE = Pattern.compile("^bug:(.+)$");
    private static final Pattern REPETITION = Pattern.compile("^repetition:(.*)$");
    private static final Set<String> INVOCATION_SEGMENTS = Set.of("test-template-invocation", "dynamic-test", "dynamic-container");
    private static final int MAX_LENGTH = 200;
    private static final int KEPT_PREFIX = 187;

    private final TestPlan plan;
    private final Map<String, String> ids = new HashMap<>();
    private final Set<String> caseIds = new HashSet<>();
    private final Map<Class<?>, Map<String, String>> classIds = new HashMap<>();

    /** Precomputes ids for the plan in declaration order so collision suffixes are stable. */
    public ArgusCaseIds(TestPlan plan) {
        this.plan = plan;
        for (TestIdentifier identifier : planOrder(plan)) of(identifier);
    }

    /** The SD-2 id of {@code identifier}; dynamic nodes registered during execution resolve lazily. */
    public synchronized String of(TestIdentifier identifier) {
        String known = ids.get(identifier.getUniqueId());
        if (known != null) return known;
        String id = compute(identifier);
        if (isCase(identifier)) {
            String candidate = id;
            for (int n = 2; !caseIds.add(candidate); n++) candidate = id + "." + n;
            id = candidate;
        }
        ids.put(identifier.getUniqueId(), id);
        return id;
    }

    /**
     * S(x): runs outside {@code [A-Za-z0-9_.:-]} become {@code -}, edge dashes are stripped, and
     * an id above 200 characters keeps 187 characters, a dot, and 12 hex digits of sha256(x).
     */
    public static String sanitize(String x) {
        String id = EDGE_DASHES.matcher(UNSAFE.matcher(x).replaceAll("-")).replaceAll("");
        if (id.length() > MAX_LENGTH) id = id.substring(0, KEPT_PREFIX) + "." + sha256(x).substring(0, 12);
        return id.isEmpty() ? "unnamed" : id;
    }

    /** SD-3 source field: the test class name restricted to {@code [A-Za-z0-9_./:-]}, or {@code -}. */
    public static String source(TestIdentifier identifier) {
        TestSource source = identifier.getSource().orElse(null);
        String className = source instanceof MethodSource method ? method.getClassName()
                : source instanceof ClassSource type ? type.getClassName() : null;
        if (className == null) return "-";
        String value = EDGE_DASHES.matcher(UNSAFE_SOURCE.matcher(className).replaceAll("-")).replaceAll("");
        return value.isEmpty() ? "-" : value;
    }

    /** A test, or a static template/factory container: exactly the identifiers the inventory lists. */
    public static boolean isCase(TestIdentifier identifier) {
        return identifier.isTest() || isTemplate(identifier);
    }

    /** A MethodSource-backed container whose method is a test template or a test factory. */
    public static boolean isTemplate(TestIdentifier identifier) {
        if (!identifier.isContainer() || invocationNumber(identifier) != null) return false;
        if (!(identifier.getSource().orElse(null) instanceof MethodSource source)) return false;
        try {
            Method method = source.getJavaMethod();
            return AnnotationSupport.isAnnotated(method, TestTemplate.class) || AnnotationSupport.isAnnotated(method, TestFactory.class);
        } catch (RuntimeException | LinkageError unresolvable) {
            return false;
        }
    }

    /** Depth-first pre-order over the plan: the order in which JUnit declares its nodes. */
    public static List<TestIdentifier> planOrder(TestPlan plan) {
        List<TestIdentifier> order = new ArrayList<>();
        for (TestIdentifier root : plan.getRoots()) visit(plan, root, order);
        return order;
    }

    /** SD-11 markers of one identifier; tags are the union over the identifier and its ancestors. */
    public record Markers(String lane, boolean regression, boolean quarantine, List<String> provenance, List<String> repetition) {

        public static Markers of(TestPlan plan, TestIdentifier identifier) {
            Set<String> tags = new TreeSet<>();
            for (TestIdentifier cursor = identifier; cursor != null; cursor = plan.getParent(cursor).orElse(null)) {
                cursor.getTags().forEach(tag -> tags.add(tag.getName()));
            }
            List<String> lanes = tags.stream().filter(LANES::contains).toList();
            String lane = lanes.isEmpty() ? "-" : lanes.size() == 1 ? lanes.get(0) : "ambiguous";
            return new Markers(lane, tags.contains("regression"), tags.contains("quarantine"),
                    captured(tags, PROVENANCE), captured(tags, REPETITION));
        }

        private static List<String> captured(Set<String> tags, Pattern pattern) {
            List<String> values = new ArrayList<>();
            for (String tag : tags) {
                Matcher matcher = pattern.matcher(tag);
                if (matcher.matches()) values.add(matcher.group(1));
            }
            return values;
        }
    }

    private String compute(TestIdentifier identifier) {
        String invocation = invocationNumber(identifier);
        if (invocation != null) {
            TestIdentifier parent = plan.getParent(identifier).orElse(null);
            if (parent != null) return of(parent) + ".i" + invocation;
        }
        TestSource source = identifier.getSource().orElse(null);
        if (source instanceof MethodSource method) return methodId(method);
        if (source instanceof ClassSource type) return sanitize(type.getClassName());
        return sanitize(identifier.getUniqueId());
    }

    private String methodId(MethodSource source) {
        try {
            String id = classIds.computeIfAbsent(source.getJavaClass(), type -> idsOf(type, source.getClassName()))
                    .get(signature(source.getJavaMethod()));
            if (id != null) return id;
        } catch (RuntimeException | LinkageError unresolvable) {
            // The class or method cannot be reflected: fall back to the plain name, which is
            // what both the inventory and the listener see for it.
        }
        return sanitize(source.getClassName() + "." + source.getMethodName());
    }

    /** Ids of every testable method of {@code type}, ranked in name order within a collision group. */
    private static Map<String, String> idsOf(Class<?> type, String className) {
        Map<String, Method> distinct = new LinkedHashMap<>();
        for (Method method : ReflectionSupport.findMethods(type, ArgusCaseIds::isTestable, HierarchyTraversalMode.TOP_DOWN)) {
            distinct.putIfAbsent(signature(method), method);
        }
        List<Method> ordered = new ArrayList<>(distinct.values());
        ordered.sort(Comparator.comparing(Method::getName).thenComparing(method -> parameters(method, Class::getName)));
        Map<String, Long> perName = ordered.stream().collect(Collectors.groupingBy(Method::getName, Collectors.counting()));
        Map<String, Integer> ranks = new HashMap<>();
        Map<String, String> result = new HashMap<>();
        for (Method method : ordered) {
            String x = className + "." + method.getName();
            if (perName.get(method.getName()) > 1) x += "(" + parameters(method, Class::getSimpleName) + ")";
            String base = sanitize(x);
            int rank = ranks.merge(base, 1, Integer::sum);
            result.put(signature(method), rank == 1 ? base : base + "." + rank);
        }
        return result;
    }

    private static boolean isTestable(Method method) {
        return AnnotationSupport.isAnnotated(method, Test.class)
                || AnnotationSupport.isAnnotated(method, TestTemplate.class)
                || AnnotationSupport.isAnnotated(method, TestFactory.class);
    }

    private static String signature(Method method) {
        return method.getName() + "(" + parameters(method, Class::getName) + ")";
    }

    private static String parameters(Method method, Function<Class<?>, String> name) {
        return Arrays.stream(method.getParameterTypes()).map(name).collect(Collectors.joining(","));
    }

    /** N of a template invocation or dynamic node ({@code [test-template-invocation:#N]}), else null. */
    private static String invocationNumber(TestIdentifier identifier) {
        UniqueId.Segment last = identifier.getUniqueIdObject().getLastSegment();
        if (!INVOCATION_SEGMENTS.contains(last.getType())) return null;
        Matcher matcher = INVOCATION_VALUE.matcher(last.getValue());
        return matcher.matches() ? matcher.group(1) : null;
    }

    private static void visit(TestPlan plan, TestIdentifier identifier, List<TestIdentifier> order) {
        order.add(identifier);
        for (TestIdentifier child : plan.getChildren(identifier)) visit(plan, child, order);
    }

    private static String sha256(String x) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(x.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
