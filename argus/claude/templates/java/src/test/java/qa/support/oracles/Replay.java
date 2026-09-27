package qa.support.oracles;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.restassured.response.Response;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Idempotency oracles. A replayed idempotent request (PUT, DELETE, or a POST carrying an
 * idempotency key) must not change the outcome or the state a second time.
 */
public final class Replay {

    /** The shared key and the id both responses named. */
    public record KeyedReplay(String key, Object id) {}

    private static final AtomicLong SEQUENCE = new AtomicLong();

    private Replay() {}

    public static Response idempotentReplay(Supplier<Response> send, String... volatileFields) {
        return idempotentReplay(send, null, volatileFields);
    }

    /**
     * Sends the same request twice, sequentially. Both responses must have the same status and
     * deep-equal bodies once {@code volatileFields} (key names, removed at any depth) are
     * dropped; with {@code read}, the state read after each send must be equal too. Returns
     * the first response.
     */
    public static Response idempotentReplay(Supplier<Response> send, Supplier<?> read, String... volatileFields) {
        Set<String> ignored = Set.of(volatileFields);
        Response first = send.get();
        JsonNode stateAfterFirst = read == null ? null : state(read.get(), ignored);
        Response second = send.get();
        JsonNode stateAfterSecond = read == null ? null : state(read.get(), ignored);
        if (first.statusCode() != second.statusCode()) {
            throw new AssertionError("idempotent replay changed the status from " + first.statusCode() + " to " + second.statusCode()
                    + "; body excerpt: " + Http.excerpt(second.asString()));
        }
        JsonNode firstBody = comparable(first.asString(), ignored);
        JsonNode secondBody = comparable(second.asString(), ignored);
        if (!firstBody.equals(secondBody)) {
            throw new AssertionError("idempotent replay changed the body\nfirst:  " + Http.excerpt(firstBody.toString())
                    + "\nreplay: " + Http.excerpt(secondBody.toString()));
        }
        if (read != null && !stateAfterFirst.equals(stateAfterSecond)) {
            throw new AssertionError("idempotent replay changed the state read back\nafter first:  " + Http.excerpt(stateAfterFirst.toString())
                    + "\nafter replay: " + Http.excerpt(stateAfterSecond.toString()));
        }
        return first;
    }

    /**
     * The next deterministic idempotency key, {@code argus-idem-<seq>}. The sequence is per
     * JVM; against an environment that keeps keys across runs, {@code send} may namespace it.
     */
    public static String nextIdempotencyKey() {
        return "argus-idem-" + SEQUENCE.incrementAndGet();
    }

    /**
     * Sends one create twice with the same idempotency key. Exactly one effect must exist
     * ({@code count} after = before + 1) and both responses must name the same id.
     */
    public static KeyedReplay replayWithIdempotencyKey(Function<String, Response> send, LongSupplier count, Function<Response, ?> idOf) {
        String key = nextIdempotencyKey();
        long before = count.getAsLong();
        Response first = send.apply(key);
        Response second = send.apply(key);
        long after = count.getAsLong();
        if (after != before + 1) {
            throw new AssertionError("idempotency key " + key + ": expected exactly one effect (count " + before + " -> "
                    + (before + 1) + "), observed " + after);
        }
        Object firstId = idOf.apply(first);
        Object secondId = idOf.apply(second);
        if (firstId == null || "".equals(firstId)) throw new AssertionError("idempotency key " + key + ": the first response carries no id");
        if (!Objects.equals(firstId, secondId)) {
            throw new AssertionError("idempotency key " + key + ": the replay returned a different id ("
                    + Http.excerpt(String.valueOf(firstId)) + " then " + Http.excerpt(String.valueOf(secondId)) + ")");
        }
        return new KeyedReplay(key, firstId);
    }

    private static JsonNode comparable(String body, Set<String> ignored) {
        JsonNode json = Http.parse(body);
        return json == null ? JsonNodeFactory.instance.textNode(body == null ? "" : body) : strip(json, ignored);
    }

    private static JsonNode state(Object value, Set<String> ignored) {
        if (value instanceof Response res) {
            ObjectNode node = JsonNodeFactory.instance.objectNode().put("status", res.statusCode());
            node.set("body", comparable(res.asString(), ignored));
            return node;
        }
        if (value instanceof String text) return comparable(text, ignored);
        if (value instanceof JsonNode node) return strip(node.deepCopy(), ignored);
        JsonNode tree = Http.JSON.valueToTree(value);
        return tree == null ? JsonNodeFactory.instance.nullNode() : strip(tree, ignored);
    }

    private static JsonNode strip(JsonNode node, Set<String> ignored) {
        if (node.isObject()) {
            ObjectNode object = (ObjectNode) node;
            object.remove(ignored);
            List<JsonNode> children = new ArrayList<>();
            object.elements().forEachRemaining(children::add);
            children.forEach(child -> strip(child, ignored));
        } else if (node.isArray()) {
            node.forEach(child -> strip(child, ignored));
        }
        return node;
    }
}
