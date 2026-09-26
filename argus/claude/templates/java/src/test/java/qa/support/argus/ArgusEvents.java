package qa.support.argus;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The only way the Java adapter emits outcome events (RUNNER-CONTRACT.md SD-1).
 *
 * <p>Every event is appended by {@code bash <user.dir>/scripts/outcome-event.sh} with its
 * seven fields as separate arguments, so the portable validator and its lock stay the single
 * writer of {@code ARGUS_OUTCOME_FILE} (inherited from the environment). Fields are safe
 * machine tokens only: titles, messages, URLs and bodies never reach an event. A rejected or
 * failed emission is counted, and a non-zero count turns the adapter status into
 * {@code error}.
 */
public final class ArgusEvents {

    /** The runner modes; the adapter is inert unless {@code ARGUS_RUNNER_MODE} is one of them. */
    public static final Set<String> MODES = Set.of("baseline", "defect-evidence", "candidate-regression", "full-suite");

    public static final String STATUS = "reports/argus-adapter-status.txt";

    private static final Pattern SAFE = Pattern.compile("^[A-Za-z0-9_.:-]+$");
    private static final Pattern STATUS_LINE = Pattern.compile("^(ok|error) ([0-9]{1,9})$");
    private static final long EMIT_TIMEOUT_SECONDS = 60;

    private final Path root;
    private final Path script;
    private int emitted;
    private int failures;

    public ArgusEvents(Path root) {
        this.root = root;
        this.script = root.resolve("scripts").resolve("outcome-event.sh");
    }

    /** The template root: the working directory Maven, Surefire and exec:java run in. */
    public static Path root() {
        return Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
    }

    /** {@code ARGUS_RUNNER_MODE} when it names one of the four modes. */
    public static Optional<String> activeMode() {
        String mode = System.getenv("ARGUS_RUNNER_MODE");
        return mode != null && MODES.contains(mode) ? Optional.of(mode) : Optional.empty();
    }

    /** Appends one event; returns false and counts a failure when it is not recorded. */
    public synchronized boolean emit(String caseId, String category, String status, boolean expected,
                                     String lifecycle, String bugId, String reason) {
        if (!SAFE.matcher(caseId).matches() || !SAFE.matcher(reason).matches()) {
            failures++;
            return false;
        }
        // A test may leave its thread interrupted; that must not cost the event.
        boolean interrupted = Thread.interrupted();
        try {
            Process process = new ProcessBuilder("bash", script.toString(), caseId, category, status,
                    Boolean.toString(expected), lifecycle, bugId, reason)
                    .directory(root.toFile())
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.INHERIT)
                    .start();
            if (!process.waitFor(EMIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                failures++;
                return false;
            }
            if (process.exitValue() != 0) {
                failures++;
                return false;
            }
            emitted++;
            return true;
        } catch (IOException | InterruptedException failed) {
            if (failed instanceof InterruptedException) interrupted = true;
            failures++;
            return false;
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    /** Counts an adapter failure that happened outside an emission. */
    public synchronized void recordFailure() {
        failures++;
    }

    public synchronized int emitted() {
        return emitted;
    }

    public synchronized int failures() {
        return failures;
    }

    /**
     * Writes {@code reports/argus-adapter-status.txt} as {@code ok <events>} or
     * {@code error <failures>}. A status already present from another fork or plan of the same
     * native run is merged, and an earlier {@code error} is sticky, so a later clean plan can
     * never hide a failed one. The runner deletes the file before every pass.
     */
    public synchronized void writeStatus() {
        Path file = root.resolve(STATUS);
        try {
            int priorEvents = 0;
            int priorFailures = 0;
            if (Files.exists(file)) {
                Matcher prior = STATUS_LINE.matcher(Files.readString(file, StandardCharsets.UTF_8).trim());
                if (prior.matches() && prior.group(1).equals("ok")) priorEvents = Integer.parseInt(prior.group(2));
                else priorFailures = prior.matches() ? Math.max(1, Integer.parseInt(prior.group(2))) : 1;
            }
            String line = priorFailures + failures > 0 ? "error " + (priorFailures + failures) : "ok " + (priorEvents + emitted);
            writeAtomically(file, line + "\n");
        } catch (IOException | RuntimeException unwritable) {
            System.err.println("[argus] could not write " + STATUS + ": " + unwritable.getClass().getSimpleName());
        }
    }

    /** Replaces {@code target} through a temporary sibling (umask permissions) and a rename. */
    static void writeAtomically(Path target, String content) throws IOException {
        Path absolute = target.toAbsolutePath();
        Files.createDirectories(absolute.getParent());
        Path temporary = absolute.resolveSibling("." + absolute.getFileName() + "." + ProcessHandle.current().pid() + "." + System.nanoTime() + ".tmp");
        try {
            Files.writeString(temporary, content, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            try {
                Files.move(temporary, absolute, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary, absolute, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
