package qa.support.oracles;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.PathType;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import qa.support.argus.ArgusPrerequisiteError;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * An OpenAPI 3.x document turned into JSON Schema draft 2020-12 validators, one view per
 * direction (the same rules as the TypeScript and Python oracles).
 *
 * <p>Normalization, OpenAPI 3.0 only: {@code nullable: true} adds {@code null} to a
 * {@code type} and an {@code enum}; beside a {@code $ref} it becomes
 * {@code anyOf[{$ref}, {type: null}]}, otherwise {@code anyOf[schema, {type: null}]}; boolean
 * {@code exclusiveMinimum}/{@code exclusiveMaximum} take the numeric form; {@code example},
 * {@code xml}, {@code externalDocs} and {@code deprecated} are dropped. Every version: the
 * response direction removes {@code writeOnly} properties and the request direction
 * {@code readOnly} ones, from {@code properties} and {@code required} alike.
 *
 * <p>Strict mode wraps every use site (the root, each {@code properties} value,
 * {@code items}, each {@code prefixItems} entry, an {@code additionalProperties} schema, each
 * {@code oneOf}/{@code anyOf} member, never an {@code allOf} member) as
 * {@code {allOf: [S], unevaluatedProperties: false}}, unless S, after {@code $ref} and
 * {@code allOf} resolution, declares {@code additionalProperties},
 * {@code unevaluatedProperties} or {@code patternProperties}. Component roots are never
 * wrapped. Validators hold {@code components.schemas} under {@code $defs};
 * {@code #/components/schemas/} pointers become {@code #/$defs/}.
 */
public final class OpenApi {

    /** Which side of the exchange a schema describes. */
    public enum Direction { RESPONSE, REQUEST }

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;
    private static final JsonSchemaFactory FACTORY = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
    private static final SchemaValidatorsConfig CONFIG = SchemaValidatorsConfig.builder()
            .formatAssertionsEnabled(true).locale(Locale.ENGLISH).pathType(PathType.LEGACY).build();
    private static final String DIALECT = "https://json-schema.org/draft/2020-12/schema";
    private static final String COMPONENT_REF = "#/components/schemas/";
    private static final String DEFS_REF = "#/$defs/";
    private static final List<String> METHODS = List.of("get", "put", "post", "delete", "options", "head", "patch", "trace", "query");
    private static final Set<String> DROPPED_3_0 = Set.of("example", "xml", "externalDocs", "deprecated");
    private static final Set<String> OPEN = Set.of("additionalProperties", "unevaluatedProperties", "patternProperties");
    private static final Set<String> SCHEMA_VALUES = Set.of("items", "additionalProperties", "unevaluatedProperties",
            "unevaluatedItems", "not", "if", "then", "else", "contains", "propertyNames", "additionalItems");
    private static final Set<String> SCHEMA_ARRAYS = Set.of("allOf", "anyOf", "oneOf", "prefixItems", "items");
    private static final Set<String> SCHEMA_MAPS = Set.of("properties", "patternProperties", "dependentSchemas", "$defs", "definitions");
    private static final Set<String> USE_SITE_VALUES = Set.of("items", "additionalProperties");
    private static final Set<String> USE_SITE_ARRAYS = Set.of("items", "prefixItems", "oneOf", "anyOf");

    private static volatile OpenApi configured;

    private final JsonNode doc;
    private final String source;
    private final boolean legacy;
    private final Map<String, ObjectNode> defs = new ConcurrentHashMap<>();
    private final Map<String, JsonSchema> compiled = new ConcurrentHashMap<>();

    private OpenApi(JsonNode doc, String source) {
        if (!doc.path("openapi").asText("").matches("3\\.[0-9]+.*")) {
            throw new IllegalArgumentException("not an OpenAPI 3.x document: " + source);
        }
        this.doc = doc;
        this.source = source;
        this.legacy = doc.get("openapi").asText().startsWith("3.0");
    }

    /** {@code OPENAPI_PATH}, or {@code ./openapi.json} when it is unset or blank. */
    public static Path defaultPath() {
        String path = System.getenv("OPENAPI_PATH");
        return Path.of(path == null || path.isBlank() ? "openapi.json" : path);
    }

    /** The document at {@link #defaultPath()}, loaded once per JVM. A missing file is a missing prerequisite. */
    public static OpenApi configured() {
        OpenApi current = configured;
        if (current == null) {
            synchronized (OpenApi.class) {
                if (configured == null) {
                    Path path = defaultPath();
                    if (!Files.isRegularFile(path)) {
                        throw new ArgusPrerequisiteError("OpenAPI document not found at " + path + "; set OPENAPI_PATH");
                    }
                    configured = load(path);
                }
                current = configured;
            }
        }
        return current;
    }

    /** Loads a JSON document; convert YAML first. */
    public static OpenApi load(Path path) {
        try {
            return new OpenApi(MAPPER.readTree(path.toFile()), path.toString());
        } catch (IOException e) {
            throw new IllegalStateException("cannot read the OpenAPI document at " + path + " (JSON only; convert YAML first)", e);
        }
    }

    /** Loads a JSON document from the test classpath, for example {@code "openapi.selftest.json"}. */
    public static OpenApi fromClasspath(String resource) {
        try (InputStream in = OpenApi.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) throw new IllegalArgumentException("classpath resource not found: " + resource);
            return new OpenApi(MAPPER.readTree(in), "classpath:" + resource);
        } catch (IOException e) {
            throw new IllegalStateException("cannot read classpath resource " + resource, e);
        }
    }

    /** A copy of the raw document; the loaded document is never mutated. */
    public JsonNode document() {
        return doc.deepCopy();
    }

    /** One schema normalized for a direction, closed as a use site when {@code strict}. */
    public JsonNode normalize(JsonNode schema, Direction direction, boolean strict) {
        JsonNode normalized = normalizeNode(schema, direction);
        return strict ? strictNode(normalized, true) : normalized;
    }

    /** A copy of the normalized {@code components.schemas}, exactly as validators see them under {@code $defs}. */
    public ObjectNode schemas(Direction direction, boolean strict) {
        return defs(direction, strict).deepCopy();
    }

    /** The response object documented for exactly {@code status}, with {@code $ref} chains resolved. */
    public Optional<JsonNode> response(String operationId, int status) {
        JsonNode response = operation(operationId).path("responses").get(Integer.toString(status));
        for (int hops = 0; response != null && response.path("$ref").isTextual(); hops++) {
            String ref = response.get("$ref").asText();
            response = hops > 10 ? null : resolveRef(ref);
            if (response == null) throw new IllegalArgumentException(operationId + ": response reference " + ref + " cannot be resolved");
        }
        return Optional.ofNullable(response);
    }

    /** Status keys the operation documents, in document order. */
    public List<String> documentedStatuses(String operationId) {
        List<String> keys = new ArrayList<>();
        operation(operationId).path("responses").fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    /** A validator for a local pointer such as {@code #/components/schemas/Order}; the body is a use site. */
    public JsonSchema schemaForRef(String ref, Direction direction, boolean strict) {
        if (ref == null || !ref.startsWith("#/")) {
            throw new IllegalArgumentException("schema reference must be a local JSON pointer such as '#/components/schemas/X', got " + ref);
        }
        JsonNode target = resolveRef(ref);
        if (target == null) throw new IllegalArgumentException("schema " + ref + " is not defined in " + source);
        JsonNode root = ref.startsWith(COMPONENT_REF) ? NODES.objectNode().put("$ref", DEFS_REF + ref.substring(COMPONENT_REF.length())) : target;
        return compile("ref|" + ref, root, direction, strict);
    }

    /** A validator for an operation schema, cached under {@code key}. */
    public JsonSchema schemaFor(String key, JsonNode schema, Direction direction, boolean strict) {
        return compile("op|" + key, schema, direction, strict);
    }

    private JsonSchema compile(String key, JsonNode schema, Direction direction, boolean strict) {
        return compiled.computeIfAbsent(key + "|" + direction + "|" + strict, k -> {
            JsonNode body = normalize(schema, direction, strict);
            ObjectNode root = body.isObject() ? ((ObjectNode) body).deepCopy() : NODES.objectNode().set("allOf", NODES.arrayNode().add(body));
            root.put("$schema", DIALECT);
            root.set("$defs", defs(direction, strict));
            return FACTORY.getSchema(root, CONFIG);
        });
    }

    private ObjectNode defs(Direction direction, boolean strict) {
        return defs.computeIfAbsent(direction + "|" + strict, k -> {
            ObjectNode out = NODES.objectNode();
            doc.path("components").path("schemas").fields().forEachRemaining(entry -> {
                JsonNode normalized = normalizeNode(entry.getValue(), direction);
                out.set(entry.getKey(), strict ? strictNode(normalized, false) : normalized);
            });
            return out;
        });
    }

    private JsonNode operation(String operationId) {
        List<JsonNode> found = new ArrayList<>();
        for (String container : List.of("paths", "webhooks")) {
            for (JsonNode item : doc.path(container)) {
                for (String method : METHODS) {
                    JsonNode operation = item.path(method);
                    if (operationId.equals(operation.path("operationId").asText(null))) found.add(operation);
                }
            }
        }
        if (found.isEmpty()) throw new IllegalArgumentException("operationId " + operationId + " is not defined in " + source);
        if (found.size() > 1) throw new IllegalArgumentException("operationId " + operationId + " is defined more than once in " + source);
        return found.get(0);
    }

    private JsonNode normalizeNode(JsonNode node, Direction direction) {
        if (!node.isObject()) return node.deepCopy();
        ObjectNode out = NODES.objectNode();
        Set<String> removed = new LinkedHashSet<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = node.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            String key = entry.getKey();
            JsonNode value = entry.getValue();
            if (legacy && (DROPPED_3_0.contains(key) || "nullable".equals(key))) continue;
            if ("$ref".equals(key) && value.isTextual() && value.asText().startsWith(COMPONENT_REF)) {
                out.put(key, DEFS_REF + value.asText().substring(COMPONENT_REF.length()));
            } else if (SCHEMA_VALUES.contains(key) && value.isObject()) {
                out.set(key, normalizeNode(value, direction));
            } else if (SCHEMA_ARRAYS.contains(key) && value.isArray()) {
                ArrayNode members = out.putArray(key);
                value.forEach(member -> members.add(normalizeNode(member, direction)));
            } else if (SCHEMA_MAPS.contains(key) && value.isObject()) {
                ObjectNode map = out.putObject(key);
                value.fields().forEachRemaining(property -> {
                    if ("properties".equals(key) && hidden(property.getValue(), direction)) removed.add(property.getKey());
                    else map.set(property.getKey(), normalizeNode(property.getValue(), direction));
                });
            } else {
                out.set(key, value.deepCopy());
            }
        }
        if (!removed.isEmpty() && out.path("required").isArray()) {
            ArrayNode required = NODES.arrayNode();
            out.get("required").forEach(name -> { if (!removed.contains(name.asText())) required.add(name); });
            if (required.isEmpty()) out.remove("required"); else out.set("required", required);
        }
        if (!legacy) return out;
        exclusive(out, "exclusiveMinimum", "minimum");
        exclusive(out, "exclusiveMaximum", "maximum");
        return node.path("nullable").asBoolean(false) ? nullable(out) : out;
    }

    private static void exclusive(ObjectNode schema, String flag, String bound) {
        JsonNode value = schema.get(flag);
        if (value == null || !value.isBoolean()) return;
        schema.remove(flag);
        if (value.asBoolean() && schema.path(bound).isNumber()) schema.set(flag, schema.remove(bound));
    }

    private static JsonNode nullable(ObjectNode schema) {
        JsonNode type = schema.get("type");
        boolean typed = type != null && (type.isTextual() || type.isArray());
        if (typed || schema.path("enum").isArray()) {
            if (type != null && type.isTextual() && !"null".equals(type.asText())) schema.putArray("type").add(type).add("null");
            else if (type != null && type.isArray() && !contains(type, NODES.textNode("null"))) ((ArrayNode) type).add("null");
            if (schema.path("enum").isArray() && !contains(schema.get("enum"), NODES.nullNode())) ((ArrayNode) schema.get("enum")).addNull();
            return schema;
        }
        ObjectNode nullType = NODES.objectNode().put("type", "null");
        if (schema.path("$ref").isTextual() && !schema.has("anyOf")) {
            JsonNode ref = schema.remove("$ref");
            schema.putArray("anyOf").add(NODES.objectNode().set("$ref", ref)).add(nullType);
            return schema;
        }
        ObjectNode out = NODES.objectNode();
        out.putArray("anyOf").add(schema).add(nullType);
        return out;
    }

    private JsonNode strictNode(JsonNode node, boolean useSite) {
        if (!node.isObject()) return node;
        ObjectNode out = NODES.objectNode();
        for (Iterator<Map.Entry<String, JsonNode>> it = node.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            String key = entry.getKey();
            JsonNode value = entry.getValue();
            if (SCHEMA_VALUES.contains(key) && value.isObject()) {
                out.set(key, strictNode(value, USE_SITE_VALUES.contains(key)));
            } else if (SCHEMA_ARRAYS.contains(key) && value.isArray()) {
                ArrayNode members = out.putArray(key);
                boolean wrap = USE_SITE_ARRAYS.contains(key);
                value.forEach(member -> members.add(strictNode(member, wrap)));
            } else if (SCHEMA_MAPS.contains(key) && value.isObject()) {
                ObjectNode map = out.putObject(key);
                value.fields().forEachRemaining(p -> map.set(p.getKey(), strictNode(p.getValue(), "properties".equals(key))));
            } else {
                out.set(key, value);
            }
        }
        if (!useSite || declaresOpen(out, new HashSet<>())) return out;
        ObjectNode wrapped = NODES.objectNode();
        wrapped.putArray("allOf").add(out);
        wrapped.put("unevaluatedProperties", false);
        return wrapped;
    }

    /** True when S, following {@code $ref} and {@code allOf}, declares how extra properties behave. */
    private boolean declaresOpen(JsonNode schema, Set<String> seen) {
        if (schema == null || !schema.isObject()) return false;
        for (String key : OPEN) if (schema.has(key)) return true;
        String ref = schema.path("$ref").asText(null);
        if (ref != null && seen.add(ref) && declaresOpen(resolveRef(ref), seen)) return true;
        for (JsonNode member : schema.path("allOf")) if (declaresOpen(member, seen)) return true;
        return false;
    }

    private boolean hidden(JsonNode property, Direction direction) {
        String flag = direction == Direction.RESPONSE ? "writeOnly" : "readOnly";
        Set<String> seen = new HashSet<>();
        for (JsonNode current = property; current != null && current.isObject(); ) {
            if (current.path(flag).asBoolean(false)) return true;
            String ref = current.path("$ref").asText(null);
            if (ref == null || !seen.add(ref)) return false;
            current = resolveRef(ref);
        }
        return false;
    }

    /** Resolves a local pointer in the raw document; {@code #/$defs/X} means {@code #/components/schemas/X}. */
    private JsonNode resolveRef(String ref) {
        if (ref.startsWith(DEFS_REF)) ref = COMPONENT_REF + ref.substring(DEFS_REF.length());
        if (!ref.startsWith("#/")) return null;
        JsonNode found = doc.at(URLDecoder.decode(ref.substring(1).replace("+", "%2B"), StandardCharsets.UTF_8));
        return found.isMissingNode() ? null : found;
    }

    private static boolean contains(JsonNode values, JsonNode value) {
        for (JsonNode candidate : values) if (candidate.equals(value)) return true;
        return false;
    }
}
