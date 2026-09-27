package qa.support.oracles;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.BigIntegerNode;
import com.fasterxml.jackson.databind.node.BooleanNode;
import com.fasterxml.jackson.databind.node.DecimalNode;
import com.fasterxml.jackson.databind.node.IntNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.LongNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Invalid equivalence partitions generated from a field schema, the Java port of
 * partitions.ts: one invalid value per declared constraint, each isolated as far as the
 * schema allows, with fixed labels in a fixed order that every runtime port keeps. A
 * partition generator asserts nothing itself; a test sends every value and expects the
 * documented rejection (one exact status code).
 *
 * <p>Input is a raw OpenAPI 3.0 or 3.1 field schema as a Jackson tree: {@code nullable: true},
 * a type list such as {@code ["string", "null"]}, and the boolean exclusiveMinimum and
 * exclusiveMaximum form are read as written. Resolve {@code $ref} and allOf/oneOf/anyOf into
 * one field schema first. Numbers are exact decimals ({@link BigDecimal}); every value is a
 * fresh JSON node, ready to send as a request body. Misuse throws
 * {@link IllegalArgumentException}.
 */
public final class Partitions {

    /** One invalid value and the fixed label of the constraint it breaks. */
    public record Partition(String label, JsonNode value) {}

    /** The candidates string.pattern-mismatch tries, in order; the first one the pattern rejects wins. */
    public static final List<String> PATTERN_MISMATCH_CANDIDATES = List.of("", " ", "!", "0", "a", "\0");

    /** string.above-max-length is omitted above this many characters: that probe is a load test, not a partition. */
    public static final int MAX_GENERATED_LENGTH = 1_048_576;

    private static final Set<String> TYPES = Set.of("string", "integer", "number", "boolean", "object", "array");
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;
    private static final BigDecimal HALF = new BigDecimal("0.5");
    private static final BigDecimal TWO = BigDecimal.valueOf(2);
    private static final long UNSAFE_INTEGER = 1L << 53;

    private record Bounds(BigDecimal minimum, BigDecimal maximum, BigDecimal exclusiveMinimum, BigDecimal exclusiveMaximum) {
        boolean any() {
            return minimum != null || maximum != null || exclusiveMinimum != null || exclusiveMaximum != null;
        }
    }

    private record FieldType(String type, boolean nullable) {}

    private enum Direction { BELOW, ABOVE, AT_OR_ABOVE, AT_OR_BELOW }

    private Partitions() {}

    public static List<Partition> invalidPartitions(JsonNode fieldSchema) {
        return invalidPartitions(fieldSchema, null);
    }

    /**
     * One invalid value per declared constraint, in this order:
     * <ul>
     *   <li>format email: email.missing-at, email.missing-domain, email.missing-tld,
     *       email.double-at, email.embedded-whitespace;</li>
     *   <li>string: string.below-min-length ('a' repeated minLength - 1),
     *       string.above-max-length, string.pattern-mismatch (the first
     *       PATTERN_MISMATCH_CANDIDATES entry the pattern rejects; omitted when it accepts
     *       all), string.empty (minLength &gt;= 1), type.number-for-string;</li>
     *   <li>integer and number: number.below-minimum, number.above-maximum,
     *       number.exclusive-minimum-equal, number.exclusive-maximum-equal,
     *       number.fractional-for-integer, number.unsafe-integer (2^53, an integer without a
     *       maximum), number.multiple-of-violation, type.string-for-number (a valid value as a
     *       string);</li>
     *   <li>enum: enum.out-of-enum; boolean: type.string-for-boolean;</li>
     *   <li>type.null-for-non-nullable, last, whenever the schema constrains the type and null
     *       is not allowed.</li>
     * </ul>
     * {@code numberStep} is the smallest unit of a bounded {@code number} field without
     * multipleOf (money 0.01, a percentage 1) and is required for such a field; an integer's
     * step is 1 (or its integer multipleOf) and a multipleOf is its own step. Pass null when
     * no step applies.
     */
    public static List<Partition> invalidPartitions(JsonNode fieldSchema, BigDecimal numberStep) {
        return List.copyOf(inContext("invalidPartitions", () -> fieldPartitions(fieldSchema, numberStep)));
    }

    public static List<Partition> invalidObjectPartitions(JsonNode objectSchema, JsonNode validExample) {
        return invalidObjectPartitions(objectSchema, validExample, null, Map.of());
    }

