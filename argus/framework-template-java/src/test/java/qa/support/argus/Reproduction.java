package qa.support.argus;

/**
 * Declared repetition of an intermittent-defect regression (RUNNER-CONTRACT.md SD-6): one test
 * invocation repeats the reproduction up to n times, each attempt from fresh state, and fails
 * at the first oracle violation. Declare the same n with {@code @Tag("repetition:<n>")}. It is
 * never a retry: the first failure ends the test unchanged. Never use {@code @RepeatedTest} or
 * {@code @ParameterizedTest} for this; each of their invocations is a separate case.
 */
public final class Reproduction {

    /** One attempt of the reproduction, from fresh state. */
    @FunctionalInterface
    public interface Attempt {
        void run() throws Exception;
    }

    private static final int MAX_REPETITION = 200;

    private Reproduction() {}

    /** Runs {@code attempt} {@code n} (1..200) times, stopping at the first failure, which propagates as thrown. */
    public static void reproduce(int n, Attempt attempt) throws Exception {
        if (n < 1 || n > MAX_REPETITION) throw new IllegalArgumentException("repetition must be in 1.." + MAX_REPETITION + ", got " + n);
        for (int i = 0; i < n; i++) attempt.run();
    }
}
