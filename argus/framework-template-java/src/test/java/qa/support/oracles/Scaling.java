package qa.support.oracles;

import io.restassured.response.Response;

import java.math.BigDecimal;
import java.math.MathContext;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Callable;

/**
 * Collection-scaling oracles, the Java port of scaling.ts. An N+1 query or an unpaginated
 * collection makes a read grow with the collection; a healthy paginated read stays nearly
 * flat. {@link #analyzeScaling} is a pure function: it takes the median time and payload per
 * collection size and fits the growth exponent between the smallest and the largest size,
 * {@code log(m_last / m_first) / log(s_last / s_first)} (1 is linear, 0 is flat).
 * {@link #n1Scaling} measures and asserts it. A RED throws {@link AssertionError}; misuse
 * throws {@link IllegalArgumentException}.
 */
public final class Scaling {

    /** One timed read of a collection holding {@code size} items. */
    public record Sample(int size, double ms, long bytes) {}

    /** One timed read: wall time in milliseconds and the body length in bytes. */
    public record Measurement(double ms, long bytes) {}

    /** One timed REST Assured call, with the response kept for its own exact-status check. */
    public record Timed(Response response, double ms, long bytes) {
        public Measurement measurement() {
            return new Measurement(ms, bytes);
        }
    }

    /** The median time and payload of the runs at one size. */
    public record SizeMedian(int size, int runs, double ms, double bytes) {}

    /**
     * The medians in ascending size order, both growth exponents, the thresholds they were
     * judged against, and every violated threshold (empty when the growth is sub-linear).
     */
    public record ScalingAnalysis(List<SizeMedian> medians, double timeExponent, double bytesExponent,
                                  double maxTimeExponent, double maxBytesExponent, List<String> violations) {
        public boolean sublinear() {
            return violations.isEmpty();
        }
    }

    /** Brings the collection to exactly {@code size} items (seeding only the difference) and times one read of it. */
    @FunctionalInterface
    public interface Measure {
        Measurement measure(int size) throws Exception;
    }

    public static final double DEFAULT_MAX_TIME_EXPONENT = 0.5;
    public static final double DEFAULT_MAX_BYTES_EXPONENT = 0.1;
    public static final int DEFAULT_RUNS = 5;
    public static final int DEFAULT_WARMUP = 1;
    public static final int MIN_SIZES = 3;

    private Scaling() {}

    public static ScalingAnalysis analyzeScaling(List<Sample> samples) {
        return analyzeScaling(samples, DEFAULT_MAX_TIME_EXPONENT, DEFAULT_MAX_BYTES_EXPONENT);
    }

    /**
     * Groups the samples by size, takes the median time and payload per size, and computes
     * each growth exponent between the smallest and the largest size. Needs at least two
     * distinct positive sizes, times &gt; 0, and payloads &gt;= 0; a payload median of 0 at
     * both ends is flat (exponent 0), at one end only it has no growth ratio (misuse). Pure:
     * it measures nothing and never throws a RED; see {@link #assertScaling}.
     */
    public static ScalingAnalysis analyzeScaling(List<Sample> samples, double maxTimeExponent, double maxBytesExponent) {
        requireThreshold(maxTimeExponent, "maxTimeExponent");
        requireThreshold(maxBytesExponent, "maxBytesExponent");
        if (samples == null || samples.isEmpty()) throw new IllegalArgumentException("analyzeScaling: samples must be a non-empty list");
        Map<Integer, List<Sample>> bySize = new TreeMap<>();
        for (Sample sample : samples) {
            if (sample == null) throw new IllegalArgumentException("analyzeScaling: samples must not contain null");
            if (sample.size() < 1) throw new IllegalArgumentException("analyzeScaling: size must be a positive integer, got " + sample.size());
            if (!Double.isFinite(sample.ms()) || sample.ms() <= 0) {
                throw new IllegalArgumentException("analyzeScaling: ms must be a finite number > 0 (time with System.nanoTime), got " + sample.ms());
            }
            if (sample.bytes() < 0) throw new IllegalArgumentException("analyzeScaling: bytes must be >= 0, got " + sample.bytes());
            bySize.computeIfAbsent(sample.size(), size -> new ArrayList<>()).add(sample);
        }
        if (bySize.size() < 2) throw new IllegalArgumentException("analyzeScaling: at least two distinct sizes are required, got " + bySize.keySet());
        List<SizeMedian> medians = new ArrayList<>();
        bySize.forEach((size, runs) -> medians.add(new SizeMedian(size, runs.size(),
                median(runs.stream().mapToDouble(Sample::ms).toArray()), median(runs.stream().mapToDouble(Sample::bytes).toArray()))));
        SizeMedian first = medians.get(0);
        SizeMedian last = medians.get(medians.size() - 1);
        double sizeRatio = Math.log((double) last.size() / first.size());
        double timeExponent = Math.log(last.ms() / first.ms()) / sizeRatio;
        double bytesExponent;
        if (first.bytes() == 0 && last.bytes() == 0) {
            bytesExponent = 0;
        } else if (first.bytes() == 0 || last.bytes() == 0) {
            throw new IllegalArgumentException("analyzeScaling: a payload median of 0 at size " + (first.bytes() == 0 ? first.size() : last.size())
                    + " has no growth ratio; measure the body of a real read");
        } else {
            bytesExponent = Math.log(last.bytes() / first.bytes()) / sizeRatio;
        }
        String span = first.size() + " -> " + last.size() + " items";
        List<String> violations = new ArrayList<>();
        if (timeExponent > maxTimeExponent) {
            violations.add("time grows as size^" + fmt(timeExponent) + " (max " + fmt(maxTimeExponent) + "): " + span + " took "
                    + fmt(first.ms()) + " ms -> " + fmt(last.ms()) + " ms (median)");
        }
        if (bytesExponent > maxBytesExponent) {
            violations.add("payload grows as size^" + fmt(bytesExponent) + " (max " + fmt(maxBytesExponent) + "): " + span + " served "
                    + fmt(first.bytes()) + " -> " + fmt(last.bytes()) + " bytes (median)");
        }
        return new ScalingAnalysis(List.copyOf(medians), timeExponent, bytesExponent, maxTimeExponent, maxBytesExponent, List.copyOf(violations));
    }

