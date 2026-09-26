package qa.support.argus;

/**
 * A declared prerequisite of an enabled lane is missing (RUNNER-CONTRACT.md SD-5).
 *
 * <p>The outcome listener classifies it as {@code infrastructure fail prerequisite-missing}.
 * Tests never self-skip on a missing prerequisite: a disabled lane is removed from native
 * selection by the lane plan, and an enabled lane that lacks its input fails visibly.
 */
public class ArgusPrerequisiteError extends RuntimeException {

    public ArgusPrerequisiteError(String message) {
        super(message);
    }

    /**
     * Returns the value of environment variable {@code name}, or throws when it is unset or
     * blank. The message names the variable only, never a value.
     */
    public static String requireEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new ArgusPrerequisiteError("required environment variable " + name + " is not set");
        }
        return value;
    }
}