    /**
     * Invalid request bodies for an object schema, built from a valid example:
     * object.missing-required.&lt;field&gt; for each required field (in {@code required}
     * order), object.extra-field (unless additionalProperties or patternProperties allow extra
     * fields), object.null-body, object.wrong-type-body, then field.&lt;name&gt;.&lt;label&gt;
     * for every property in schema order with that one property replaced by an
     * invalidPartitions value. readOnly properties are skipped: they are not part of a
     * request. {@code numberSteps} overrides {@code numberStep} per property. Every value is
     * a fresh deep copy.
     */
    public static List<Partition> invalidObjectPartitions(JsonNode objectSchema, JsonNode validExample,
                                                          BigDecimal numberStep, Map<String, BigDecimal> numberSteps) {
        ObjectNode schema = inContext("invalidObjectPartitions", () -> requireSchema(objectSchema));
        JsonNode declared = schema.get("type");
        if (declared != null && !"object".equals(declared.textValue()) && !(declared.isArray() && contains(declared, "object"))) {
            throw new IllegalArgumentException("invalidObjectPartitions: the schema must describe an object, got type " + declared);
        }
        ObjectNode properties = schema.get("properties") instanceof ObjectNode object ? object : NODES.objectNode();
        JsonNode required = schema.get("required") instanceof ArrayNode array ? array : NODES.arrayNode();
        if (!(validExample instanceof ObjectNode example)) throw new IllegalArgumentException("invalidObjectPartitions: validExample must be a JSON object");
        for (JsonNode name : required) {
            if (!name.isTextual()) throw new IllegalArgumentException("invalidObjectPartitions: required must list property names");
            if (!example.has(name.textValue())) {
                throw new IllegalArgumentException("invalidObjectPartitions: validExample lacks the required field " + name.textValue());
            }
        }
        List<Partition> partitions = new ArrayList<>();
        for (JsonNode name : required) {
            ObjectNode body = example.deepCopy();
            body.remove(name.textValue());
            partitions.add(new Partition("object.missing-required." + name.textValue(), body));
        }
        JsonNode additional = schema.get("additionalProperties");
        boolean openObject = isTrue(additional) || (additional != null && additional.isObject()) || schema.get("patternProperties") instanceof ObjectNode;
        if (!openObject) {
            String extra = "argusUndocumentedField";
            while (properties.has(extra) || example.has(extra)) extra += "X";
            partitions.add(new Partition("object.extra-field", example.deepCopy().put(extra, "argus")));
        }
        partitions.add(new Partition("object.null-body", NullNode.getInstance()));
        partitions.add(new Partition("object.wrong-type-body", NODES.arrayNode().add(example.deepCopy())));
        for (Iterator<Map.Entry<String, JsonNode>> it = properties.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> property = it.next();
            String name = property.getKey();
            if (property.getValue().isObject() && isTrue(property.getValue().get("readOnly"))) continue;
            BigDecimal own = numberSteps == null ? null : numberSteps.get(name);
            BigDecimal step = own != null ? own : numberStep;
            List<Partition> field = inContext("invalidObjectPartitions: property " + name, () -> fieldPartitions(property.getValue(), step));
            for (Partition partition : field) {
                ObjectNode body = example.deepCopy();
                body.set(name, partition.value());
                partitions.add(new Partition("field." + name + "." + partition.label(), body));
            }
        }
        return List.copyOf(partitions);
    }

    private static List<Partition> fieldPartitions(JsonNode fieldSchema, BigDecimal numberStep) {
        ObjectNode schema = requireSchema(fieldSchema);
        FieldType field = fieldType(schema);
        String type = field.type();
        List<Partition> partitions = new ArrayList<>();
        if ("string".equals(type)) stringPartitions(schema, partitions);
        if ("integer".equals(type) || "number".equals(type)) numberPartitions(schema, "integer".equals(type), numberStep, partitions);
        JsonNode enumeration = schema.get("enum");
        boolean enumerated = enumeration != null && enumeration.isArray();
        if (enumerated) {
            JsonNode outside = outOfEnum(enumeration, type);
            if (outside != null) partitions.add(new Partition("enum.out-of-enum", outside));
        }
        if ("boolean".equals(type)) partitions.add(new Partition("type.string-for-boolean", TextNode.valueOf("true")));
        if ((type != null || enumerated) && !field.nullable()) partitions.add(new Partition("type.null-for-non-nullable", NullNode.getInstance()));
        return partitions;
    }

