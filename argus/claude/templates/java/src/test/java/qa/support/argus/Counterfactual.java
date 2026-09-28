package qa.support.argus;

import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import qa.support.oracles.OpenApi;
import qa.support.oracles.Schema;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Counterfactual fixtures (TEMPLATE-CONTRACT.md SD-10): the loader and exact validator of
 * {@code solution/counterfactual/BUG-NNNN.json}, the variant a {@code cf-*} evidence pass loads
 * into the {@link StubServer}, and the {@code reports/counterfactual-plan.tsv} rows the
 * inventory pass writes.
 *
 * <p>Validation is closed. An unknown key, a wrong type, a duplicate id or a dangling
 * {@code subject} is {@code schema-invalid}; a fixture without the {@code observed-defect}
 * tamper is {@code missing-observed-defect}; and when {@code contract} is present, a correct
 * (subject) response whose status differs from {@code contract.status}, or whose body fails the
 * strict {@link Schema#assertSchema} oracle against the configured OpenAPI document, is
 * {@code correct-violates-contract}. A contract that cannot be checked at all (no OpenAPI
 * document, an unknown operation) also counts as violated: the proof must not rest on an
 * oracle nobody verified. Only files named {@code ^BUG-[0-9]{4}[.]json$} are ever read, so
 * {@code *.example.json} is ignored. Nothing here throws on bad fixture content.
 */
public final class Counterfactual {

    public static final String DIRECTORY = "solution/counterfactual";
    public static final String PLAN = "reports/counterfactual-plan.tsv";
    public static final String SCHEMA = "argus/counterfactual-fixture@1";
    public static final String CORRECT = "cf-correct";
    public static final String REQUIRED_TAMPER = "observed-defect";

    /** The abort message of a test with nothing to prove in this pass; its adapter emits nothing. */
    public static final String NOT_APPLICABLE = "argus-counterfactual-not-applicable";
    /** Prefix of the abort message of an exempt bug in {@code cf-correct}, followed by the reason. */
    public static final String EXEMPT_PREFIX = "argus-counterfactual-exempt:";

    public static final Set<String> EXEMPTIONS = Set.of("front-end-logic", "timing-or-load", "data-layer", "fault-injection", "non-http-protocol");
    public static final Set<String> ORACLE_KINDS = Set.of("requirement", "contract", "justified-invariant");

    /** What {@link #load} found for one bug. */
    public sealed interface Loaded permits Fixture, Exemption, Invalid, Missing {}

    public record Oracle(String kind, String sourceRef) {}

    public record Contract(String operationId, int status) {}

    /** A tamper replaces the subject response entirely. */
    public record Tamper(String id, StubServer.StubResponse response) {}

    /** A usable fixture; {@code contract} is null when the fixture declares none. */
    public record Fixture(String bugId, Oracle oracle, Contract contract, List<StubServer.Exchange> exchanges,
                          String subject, List<Tamper> tampers) implements Loaded {

        /** Tamper ids in declaration order: {@code cf-tamper-<k>} is the k-th. */
        public List<String> tamperIds() {
            return tampers.stream().map(Tamper::id).toList();
        }

        /** The subject exchange, whose response is the correct behaviour. */
        public StubServer.Exchange subjectExchange() {
            return exchanges.stream().filter(exchange -> exchange.id().equals(subject)).findFirst().orElseThrow();
        }
    }

    public record Exemption(String reason, String justification) implements Loaded {}

    /** {@code reason} is {@code schema-invalid}, {@code missing-observed-defect} or {@code correct-violates-contract}. */
    public record Invalid(String reason) implements Loaded {}

    public record Missing() implements Loaded {}

    /** What a {@code cf-*} pass does with one regression test. */
    public sealed interface Decision permits Variant, Exempt, NotApplicable {}

    /**
     * Load {@code exchanges} into the stub. {@code tag} is the case-id suffix without its dot:
     * {@code cf-correct}, or {@code cf-<tamperId>} in a tamper pass.
     */
    public record Variant(String tag, List<StubServer.Exchange> exchanges) implements Decision {}

    /** {@code cf-correct} of an exempt bug: the test aborts with {@link #exemptSentinel(String)}. */
    public record Exempt(String reason) implements Decision {}

    /** Nothing to prove in this pass: the test aborts with {@link #NOT_APPLICABLE} and reports nothing. */
    public record NotApplicable() implements Decision {}

    /** One SD-10 plan row: bug_id, status, tamper_ids, reason. */
    public record PlanRow(String bugId, String status, String tamperIds, String reason) {
        public String line() {
            return String.join("\t", bugId, status, tamperIds, reason);
        }
    }

    private static final ObjectMapper MAPPER = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build();
    private static final Pattern BUG_ID = Pattern.compile("^BUG-[0-9]{4}$");
    private static final Pattern ID = Pattern.compile("^[a-z0-9-]{1,40}$");
    private static final Pattern PASS = Pattern.compile("^cf-(?:correct|tamper-([1-9][0-9]*))$");
    private static final Set<String> ROOT_KEYS = Set.of("$schema", "schemaVersion", "bugId", "oracle", "contract", "exchanges", "subject", "tampers", "exemption");
    private static final Set<String> IDENTITY_KEYS = Set.of("$schema", "schemaVersion", "bugId");
    private static final Set<String> FIXTURE_KEYS = Set.of("oracle", "exchanges", "subject", "tampers");
    private static final Set<String> RESPONSE_KEYS = Set.of("status", "headers", "body");
    private static final int MAX_JUSTIFICATION = 500;
    private static final Invalid SCHEMA_INVALID = new Invalid("schema-invalid");
    private static final NotApplicable NOT_APPLICABLE_DECISION = new NotApplicable();

    private Counterfactual() {}

    /** {@code cf-correct} or {@code cf-tamper-<k>} with k from 1, exactly as the runner names its passes. */
    public static boolean isPass(String pass) {
        return pass != null && PASS.matcher(pass).matches();
    }

    public static String exemptSentinel(String reason) {
        return EXEMPT_PREFIX + reason;
    }

    /** {@code <root>/solution/counterfactual/<bugId>.json}. */
    public static Path file(Path root, String bugId) {
        requireBugId(bugId);
        return root.resolve(DIRECTORY).resolve(bugId + ".json");
    }

    /** Loads and validates the fixture of {@code bugId}. */
    public static Loaded load(Path root, String bugId) {
        Path file = file(root, bugId);
        if (!Files.exists(file)) return new Missing();
        JsonNode tree;
        try {
            if (!Files.isRegularFile(file)) return SCHEMA_INVALID;
            tree = MAPPER.readTree(Files.readAllBytes(file));
        } catch (IOException | RuntimeException unreadable) {
            return SCHEMA_INVALID;
        }
        return validate(tree, bugId);
    }

    /**
     * The variant a pass loads: {@code cf-correct} is the recorded exchanges as they are;
     * {@code cf-tamper-k} replaces the subject response by the k-th tamper, and is empty (not
     * applicable) when the fixture declares fewer than k tampers.
     */
    public static Optional<Variant> variantFor(Fixture fixture, String pass) {
        Matcher matcher = PASS.matcher(pass == null ? "" : pass);
        if (!matcher.matches()) throw new IllegalArgumentException("not a counterfactual evidence pass: " + pass);
        String k = matcher.group(1);
        if (k == null) return Optional.of(new Variant(CORRECT, fixture.exchanges()));
        if (k.length() > 9 || Integer.parseInt(k) > fixture.tampers().size()) return Optional.empty();
        Tamper tamper = fixture.tampers().get(Integer.parseInt(k) - 1);
        List<StubServer.Exchange> exchanges = fixture.exchanges().stream()
                .map(exchange -> exchange.id().equals(fixture.subject()) ? exchange.withResponse(tamper.response()) : exchange)
                .toList();
        return Optional.of(new Variant("cf-" + tamper.id(), exchanges));
    }

    /**
     * The decision for a regression of {@code bugId} (null or {@code -} when the test has no
     * single resolved bug) in {@code pass}. An exemption is proven once, in {@code cf-correct};
     * a missing or invalid fixture is not applicable in every pass, because the plan already
     * reports it and the evidence gate fails the bug, and the test must not reach the target.
     */
    public static Decision decide(Path root, String bugId, String pass) {
        if (!isPass(pass)) throw new IllegalArgumentException("not a counterfactual evidence pass: " + pass);
        if (bugId == null || !BUG_ID.matcher(bugId).matches()) return NOT_APPLICABLE_DECISION;
        Loaded loaded = load(root, bugId);
        if (loaded instanceof Exemption exemption) {
            return pass.equals(CORRECT) ? new Exempt(exemption.reason()) : NOT_APPLICABLE_DECISION;
        }
        if (loaded instanceof Fixture fixture) {
            Optional<Variant> variant = variantFor(fixture, pass);
            if (variant.isPresent()) return variant.get();
        }
        return NOT_APPLICABLE_DECISION;
    }

    /** One row per expected bug, in the given (sorted) order; a bug without a file is {@code missing}. */
    public static List<PlanRow> plan(Path root, List<String> expectedBugs) {
        List<PlanRow> rows = new ArrayList<>();
        for (String bug : expectedBugs) {
            Loaded loaded = load(root, bug);
            if (loaded instanceof Fixture fixture) rows.add(new PlanRow(bug, "fixture", String.join(",", fixture.tamperIds()), "-"));
            else if (loaded instanceof Exemption exemption) rows.add(new PlanRow(bug, "exempt", "-", exemption.reason()));
            else if (loaded instanceof Invalid invalid) rows.add(new PlanRow(bug, "invalid", "-", invalid.reason()));
            else rows.add(new PlanRow(bug, "missing", "-", "-"));
        }
        return rows;
    }

    private static Loaded validate(JsonNode tree, String bugId) {
        if (!tree.isObject() || !keys(tree, ROOT_KEYS, IDENTITY_KEYS)) return SCHEMA_INVALID;
        if (!SCHEMA.equals(text(tree.get("$schema"))) || !integer(tree.get("schemaVersion"), 1, 1) || !bugId.equals(text(tree.get("bugId")))) {
            return SCHEMA_INVALID;
        }
        try {
            if (tree.has("exemption")) {
                if (tree.has("contract") || FIXTURE_KEYS.stream().anyMatch(tree::has)) return SCHEMA_INVALID;
                return exemption(tree.get("exemption"));
            }
            if (!FIXTURE_KEYS.stream().allMatch(tree::has)) return SCHEMA_INVALID;
            Oracle oracle = oracle(tree.get("oracle"));
            Contract contract = tree.has("contract") ? contract(tree.get("contract")) : null;
            List<StubServer.Exchange> exchanges = exchanges(tree.get("exchanges"));
            String subject = text(tree.get("subject"));
            if (subject == null || exchanges.stream().noneMatch(exchange -> exchange.id().equals(subject))) return SCHEMA_INVALID;
            List<Tamper> tampers = tampers(tree.get("tampers"));
            if (tampers.stream().noneMatch(tamper -> tamper.id().equals(REQUIRED_TAMPER))) return new Invalid("missing-observed-defect");
            Fixture fixture = new Fixture(bugId, oracle, contract, exchanges, subject, tampers);
            if (contract != null && !satisfies(contract, fixture.subjectExchange().response())) return new Invalid("correct-violates-contract");
            return fixture;
        } catch (IllegalArgumentException shape) {
            return SCHEMA_INVALID;
        }
    }

    private static Exemption exemption(JsonNode node) {
        require(keys(node, Set.of("reason", "justification"), Set.of("reason", "justification")), "exemption");
        String reason = text(node.get("reason"));
        String justification = text(node.get("justification"));
        require(reason != null && EXEMPTIONS.contains(reason), "exemption.reason");
        int length = justification == null ? 0 : justification.codePointCount(0, justification.length());
        require(length >= 1 && length <= MAX_JUSTIFICATION, "exemption.justification");
        return new Exemption(reason, justification);
    }

    private static Oracle oracle(JsonNode node) {
        require(keys(node, Set.of("kind", "sourceRef"), Set.of("kind", "sourceRef")), "oracle");
        String kind = text(node.get("kind"));
        String sourceRef = text(node.get("sourceRef"));
        require(kind != null && ORACLE_KINDS.contains(kind) && sourceRef != null && !sourceRef.isBlank(), "oracle");
        return new Oracle(kind, sourceRef);
    }

    private static Contract contract(JsonNode node) {
        require(keys(node, Set.of("operationId", "status"), Set.of("operationId", "status")), "contract");
        String operationId = text(node.get("operationId"));
        require(operationId != null && !operationId.isBlank() && integer(node.get("status"), 100, 599), "contract");
        return new Contract(operationId, node.get("status").intValue());
    }

    private static List<StubServer.Exchange> exchanges(JsonNode node) {
        require(node.isArray() && !node.isEmpty(), "exchanges");
        List<StubServer.Exchange> exchanges = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (JsonNode item : node) {
            require(keys(item, Set.of("id", "request", "response"), Set.of("id", "request", "response")), "exchange");
            JsonNode request = item.get("request");
            require(keys(request, Set.of("method", "path", "query"), Set.of("method", "path")), "exchange.request");
            String id = text(item.get("id"));
            String method = text(request.get("method"));
            String path = text(request.get("path"));
            require(id != null && method != null && path != null, "exchange");
            Map<String, String> query = request.has("query") ? strings(request.get("query"), "exchange.request.query") : Map.of();
            StubServer.Exchange exchange = new StubServer.Exchange(id, new StubServer.ExchangeRequest(method, path, query), response(item.get("response")));
            exchange.validate();
            require(ids.add(id), "exchange.id");
            exchanges.add(exchange);
        }
        return List.copyOf(exchanges);
    }

    private static List<Tamper> tampers(JsonNode node) {
        require(node.isArray() && !node.isEmpty(), "tampers");
        List<Tamper> tampers = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (JsonNode item : node) {
            require(keys(item, Set.of("id", "response"), Set.of("id", "response")), "tamper");
            String id = text(item.get("id"));
            // "correct" would make the case suffix .cf-correct ambiguous with the correct pass.
            require(id != null && ID.matcher(id).matches() && !id.equals("correct") && ids.add(id), "tamper.id");
            StubServer.StubResponse response = response(item.get("response"));
            response.validate("tamper " + id);
            tampers.add(new Tamper(id, response));
        }
        return List.copyOf(tampers);
    }

    /** {@code {status, headers?, body?}}; an absent body sends no content, a JSON null sends {@code null}. */
    private static StubServer.StubResponse response(JsonNode node) {
        require(keys(node, RESPONSE_KEYS, Set.of("status")) && integer(node.get("status"), 100, 599), "response");
        Map<String, String> headers = node.has("headers") ? strings(node.get("headers"), "response.headers") : Map.of();
        return new StubServer.StubResponse(node.get("status").intValue(), headers, node.get("body"));
    }

    /** Whether the correct response has the contract's status and its wire body passes the strict schema. */
    private static boolean satisfies(Contract contract, StubServer.StubResponse correct) {
        if (correct.status() != contract.status()) return false;
        try {
            Schema.assertSchema(OpenApi.configured(), contract.status(), new String(correct.bytes(), StandardCharsets.UTF_8),
                    contract.operationId(), Schema.Options.STRICT);
            return true;
        } catch (AssertionError | RuntimeException unverified) {
            return false;
        }
    }

    private static Map<String, String> strings(JsonNode node, String label) {
        require(node != null && node.isObject(), label);
        Map<String, String> values = new LinkedHashMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = node.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            require(entry.getValue().isTextual(), label);
            values.put(entry.getKey(), entry.getValue().textValue());
        }
        return values;
    }

    /** An object whose keys are all allowed and include every required one. */
    private static boolean keys(JsonNode node, Set<String> allowed, Set<String> required) {
        if (node == null || !node.isObject()) return false;
        for (Iterator<String> names = node.fieldNames(); names.hasNext(); ) {
            if (!allowed.contains(names.next())) return false;
        }
        return required.stream().allMatch(node::has);
    }

    private static boolean integer(JsonNode node, int min, int max) {
        return node != null && node.isIntegralNumber() && node.canConvertToInt() && node.intValue() >= min && node.intValue() <= max;
    }

    private static String text(JsonNode node) {
        return node != null && node.isTextual() ? node.textValue() : null;
    }

    private static void require(boolean condition, String label) {
        if (!condition) throw new IllegalArgumentException("counterfactual fixture: invalid " + label);
    }

    private static void requireBugId(String bugId) {
        if (bugId == null || !BUG_ID.matcher(bugId).matches()) throw new IllegalArgumentException("not a canonical bug id: " + bugId);
    }
}
