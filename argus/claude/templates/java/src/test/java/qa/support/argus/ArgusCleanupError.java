package qa.support.argus;

/**
 * Teardown could not restore the state a test created (RUNNER-CONTRACT.md SD-5).
 *
 * <p>The outcome listener classifies it as {@code automation fail cleanup-failed}. When a
 * different primary outcome already failed the test, JUnit attaches this error as a
 * suppressed exception and the listener adds a secondary {@code <case>.cleanup} event.
 * Keep the message free of target data: count what was left behind, never echo it.
 */
public class ArgusCleanupError extends RuntimeException {

    public ArgusCleanupError(String message) {
        super(message);
    }

    public ArgusCleanupError(String message, Throwable cause) {
        super(message, cause);
    }
}
