package qa.support.oracles;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Boundary value and exact-sum oracles, the Java port of boundary.ts. The step is the
 * domain's smallest unit (money 0.01, a count 1), never a blind integer +-1, and every sum is
 * compared in scaled integers: floating-point money drifts by a penny exactly where these
 * oracles look. A RED throws {@link AssertionError}; misuse throws
 * {@link IllegalArgumentException}.
 */
public final class Boundary {

    /** Answers one probe value; returns true when the product accepted it. */
    @FunctionalInterface
    public interface Probe {
        boolean accepts(BigDecimal value);
    }

    /** One probed value with its documented and observed outcome, each {@code accepted} or {@code rejected}. */
    public record BoundaryPoint(BigDecimal value, String expected, String actual) {}

    public record BoundaryPoints(BoundaryPoint below, BoundaryPoint at, BoundaryPoint above) {}

    /** The parts' sum and the total, both formatted at the minor-unit precision. */
    public record MoneyReconciliation(String sum, String total) {}

    public static final String ACCEPTED = "accepted";
    public static final String REJECTED = "rejected";

    private static final Pattern PLAIN_DECIMAL = Pattern.compile("^([+-]?)(\\d+)(?:\\.(\\d+))?$");
    private static final int MAX_PLACES = 18;

    private Boundary() {}

    /**
     * Three-point boundary value analysis: probes B - step, B, and B + step, in that order, and
     * requires each documented outcome. The probe values are exact decimals without trailing
     * zeros, so boundary 0.07 with step 0.01 probes exactly 0.06, 0.07, and 0.08. Call it once
     * per edge of a range.
     */
    public static BoundaryPoints boundary3(BigDecimal boundary, BigDecimal step, Probe probe,
                                           boolean acceptBelow, boolean acceptAt, boolean acceptAbove) {
        if (boundary == null) throw new IllegalArgumentException("boundary3: boundary must be a number, got null");
        if (step == null || step.signum() <= 0) {
            throw new IllegalArgumentException("boundary3: step must be a number > 0 (the domain's smallest unit), got " + plain(step));
        }
        if (probe == null) throw new IllegalArgumentException("boundary3: probe must not be null");
        BoundaryPoint below = point(probe, normalize(boundary.subtract(step)), acceptBelow);
        BoundaryPoint at = point(probe, normalize(boundary), acceptAt);
        BoundaryPoint above = point(probe, normalize(boundary.add(step)), acceptAbove);
        List<String> wrong = new ArrayList<>();
        for (BoundaryPoint point : List.of(below, at, above)) {
            if (!point.expected().equals(point.actual())) {
                wrong.add("value " + point.value().toPlainString() + " expected " + point.expected() + ", got " + point.actual());
            }
        }
        if (!wrong.isEmpty()) {
            throw new AssertionError("boundary3 at " + plain(boundary) + " (step " + plain(step) + "): " + String.join("; ", wrong));
        }
        return new BoundaryPoints(below, at, above);
    }

    public static MoneyReconciliation moneyReconciles(List<?> parts, Object total) {
        return moneyReconciles(parts, total, 2);
    }

    /**
     * Money reconciles to the minor unit: the parts, parsed as decimal strings into integer
     * minor units, must sum exactly to the total. Each amount is a decimal string or a
     * {@link Number}; a double is read through its shortest decimal form
     * ({@link BigDecimal#valueOf(double)}). An amount with more fractional digits than
     * {@code minorUnits} is RED, which is how floating-point money such as
     * 0.30000000000000004 surfaces.
     */
    public static MoneyReconciliation moneyReconciles(List<?> parts, Object total, int minorUnits) {
        if (minorUnits < 0 || minorUnits > MAX_PLACES) {
            throw new IllegalArgumentException("moneyReconciles: minorUnits must be an integer from 0 to 18, got " + minorUnits);
        }
        if (parts == null) throw new IllegalArgumentException("moneyReconciles: parts must be a list of amounts");
        List<String> problems = new ArrayList<>();
        BigInteger sum = BigInteger.ZERO;
        for (int index = 0; index < parts.size(); index++) {
            BigInteger minor = toScaled(parts.get(index), minorUnits, "part " + index, problems, "moneyReconciles");
            if (minor != null) sum = sum.add(minor);
        }
        BigInteger expected = toScaled(total, minorUnits, "total", problems, "moneyReconciles");
        if (!problems.isEmpty()) throw new AssertionError("moneyReconciles: unusable amounts: " + String.join("; ", problems));
        if (!sum.equals(expected)) {
            throw new AssertionError("moneyReconciles: the parts sum to " + formatScaled(sum, minorUnits) + ", the total is "
                    + formatScaled(expected, minorUnits) + " (difference " + formatScaled(sum.subtract(expected), minorUnits) + ")");
        }
        return new MoneyReconciliation(formatScaled(sum, minorUnits), formatScaled(expected, minorUnits));
    }