    private static void stringPartitions(ObjectNode schema, List<Partition> out) {
        Long minLength = optionalCount(schema, "minLength");
        Long maxLength = optionalCount(schema, "maxLength");
        if ("email".equals(textOf(schema.get("format")))) {
            for (Identity.InvalidEmail email : Identity.INVALID_EMAILS) out.add(new Partition(email.label(), TextNode.valueOf(email.value())));
        }
        if (minLength != null && minLength >= 1) {
            if (minLength - 1 > Integer.MAX_VALUE - 8) throw new IllegalArgumentException("minLength " + minLength + " is too large to generate a shorter string");
            out.add(new Partition("string.below-min-length", TextNode.valueOf("a".repeat((int) (minLength - 1)))));
        }
        if (maxLength != null && maxLength < MAX_GENERATED_LENGTH) {
            out.add(new Partition("string.above-max-length", TextNode.valueOf("a".repeat((int) (maxLength + 1)))));
        }
        if (schema.has("pattern")) {
            Pattern pattern = compilePattern(schema.get("pattern"));
            PATTERN_MISMATCH_CANDIDATES.stream().filter(candidate -> !pattern.matcher(candidate).find()).findFirst()
                    .ifPresent(mismatch -> out.add(new Partition("string.pattern-mismatch", TextNode.valueOf(mismatch))));
        }
        if (minLength != null && minLength >= 1) out.add(new Partition("string.empty", TextNode.valueOf("")));
        out.add(new Partition("type.number-for-string", IntNode.valueOf(1)));
    }

    private static void numberPartitions(ObjectNode schema, boolean integer, BigDecimal numberStep, List<Partition> out) {
        Bounds bounds = readBounds(schema);
        BigDecimal multipleOf = optionalNumber(schema, "multipleOf");
        if (multipleOf != null && multipleOf.signum() <= 0) throw new IllegalArgumentException("multipleOf must be greater than 0");
        if (numberStep != null && numberStep.signum() <= 0) {
            throw new IllegalArgumentException("numberStep must be a number > 0, got " + Boundary.normalize(numberStep).toPlainString());
        }
        // The grid every valid value sits on: multipleOf, 1 for a plain integer, none otherwise.
        BigDecimal grid = integer ? (multipleOf != null && isIntegral(multipleOf) ? multipleOf : BigDecimal.ONE) : multipleOf;
        if (grid == null && bounds.any() && numberStep == null) {
            throw new IllegalArgumentException("a bounded number field without multipleOf needs numberStep, the domain's smallest unit"
                    + " (money 0.01, a percentage 1); never a blind +-1");
        }
        BigDecimal step = grid != null ? grid : numberStep;
        BigDecimal anchor = validAnchor(bounds, grid, step);
        Predicate<BigDecimal> upper = value -> (bounds.maximum() == null || value.compareTo(bounds.maximum()) <= 0)
                && (bounds.exclusiveMaximum() == null || value.compareTo(bounds.exclusiveMaximum()) < 0);

        if (bounds.minimum() != null) {
            out.add(new Partition("number.below-minimum", number(grid != null ? onGrid(bounds.minimum(), grid, Direction.BELOW) : bounds.minimum().subtract(step))));
        }
        if (bounds.maximum() != null) {
            out.add(new Partition("number.above-maximum", number(grid != null ? onGrid(bounds.maximum(), grid, Direction.ABOVE) : bounds.maximum().add(step))));
        }
        if (bounds.exclusiveMinimum() != null) out.add(new Partition("number.exclusive-minimum-equal", number(bounds.exclusiveMinimum())));
        if (bounds.exclusiveMaximum() != null) out.add(new Partition("number.exclusive-maximum-equal", number(bounds.exclusiveMaximum())));
        if (integer) {
            BigDecimal fractional = upper.test(anchor.add(HALF)) ? anchor.add(HALF) : anchor.subtract(HALF);
            out.add(new Partition("number.fractional-for-integer", number(fractional)));
        }
        if (integer && bounds.maximum() == null && bounds.exclusiveMaximum() == null) {
            out.add(new Partition("number.unsafe-integer", LongNode.valueOf(UNSAFE_INTEGER)));
        }
        if (multipleOf != null) {
            BigDecimal delta = integer ? BigDecimal.ONE : multipleOf.divide(TWO);
            BigDecimal candidate = upper.test(anchor.add(delta)) ? anchor.add(delta) : anchor.subtract(delta);
            if (candidate.remainder(multipleOf).signum() != 0) out.add(new Partition("number.multiple-of-violation", number(candidate)));
        }
        out.add(new Partition("type.string-for-number", TextNode.valueOf(Boundary.normalize(anchor).toPlainString())));
    }

