package qa.support.argus;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Read-only view of {@code solution/bug-ledger.json} for the provenance join
 * (RUNNER-CONTRACT.md SD-4) and the repetition bound of intermittent defects (SD-6).
 *
 * <p>Only {@code bugs[].id}, {@code bugs[].origin[]}, {@code bugs[].status} and
 * {@code bugs[].verification.reproduction} are read; they have the same shape in
 * {@code argus/bug-ledger@1} and {@code @2}. Schema validation stays with the canonical
 * contract; this class rejects exactly what would make the join ambiguous.
 */
public final class ArgusLedger {

    /** Whether the ledger exists and can be joined. */
    public enum State { OK, MISSING, INVALID }

    public static final String PATH = "solution/bug-ledger.json";

    private static final ObjectMapper MAPPER = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private static final Pattern SCHEMA = Pattern.compile("^argus/bug-ledger@([12])$");
    private static final Pattern BUG_ID = Pattern.compile("^BUG-[0-9]{4}$");
    private static final Pattern TOKEN = Pattern.compile("^(BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4})$");
    private static final int MAX_REPETITION = 200;

    private final State state;
    private final Map<String, String> aliases;
    private final List<String> expectedBugs;
    private final Map<String, double[]> reproductions;

    private ArgusLedger(State state, Map<String, String> aliases, List<String> expectedBugs, Map<String, double[]> reproductions) {
        this.state = state;
        this.aliases = aliases;
        this.expectedBugs = expectedBugs;
        this.reproductions = reproductions;
    }

    /** Loads {@code <root>/solution/bug-ledger.json}; never throws. */
    public static ArgusLedger load(Path root) {
        Path file = root.resolve(PATH);
        if (!Files.exists(file)) return empty(State.MISSING);
        try {
            return Files.isRegularFile(file) ? parse(MAPPER.readTree(Files.readAllBytes(file))) : empty(State.INVALID);
        } catch (IOException notJson) {
            return empty(State.INVALID);
        }
    }

    public State state() {
        return state;
    }

    /** The canonical id a provenance token resolves to through {@code id} or {@code origin[]}. */
    public Optional<String> resolve(String token) {
        return TOKEN.matcher(token).matches() ? Optional.ofNullable(aliases.get(token)) : Optional.empty();
    }

    /** Sorted unique ids whose status is exactly {@code confirmed}. */
    public List<String> expectedBugs() {
        return expectedBugs;
    }

    /**
     * The smallest repetition SD-6 accepts for an intermittent bug, or empty when the entry is
     * deterministic ({@code p = 1} or no usable reproduction record), which demands n = 1.
     */
    public OptionalInt repetitionBound(String bugId) {
        double[] record = reproductions.get(bugId);
        if (record == null) return OptionalInt.empty();
        double p = record[1] / record[0];
        if (p >= 1) return OptionalInt.empty();
        if (p <= 0) return OptionalInt.of(MAX_REPETITION);
        return OptionalInt.of((int) Math.min(MAX_REPETITION, Math.ceil(Math.log(0.05) / Math.log(1 - p))));
    }

    private static ArgusLedger parse(JsonNode tree) {
        if (tree == null || !tree.isObject()) return empty(State.INVALID);
        JsonNode schema = tree.get("$schema");
        Matcher version = SCHEMA.matcher(schema != null && schema.isTextual() ? schema.textValue() : "");
        JsonNode schemaVersion = tree.get("schemaVersion");
        JsonNode bugs = tree.get("bugs");
        if (!version.matches() || schemaVersion == null || !schemaVersion.isNumber()
                || schemaVersion.doubleValue() != Integer.parseInt(version.group(1)) || bugs == null || !bugs.isArray()) {
            return empty(State.INVALID);
        }
        Map<String, String> aliases = new HashMap<>();
        HashSet<String> ids = new HashSet<>();
        TreeSet<String> confirmed = new TreeSet<>();
        Map<String, double[]> reproductions = new HashMap<>();
        for (JsonNode bug : bugs) {
            JsonNode id = bug.get("id");
            if (!bug.isObject() || id == null || !id.isTextual() || !BUG_ID.matcher(id.textValue()).matches() || !ids.add(id.textValue())) {
                return empty(State.INVALID);
            }
            String canonical = id.textValue();
            if (!alias(aliases, canonical, canonical)) return empty(State.INVALID);
            JsonNode origin = bug.get("origin");
            if (origin != null && !origin.isNull()) {
                if (!origin.isArray()) return empty(State.INVALID);
                for (JsonNode value : origin) {
                    if (!value.isTextual() || !alias(aliases, value.textValue(), canonical)) return empty(State.INVALID);
                }
            }
            JsonNode status = bug.get("status");
            if (status != null && status.isTextual() && status.textValue().equals("confirmed")) confirmed.add(canonical);
            JsonNode reproduction = bug.path("verification").path("reproduction");
            JsonNode attempts = reproduction.get("attempts");
            JsonNode occurrences = reproduction.get("occurrences");
            if (attempts != null && occurrences != null && attempts.isIntegralNumber() && occurrences.isIntegralNumber()
                    && attempts.longValue() > 0 && occurrences.longValue() >= 0 && occurrences.longValue() <= attempts.longValue()) {
                reproductions.put(canonical, new double[] {attempts.longValue(), occurrences.longValue()});
            }
        }
        return new ArgusLedger(State.OK, aliases, List.copyOf(confirmed), reproductions);
    }

    /** Registers an alias; false when it already resolves to a different canonical id. */
    private static boolean alias(Map<String, String> aliases, String alias, String canonical) {
        String previous = aliases.putIfAbsent(alias, canonical);
        return previous == null || previous.equals(canonical);
    }

    private static ArgusLedger empty(State state) {
        return new ArgusLedger(state, Map.of(), List.of(), Map.of());
    }
}