    public static String percentagesSumTo100(List<?> values) {
        return percentagesSumTo100(values, 0);
    }

    /**
     * A percentage breakdown sums to exactly 100: each value is scaled to an integer at
     * {@code decimals} places and the sum must equal 100 * 10^decimals. A value with more
     * fractional digits than {@code decimals} is RED. Returns the formatted sum.
     */
    public static String percentagesSumTo100(List<?> values, int decimals) {
        if (decimals < 0 || decimals > MAX_PLACES) {
            throw new IllegalArgumentException("percentagesSumTo100: decimals must be an integer from 0 to 18, got " + decimals);
        }
        if (values == null || values.isEmpty()) throw new IllegalArgumentException("percentagesSumTo100: values must be a non-empty list");
        List<String> problems = new ArrayList<>();
        BigInteger sum = BigInteger.ZERO;
        for (int index = 0; index < values.size(); index++) {
            BigInteger scaled = toScaled(values.get(index), decimals, "value " + index, problems, "percentagesSumTo100");
            if (scaled != null) sum = sum.add(scaled);
        }
        if (!problems.isEmpty()) throw new AssertionError("percentagesSumTo100: unusable values: " + String.join("; ", problems));
        BigInteger hundred = BigInteger.valueOf(100).multiply(BigInteger.TEN.pow(decimals));
        if (!sum.equals(hundred)) {
            throw new AssertionError("percentagesSumTo100: the values sum to " + formatScaled(sum, decimals) + ", not exactly 100");
        }
        return formatScaled(sum, decimals);
    }

    private static BoundaryPoint point(Probe probe, BigDecimal value, boolean expected) {
        return new BoundaryPoint(value, verdict(expected), verdict(probe.accepts(value)));
    }

    /** Parses a decimal amount into an integer at {@code places}; a problem is recorded instead of thrown. */
    private static BigInteger toScaled(Object value, int places, String label, List<String> problems, String context) {
        String text = decimalText(value, label, context);
        Matcher match = PLAIN_DECIMAL.matcher(text);
        if (!match.matches()) {
            problems.add(label + " " + Http.JSON.getNodeFactory().textNode(text) + " is not a plain decimal");
            return null;
        }
        String fraction = match.group(3) == null ? "" : match.group(3);
        if (fraction.length() > places && !fraction.substring(places).matches("0*")) {
            problems.add(label + " " + text + " has more than " + places + " decimal places");
            return null;
        }
        String kept = fraction.length() > places ? fraction.substring(0, places) : fraction + "0".repeat(places - fraction.length());
        BigInteger scaled = new BigInteger(match.group(2)).multiply(BigInteger.TEN.pow(places)).add(kept.isEmpty() ? BigInteger.ZERO : new BigInteger(kept));
        return "-".equals(match.group(1)) ? scaled.negate() : scaled;
    }

    private static String decimalText(Object value, String label, String context) {
        if (value instanceof String text) return text;
        if (value instanceof BigDecimal decimal) return decimal.toPlainString();
        if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number)) return String.valueOf(number);
            return value instanceof Float single ? new BigDecimal(Float.toString(single)).toPlainString() : BigDecimal.valueOf(number).toPlainString();
        }
        if (value instanceof Number number) return number.toString();
        throw new IllegalArgumentException(context + ": " + label + " must be a decimal string or a number, got "
                + (value == null ? "null" : value.getClass().getSimpleName()));
    }

    private static String formatScaled(BigInteger value, int places) {
        boolean negative = value.signum() < 0;
        String digits = value.abs().toString();
        if (digits.length() < places + 1) digits = "0".repeat(places + 1 - digits.length()) + digits;
        String whole = digits.substring(0, digits.length() - places);
        String fraction = places > 0 ? "." + digits.substring(digits.length() - places) : "";
        return (negative ? "-" : "") + whole + fraction;
    }

    /** The same value without trailing zeros and never in exponent form: 10.0 is 10, 0.060 is 0.06. */
    static BigDecimal normalize(BigDecimal value) {
        BigDecimal stripped = value.signum() == 0 ? BigDecimal.ZERO : value.stripTrailingZeros();
        return stripped.scale() < 0 ? stripped.setScale(0) : stripped;
    }

    private static String plain(BigDecimal value) {
        return value == null ? "null" : normalize(value).toPlainString();
    }

    private static String verdict(boolean value) {
        return value ? ACCEPTED : REJECTED;
    }
}