    /** Fails unless the analysis is sub-linear on both time and payload. */
    public static void assertScaling(ScalingAnalysis analysis) {
        if (analysis == null) throw new IllegalArgumentException("assertScaling: pass the result of analyzeScaling");
        if (!analysis.sublinear()) throw new AssertionError("n1Scaling: the read does not scale sub-linearly\n  - " + String.join("\n  - ", analysis.violations()));
    }

    public static ScalingAnalysis n1Scaling(Measure measure, List<Integer> sizes) {
        return n1Scaling(measure, sizes, DEFAULT_RUNS, DEFAULT_WARMUP, DEFAULT_MAX_TIME_EXPONENT, DEFAULT_MAX_BYTES_EXPONENT);
    }

    /**
     * For each size in order, calls {@code measure} {@code warmup + runs} times, discards the
     * first {@code warmup} measurements, and asserts {@link #analyzeScaling} over the rest.
     * {@code sizes} holds at least three strictly ascending positive sizes; spread them over at
     * least a factor of ten (for example 10, 100, 1000) so noise does not dominate the fit.
     * Returns the analysis.
     */
    public static ScalingAnalysis n1Scaling(Measure measure, List<Integer> sizes, int runs, int warmup,
                                            double maxTimeExponent, double maxBytesExponent) {
        if (measure == null) throw new IllegalArgumentException("n1Scaling: measure must not be null");
        if (sizes == null || sizes.size() < MIN_SIZES) throw new IllegalArgumentException("n1Scaling: sizes must hold at least " + MIN_SIZES + " sizes, got " + sizes);
        for (int index = 0; index < sizes.size(); index++) {
            Integer size = sizes.get(index);
            if (size == null || size < 1 || (index > 0 && size <= sizes.get(index - 1))) {
                throw new IllegalArgumentException("n1Scaling: sizes must be strictly ascending positive integers, got " + sizes);
            }
        }
        if (runs < 1) throw new IllegalArgumentException("n1Scaling: runs must be a positive integer, got " + runs);
        if (warmup < 0) throw new IllegalArgumentException("n1Scaling: warmup must be >= 0, got " + warmup);
        requireThreshold(maxTimeExponent, "maxTimeExponent");
        requireThreshold(maxBytesExponent, "maxBytesExponent");
        List<Sample> samples = new ArrayList<>();
        for (int size : sizes) {
            for (int attempt = 0; attempt < warmup + runs; attempt++) {
                Measurement measured = call(() -> measure.measure(size), "measure(" + size + ")");
                if (measured == null) throw new IllegalArgumentException("n1Scaling: measure(" + size + ") returned null instead of a measurement");
                if (attempt >= warmup) samples.add(new Sample(size, measured.ms(), measured.bytes()));
            }
        }
        ScalingAnalysis analysis = analyzeScaling(samples, maxTimeExponent, maxBytesExponent);
        assertScaling(analysis);
        return analysis;
    }

    /**
     * Times one REST Assured call, body included: the clock stops once the whole body is read.
     * The caller still checks the exact status of {@link Timed#response()}.
     */
    public static Timed time(Callable<Response> call) {
        long start = System.nanoTime();
        Response response = call(call, "the timed call");
        if (response == null) throw new IllegalArgumentException("time: the call returned null instead of a response");
        long bytes = response.asByteArray().length;
        return new Timed(response, (System.nanoTime() - start) / 1_000_000.0, bytes);
    }

    private static <T> T call(Callable<T> call, String label) {
        try {
            return call.call();
        } catch (RuntimeException | Error unchecked) {
            throw unchecked;
        } catch (Exception checked) {
            throw new IllegalStateException(label + " threw instead of answering", checked);
        }
    }

    private static double median(double[] values) {
        double[] sorted = values.clone();
        Arrays.sort(sorted);
        int middle = sorted.length / 2;
        return sorted.length % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    private static void requireThreshold(double value, String label) {
        if (!Double.isFinite(value) || value < 0) throw new IllegalArgumentException(label + " must be a finite number >= 0, got " + value);
    }

    /** Three significant digits, without exponent form or trailing zeros. */
    private static String fmt(double value) {
        return Boundary.normalize(new BigDecimal(value).round(new MathContext(3))).toPlainString();
    }
}
