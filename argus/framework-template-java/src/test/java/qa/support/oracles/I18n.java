package qa.support.oracles;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

/**
 * Character-set round-trip oracle, the Java port of i18n.ts. A stored value must come back
 * code point for code point: a byte-truncating column, a stripped 4-byte character, or a
 * silent NFC/NFD normalization is RED. A length limit counts characters (code points), never
 * UTF-8 bytes. A RED throws {@link AssertionError}; misuse throws
 * {@link IllegalArgumentException}.
 */
public final class I18n {

    public record I18nVector(String label, String value) {}

    /** Submits one value; returns true when the product accepted it. */
    @FunctionalInterface
    public interface Submit {
        boolean accepted(String value);
    }

    /** Reads back the value the product stored (a closure over the created id or the profile read works). */
    @FunctionalInterface
    public interface ReadBack {
        String stored();
    }

    /** The vectors i18nCharset round-trips, in order. */
    public static final List<I18nVector> I18N_VECTORS = List.of(
            new I18nVector("diacritics.0", Identity.IDENTITY_VECTORS.diacritics().get(0)),
            new I18nVector("diacritics.1", Identity.IDENTITY_VECTORS.diacritics().get(1)),
            new I18nVector("emoji", Identity.IDENTITY_VECTORS.unicodeEdge().emoji()),
            new I18nVector("nfd", Identity.IDENTITY_VECTORS.unicodeEdge().nfd()));

    // U+017C (z with dot above): one code point, one UTF-16 unit, two UTF-8 bytes, so every
    // sane character count agrees and only a byte count differs.
    private static final String MULTI_BYTE = "ż";
    private static final int MAX_LISTED_CODE_POINTS = 24;

    private I18n() {}

    public static List<String> i18nCharset(Submit submit, ReadBack readBack) {
        return i18nCharset(submit, readBack, null);
    }

    /**
     * Round-trips every {@link #I18N_VECTORS} entry: each vector must be accepted and read back
     * with exactly the same code points. With {@code maxLength}, maxLength multi-byte
     * characters must be accepted and read back intact, and maxLength + 1 must be refused.
     * Returns the checked labels. Messages list code points, never the raw value.
     */
    public static List<String> i18nCharset(Submit submit, ReadBack readBack, Integer maxLength) {
        if (submit == null || readBack == null) throw new IllegalArgumentException("i18nCharset: submit and readBack must not be null");
        if (maxLength != null && maxLength < 1) throw new IllegalArgumentException("i18nCharset: maxLength must be a positive integer, got " + maxLength);
        List<I18nVector> vectors = new ArrayList<>(I18N_VECTORS);
        if (maxLength != null) vectors.add(new I18nVector("max-length." + maxLength, MULTI_BYTE.repeat(maxLength)));
        List<String> failures = new ArrayList<>();
        for (I18nVector vector : vectors) {
            if (!submit.accepted(vector.value())) {
                failures.add(vector.label() + ": refused " + describe(vector.value()));
                continue;
            }
            String stored = readBack.stored();
            if (stored == null) throw new IllegalArgumentException("i18nCharset: readBack must return the stored string");
            if (!Arrays.equals(stored.codePoints().toArray(), vector.value().codePoints().toArray())) {
                failures.add(vector.label() + ": sent " + describe(vector.value()) + ", read back " + describe(stored));
            }
        }
        List<String> checked = new ArrayList<>(vectors.stream().map(I18nVector::label).toList());
        if (maxLength != null) {
            int over = maxLength + 1;
            if (submit.accepted(MULTI_BYTE.repeat(over))) failures.add("max-length." + over + ": accepted maxLength + 1 = " + over + " characters");
            checked.add("max-length." + over);
        }
        if (!failures.isEmpty()) {
            throw new AssertionError("i18nCharset: the value did not round-trip character for character\n" + String.join("\n", failures));
        }
        return List.copyOf(checked);
    }

    /** "5 code points (11 UTF-8 bytes): U+017B U+00F3 ...", never the raw value. */
    private static String describe(String value) {
        int[] points = value.codePoints().toArray();
        String listed = Arrays.stream(points).limit(MAX_LISTED_CODE_POINTS)
                .mapToObj(point -> String.format(Locale.ROOT, "U+%04X", point)).collect(Collectors.joining(" "));
        String more = points.length > MAX_LISTED_CODE_POINTS ? " …" : "";
        return points.length + " code points (" + value.getBytes(StandardCharsets.UTF_8).length + " UTF-8 bytes): " + listed + more;
    }
}
