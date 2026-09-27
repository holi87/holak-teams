package qa.support.argus;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ExtensionContext.Namespace;
import qa.support.Config;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Counterfactual evidence passes for JUnit Jupiter (RUNNER-CONTRACT.md SD-6,
 * TEMPLATE-CONTRACT.md SD-10).
 *
 * <p>Registered through {@code META-INF/services/org.junit.jupiter.api.extension.Extension}
 * with autodetection enabled in {@code junit-platform.properties}, so it wraps every test and
 * its callbacks run before those of any class-level {@code @ExtendWith}. It is inert unless
 * {@code ARGUS_EVIDENCE_PASS} starts with {@code cf-}. Then it holds one in-process
 * {@link StubServer} per engine run and, before each test, resolves the single
 * {@code @Tag("bug:<token>")} of a {@code regression} test through {@link ArgusLedger}:
 * <ul>
 *   <li>an exempt bug aborts with {@code argus-counterfactual-exempt:<reason>} in
 *       {@code cf-correct} and with {@code argus-counterfactual-not-applicable} in a tamper
 *       pass;</li>
 *   <li>a test without exactly one resolvable bug, a missing or invalid fixture, and a tamper
 *       pass beyond the fixture's tampers abort with {@code argus-counterfactual-not-applicable}
 *       (the plan and the evidence gate report the fixture itself);</li>
 *   <li>otherwise the pass's variant is loaded into the stub and {@link Config#apiUrl()}
 *       answers with the stub for this test ({@value #API_URL_PROPERTY}). The stub URL keeps
 *       the path of the real {@code API_URL}, so exchange paths are the paths the target sees.
 *       A UI test's browser traffic reaches the same stub through {@code PlaywrightFixture}
 *       ({@link #routesBrowser}, {@link #fulfil}).</li>
 * </ul>
 * No test reaches the real API in a counterfactual pass. After a loaded test, any request its
 * variant does not declare raises {@link ArgusCounterfactualError}, which voids the verdict.
 */
public final class ArgusCounterfactualExtension implements BeforeAllCallback, BeforeEachCallback, AfterEachCallback {

    /** The per-test stub URL {@link Config#apiUrl()} honours during a {@code cf-*} pass. */
    public static final String API_URL_PROPERTY = "argus.counterfactual.apiUrl";
    /** Optional Playwright URL glob for the UI's API calls; default: the real {@code API_URL} + {@code /**}. */
    public static final String ROUTE_PATTERN_ENV = "ARGUS_API_ROUTE_PATTERN";

    /** A stub response for a Playwright {@code route.fulfill}. */
    public record RoutedResponse(int status, Map<String, String> headers, byte[] body) {}

    private static final Namespace NAMESPACE = Namespace.create(ArgusCounterfactualExtension.class);
    private static final String LOADED = "loaded";
    private static final Pattern PROVENANCE = Pattern.compile("^bug:(.+)$");
    private static final int REPORTED_REQUESTS = 5;
    private static final Map<String, String> LOADED_VARIANTS = new ConcurrentHashMap<>();
    private static final AtomicInteger UNRESOLVED = new AtomicInteger();
    private static StubServer stub;

    /** Whether {@code ARGUS_EVIDENCE_PASS} names a counterfactual pass. */
    public static boolean active() {
        String pass = System.getenv("ARGUS_EVIDENCE_PASS");
        return pass != null && pass.startsWith("cf-");
    }

    @Override
    public void beforeAll(ExtensionContext context) {
        if (active()) stub(context);
    }

    @Override
    public void beforeEach(ExtensionContext context) {
        if (!active()) return;
        String pass = System.getenv("ARGUS_EVIDENCE_PASS");
        if (!Counterfactual.isPass(pass)) {
            throw new IllegalStateException("ARGUS_EVIDENCE_PASS=" + pass + " is neither cf-correct nor cf-tamper-<k>; the test was not run");
        }
        Path root = ArgusEvents.root();
        Counterfactual.Decision decision = Counterfactual.decide(root, bug(context, root), pass);
        if (decision instanceof Counterfactual.Exempt exempt) {
            Assumptions.abort(Counterfactual.exemptSentinel(exempt.reason()));
            return;
        }
        if (!(decision instanceof Counterfactual.Variant variant)) {
            Assumptions.abort(Counterfactual.NOT_APPLICABLE);
            return;
        }
        StubServer server = stub(context);
        server.load(variant.exchanges());
        UNRESOLVED.set(0);
        context.getStore(NAMESPACE).put(LOADED, variant.tag());
        LOADED_VARIANTS.put(context.getUniqueId(), variant.tag());
        System.setProperty(API_URL_PROPERTY, server.url() + basePath(Config.targetApiUrl()));
    }

    @Override
    public void afterEach(ExtensionContext context) {
        if (!active()) return;
        System.clearProperty(API_URL_PROPERTY);
        // afterEach also runs for a test this extension aborted; only a loaded test is checked.
        if (context.getStore(NAMESPACE).remove(LOADED) == null) return;
        StubServer server = current();
        List<StubServer.RecordedRequest> unmatched = server == null ? List.of() : server.unmatched();
        int unresolved = UNRESOLVED.getAndSet(0);
        if (server != null) server.load(List.of());
        if (!unmatched.isEmpty() || unresolved > 0) {
            String sample = unmatched.stream().limit(REPORTED_REQUESTS)
                    .map(request -> request.method() + " " + request.path()).collect(Collectors.joining(", "));
            throw new ArgusCounterfactualError("counterfactual stub: " + (unmatched.size() + unresolved)
                    + " request(s) outside the fixture's exchanges" + (sample.isEmpty() ? "" : ": " + sample));
        }
    }

    /** Whether this test runs against a loaded variant and carries the {@code ui} lane tag. */
    public static boolean routesBrowser(ExtensionContext context) {
        return active() && context.getStore(NAMESPACE).get(LOADED) != null && context.getTags().contains("ui");
    }

    /** {@code ARGUS_API_ROUTE_PATTERN}, else the real {@code API_URL} followed by {@code /**}. */
    public static String routePattern() {
        String pattern = System.getenv(ROUTE_PATTERN_ENV);
        if (pattern != null && !pattern.isBlank()) return pattern;
        return Config.targetApiUrl().replaceAll("/+$", "") + "/**";
    }

    /**
     * Answers one browser request from the loaded variant, exactly as the stub would over the
     * network; a request the variant does not declare gets {@code 501 {"argusStub":"unmatched"}}
     * and fails the test after it finishes.
     */
    public static RoutedResponse fulfil(String method, String url) {
        StubServer server = current();
        StubServer.StubResponse response = null;
        if (server == null) {
            UNRESOLVED.incrementAndGet();
        } else {
            try {
                response = server.resolve(method, pathAndQuery(url), null);
            } catch (RuntimeException unresolvable) {
                UNRESOLVED.incrementAndGet();
            }
        }
        if (response == null) {
            return new RoutedResponse(501, Map.of("content-type", "application/json"),
                    "{\"argusStub\":\"unmatched\"}".getBytes(StandardCharsets.UTF_8));
        }
        byte[] body = response.bytes();
        Map<String, String> headers = new LinkedHashMap<>(response.headers());
        if (body.length > 0 && !headers.containsKey("content-type")) {
            headers.put("content-type", response.body().isTextual() ? "text/plain; charset=utf-8" : "application/json");
        }
        boolean empty = "HEAD".equalsIgnoreCase(method) || response.status() == 204 || response.status() == 304;
        return new RoutedResponse(response.status(), Map.copyOf(headers), empty ? new byte[0] : body);
    }

    /** The variant tag this extension loaded for a test, consumed once by the outcome listener. */
    static Optional<String> takeLoaded(String uniqueId) {
        return Optional.ofNullable(LOADED_VARIANTS.remove(uniqueId));
    }

    /** The canonical bug of a regression test carrying exactly one resolvable provenance tag, else null. */
    private static String bug(ExtensionContext context, Path root) {
        if (!context.getTags().contains("regression")) return null;
        List<String> tokens = new ArrayList<>();
        for (String tag : context.getTags()) {
            Matcher matcher = PROVENANCE.matcher(tag);
            if (matcher.matches()) tokens.add(matcher.group(1));
        }
        return tokens.size() == 1 ? ArgusLedger.load(root).resolve(tokens.get(0)).orElse(null) : null;
    }

    private static String basePath(String url) {
        try {
            String path = new URI(url).getRawPath();
            return path == null ? "" : path.replaceAll("/+$", "");
        } catch (URISyntaxException unparseable) {
            return "";
        }
    }

    /** The path and query of an absolute URL, without its fragment. */
    private static String pathAndQuery(String url) {
        int scheme = url.indexOf("://");
        int start = scheme < 0 ? 0 : url.indexOf('/', scheme + 3);
        String target = start < 0 ? "/" : url.substring(start);
        int fragment = target.indexOf('#');
        return fragment < 0 ? target : target.substring(0, fragment);
    }

    private static StubServer stub(ExtensionContext context) {
        return context.getRoot().getStore(NAMESPACE).getOrComputeIfAbsent(StubLease.class, type -> new StubLease(), StubLease.class).server;
    }

    private static synchronized StubServer current() {
        return stub;
    }

    private static synchronized void publish(StubServer server) {
        stub = server;
    }

    private static synchronized void retract(StubServer server) {
        if (stub == server) stub = null;
    }

    /** Starts the shared stub once per engine run; JUnit closes it with the run's root store. */
    private static final class StubLease implements ExtensionContext.Store.CloseableResource {

        final StubServer server;

        StubLease() {
            server = StubServer.start();
            publish(server);
        }

        @Override
        public void close() {
            retract(server);
            server.stop();
        }
    }
}
