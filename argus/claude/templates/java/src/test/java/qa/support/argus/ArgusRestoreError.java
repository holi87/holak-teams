package qa.support.argus;

/**
 * An injected fault could not be restored (RUNNER-CONTRACT.md SD-5).
 *
 * <p>The outcome listener classifies it as {@code infrastructure fail fault-restore-failed}:
 * the environment is no longer at a known baseline, so later evidence is untrustworthy.
 */
public class ArgusRestoreError extends RuntimeException {

    public ArgusRestoreError(String message) {
        super(message);
    }

    public ArgusRestoreError(String message, Throwable cause) {
        super(message, cause);
    }
}