    private static Bounds readBounds(ObjectNode schema) {
        BigDecimal minimum = optionalNumber(schema, "minimum");
        BigDecimal maximum = optionalNumber(schema, "maximum");
        BigDecimal exclusiveMinimum = null;
        BigDecimal exclusiveMaximum = null;
        // OpenAPI 3.0 writes an exclusive bound as `minimum` plus `exclusiveMinimum: true`; read it
        // as the 3.1 numeric form so both produce the same partitions.
        JsonNode lower = schema.get("exclusiveMinimum");
        if (isTrue(lower)) {
            if (minimum == null) throw new IllegalArgumentException("exclusiveMinimum: true needs minimum");
            exclusiveMinimum = minimum;
            minimum = null;
        } else if (lower != null && !isFalse(lower)) {
            exclusiveMinimum = optionalNumber(schema, "exclusiveMinimum");
        }
        JsonNode higher = schema.get("exclusiveMaximum");
        if (isTrue(higher)) {
            if (maximum == null) throw new IllegalArgumentException("exclusiveMaximum: true needs maximum");
            exclusiveMaximum = maximum;
            maximum = null;
        } else if (higher != null && !isFalse(higher)) {
            exclusiveMaximum = optionalNumber(schema, "exclusiveMaximum");
        }
        return new Bounds(minimum, maximum, exclusiveMinimum, exclusiveMaximum);
    }

    /** The smallest valid value at or above the lower bound (on the grid); 0 when unbounded. */
    private static BigDecimal validAnchor(Bounds bounds, BigDecimal grid, BigDecimal step) {
        if (bounds.minimum() != null) return grid != null ? onGrid(bounds.minimum(), grid, Direction.AT_OR_ABOVE) : bounds.minimum();
        if (bounds.exclusiveMinimum() != null) return grid != null ? onGrid(bounds.exclusiveMinimum(), grid, Direction.ABOVE) : bounds.exclusiveMinimum().add(step);
        if (bounds.maximum() != null) return grid != null ? onGrid(bounds.maximum(), grid, Direction.AT_OR_BELOW) : bounds.maximum();
        if (bounds.exclusiveMaximum() != null) return grid != null ? onGrid(bounds.exclusiveMaximum(), grid, Direction.BELOW) : bounds.exclusiveMaximum().subtract(step);
        return BigDecimal.ZERO;
    }

    /** The nearest multiple of {@code grid} relative to {@code value}, computed exactly. */
    private static BigDecimal onGrid(BigDecimal value, BigDecimal grid, Direction direction) {
        BigDecimal floor = value.divide(grid, 0, RoundingMode.FLOOR);
        BigDecimal ceiling = value.divide(grid, 0, RoundingMode.CEILING);
        BigDecimal k = switch (direction) {
            case BELOW -> ceiling.subtract(BigDecimal.ONE);
            case ABOVE -> floor.add(BigDecimal.ONE);
            case AT_OR_ABOVE -> ceiling;
            case AT_OR_BELOW -> floor;
        };
        return k.multiply(grid);
    }

    private static JsonNode outOfEnum(JsonNode values, String type) {
        List<JsonNode> members = new ArrayList<>();
        values.forEach(value -> {
            if (!value.isNull()) members.add(value);
        });
        if (members.isEmpty()) return null;
        Predicate<JsonNode> has = candidate -> members.stream().anyMatch(member -> same(member, candidate));
        if ("boolean".equals(type) || members.stream().allMatch(JsonNode::isBoolean)) {
            for (JsonNode candidate : List.of(BooleanNode.FALSE, BooleanNode.TRUE)) if (!has.test(candidate)) return candidate;
            return null;
        }
        if ("integer".equals(type) || "number".equals(type) || members.stream().allMatch(JsonNode::isNumber)) {
            BigDecimal largest = BigDecimal.ZERO;
            for (JsonNode member : members) if (member.isNumber() && member.decimalValue().compareTo(largest) > 0) largest = member.decimalValue();
            BigDecimal candidate = largest.setScale(0, RoundingMode.FLOOR).add(BigDecimal.ONE);
            while (has.test(number(candidate))) candidate = candidate.add(BigDecimal.ONE);
            return number(candidate);
        }
        String candidate = "argus-out-of-enum";
        while (has.test(TextNode.valueOf(candidate))) candidate += "-x";
        return TextNode.valueOf(candidate);
    }

    /** JavaScript strict equality over JSON scalars: numbers compare by value, 1 equals 1.0. */
    private static boolean same(JsonNode left, JsonNode right) {
        if (left.isNumber() && right.isNumber()) return left.decimalValue().compareTo(right.decimalValue()) == 0;
        return left.equals(right);
    }

    private static FieldType fieldType(ObjectNode schema) {
        JsonNode declared = schema.get("type");
        List<String> list = new ArrayList<>();
        if (declared != null) {
            if (declared.isTextual()) {
                list.add(declared.textValue());
            } else if (declared.isArray()) {
                for (JsonNode entry : declared) {
                    if (!entry.isTextual()) throw new IllegalArgumentException("type must be a string or a list of strings");
                    list.add(entry.textValue());
                }
            } else {
                throw new IllegalArgumentException("type must be a string or a list of strings");
            }
        }
        List<String> types = list.stream().filter(entry -> !"null".equals(entry)).toList();
        if (types.size() > 1) throw new IllegalArgumentException("one field type is required, got " + declared);
        String type = types.isEmpty() ? null : types.get(0);
        if (type != null && !TYPES.contains(type)) throw new IllegalArgumentException("unsupported type " + TextNode.valueOf(type));
        JsonNode enumeration = schema.get("enum");
        boolean nullable = isTrue(schema.get("nullable")) || list.contains("null")
                || (enumeration != null && enumeration.isArray() && contains(enumeration, null));
        return new FieldType(type, nullable);
    }

    private static ObjectNode requireSchema(JsonNode schema) {
        if (!(schema instanceof ObjectNode object)) throw new IllegalArgumentException("the schema must be a schema object");
        for (String keyword : List.of("$ref", "allOf", "oneOf", "anyOf")) {
            if (object.has(keyword)) throw new IllegalArgumentException("resolve " + keyword + " into one schema first");
        }
        return object;
    }

    /** Runs {@code body}, prefixing a usage error with {@code context}. */
    private static <T> T inContext(String context, Supplier<T> body) {
        try {
            return body.get();
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(context + ": " + error.getMessage(), error);
        }
    }

    private static Pattern compilePattern(JsonNode pattern) {
        if (pattern == null || !pattern.isTextual()) throw new IllegalArgumentException("pattern must be a string");
        // JSON Schema patterns are not implicitly anchored; find() matches like ECMA-262 test().
        try {
            return Pattern.compile(pattern.textValue());
        } catch (PatternSyntaxException invalid) {
            throw new IllegalArgumentException("pattern " + pattern + " is not a valid regular expression");
        }
    }

    private static BigDecimal optionalNumber(ObjectNode schema, String label) {
        JsonNode value = schema.get(label);
        if (value == null) return null;
        if (!value.isNumber() || ((value.isDouble() || value.isFloat()) && !Double.isFinite(value.doubleValue()))) {
            throw new IllegalArgumentException(label + " must be a finite number, got " + value);
        }
        // DoubleNode reads through Double.toString, so 0.07 stays 0.07.
        return value.decimalValue();
    }

    private static Long optionalCount(ObjectNode schema, String label) {
        JsonNode value = schema.get(label);
        if (value == null) return null;
        BigDecimal count = value.isNumber() && (!value.isDouble() || Double.isFinite(value.doubleValue())) ? value.decimalValue() : null;
        if (count == null || count.signum() < 0 || !isIntegral(count) || count.compareTo(BigDecimal.valueOf(Long.MAX_VALUE)) > 0) {
            throw new IllegalArgumentException(label + " must be a non-negative integer, got " + value);
        }
        return count.longValueExact();
    }

    /** An exact JSON number: an integer node for an integral value, else a decimal without trailing zeros. */
    private static JsonNode number(BigDecimal value) {
        BigDecimal normalized = Boundary.normalize(value);
        if (normalized.scale() > 0) return DecimalNode.valueOf(normalized);
        BigInteger integral = normalized.toBigIntegerExact();
        if (integral.bitLength() < Integer.SIZE) return IntNode.valueOf(integral.intValue());
        if (integral.bitLength() < Long.SIZE) return LongNode.valueOf(integral.longValue());
        return BigIntegerNode.valueOf(integral);
    }

    private static boolean isIntegral(BigDecimal value) {
        return value.signum() == 0 || value.stripTrailingZeros().scale() <= 0;
    }

    private static boolean contains(JsonNode array, String text) {
        for (JsonNode entry : array) {
            if (text == null ? entry.isNull() : text.equals(entry.textValue())) return true;
        }
        return false;
    }

    private static boolean isTrue(JsonNode node) {
        return node != null && node.isBoolean() && node.booleanValue();
    }

    private static boolean isFalse(JsonNode node) {
        return node != null && node.isBoolean() && !node.booleanValue();
    }

    private static String textOf(JsonNode node) {
        return node == null ? null : node.textValue();
    }
}
