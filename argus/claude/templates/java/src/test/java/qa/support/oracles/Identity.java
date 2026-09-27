package qa.support.oracles;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/**
 * Canonical identity-input vectors and the credential consistency oracle, the Java port of
 * identity.ts. Every non-ASCII vector is written as a Unicode escape or built from code
 * points, so no editor, formatter, or git filter can normalize it (an NFD vector folded to
 * NFC is worthless) or hide it (a literal bidi override is a Trojan-Source pattern). A
 * comment names or shows each vector. A RED throws {@link AssertionError}; misuse throws
 * {@link IllegalArgumentException}.
 */
public final class Identity {

    public record Whitespace(String leading, String trailing, String internal, String tab, String spaceOnly) {}

    public record UnicodeEdge(String emoji, String rtl, String zeroWidth, String combining, String nfc, String nfd, String overlong) {}

    public record IdentityVectors(Whitespace whitespace, List<String> diacritics, String special, UnicodeEdge unicodeEdge) {}

    /** One invalid email and its email partition label. */
    public record InvalidEmail(String label, String value) {}

    /** One credential pair. {@link #toString()} never shows the password. */
    public record Credentials(String email, String password) {
        @Override
        public String toString() {
            return "Credentials[email=" + email + ", password=[REDACTED]]";
        }
    }

    /**
     * One login check: {@code byte-identical}, {@code case-variant-email},
     * {@code case-variant-password} or {@code trailing-space-password}, each verdict
     * {@code accepted} or {@code rejected}.
     */
    public record CredentialCheck(String name, String expected, String actual) {}

    public record CredentialReport(String email, List<CredentialCheck> checks) {}

    /** A register or login call; returns true when the product accepted the credentials. */
    @FunctionalInterface
    public interface CredentialAttempt {
        boolean accepted(Credentials credentials);
    }

    /**
     * Credential consistency options. A null email or password selects the default; the
     * product contract defaults to case-sensitive passwords and case-insensitive emails.
     */
    public record CredentialOptions(String email, String password, boolean passwordCaseSensitive, boolean emailCaseInsensitive) {

        public static CredentialOptions defaults() {
            return new CredentialOptions(null, null, true, true);
        }

        public CredentialOptions withEmail(String next) {
            return new CredentialOptions(next, password, passwordCaseSensitive, emailCaseInsensitive);
        }

        public CredentialOptions withPassword(String next) {
            return new CredentialOptions(email, next, passwordCaseSensitive, emailCaseInsensitive);
        }

        public CredentialOptions withPasswordCaseSensitive(boolean next) {
            return new CredentialOptions(email, password, next, emailCaseInsensitive);
        }

        public CredentialOptions withEmailCaseInsensitive(boolean next) {
            return new CredentialOptions(email, password, passwordCaseSensitive, next);
        }
    }

    public static final String ACCEPTED = "accepted";
    public static final String REJECTED = "rejected";

    public static final IdentityVectors IDENTITY_VECTORS = new IdentityVectors(
            new Whitespace(" Argus", "Argus ", "Argus QA", "Argus\tQA", "   "),
            List.of(
                    "Żółć Ąćęłń", // Żółć Ąćęłń
                    "Zoë Saldaña"), // Zoë Saldaña
            "!@#$%^&*()\"'<>",
            new UnicodeEdge(
                    codePoints(0x1F600, 0x1F44D, 0x1F3FD), // grinning face, thumbs up with a skin-tone modifier
                    "‮abc", // RIGHT-TO-LEFT OVERRIDE, then abc
                    "a​b", // a, ZERO WIDTH SPACE, b
                    "é", // e, COMBINING ACUTE ACCENT
                    "é", // e with acute, precomposed (NFC)
                    "é", // e with acute, decomposed (NFD)
                    "a".repeat(1025)));

    /** One invalid email per email partition label, in label order; each must be rejected. */
    public static final List<InvalidEmail> INVALID_EMAILS = List.of(
            new InvalidEmail("email.missing-at", "argus.qa.example.com"),
            new InvalidEmail("email.missing-domain", "argus.qa@"),
            new InvalidEmail("email.missing-tld", "argus.qa@example"),
            new InvalidEmail("email.double-at", "argus.qa@@example.com"),
            new InvalidEmail("email.embedded-whitespace", "argus qa@example.com"));

    // Argus!Żółć#Qa7 followed by one space: diacritics, special characters, a trailing space.
    private static final String DEFAULT_PASSWORD = "Argus!Żółć#Qa7 ";
    private static final Pattern SEQUENCE_TOKEN = Pattern.compile("^[a-z0-9-]{1,32}$");
    private static final AtomicLong SEQUENCE = new AtomicLong();

    private Identity() {}

    /**
     * The known-good email {@code argus.qa+<seq>@example.com}, the positive oracle for every
     * email field. Against an environment that keeps accounts across runs, pass a run-unique
     * token to {@link #validEmail(String)}.
     */
    public static String validEmail(long seq) {
        if (seq < 0) throw new IllegalArgumentException("validEmail: seq must be a non-negative integer or a lowercase [a-z0-9-] token, got " + seq);
        return "argus.qa+" + seq + "@example.com";
    }

    /** {@link #validEmail(long)} with a lowercase {@code [a-z0-9-]} token of 1 to 32 characters. */
    public static String validEmail(String seq) {
        if (seq == null || !SEQUENCE_TOKEN.matcher(seq).matches()) {
            throw new IllegalArgumentException("validEmail: seq must be a non-negative integer or a lowercase [a-z0-9-] token, got " + quote(seq));
        }
        return "argus.qa+" + seq + "@example.com";
    }

    /** [lower, UPPER, Mixed]; Mixed alternates upper and lower case over the cased letters. */
    public static List<String> caseVariants(String value) {
        if (value == null) throw new IllegalArgumentException("caseVariants: value must be a string");
        StringBuilder mixed = new StringBuilder();
        int letter = 0;
        for (int point : value.codePoints().toArray()) {
            String character = Character.toString(point);
            String upper = character.toUpperCase(Locale.ROOT);
            String lower = character.toLowerCase(Locale.ROOT);
            if (upper.equals(lower)) {
                mixed.append(character);
                continue;
            }
            mixed.append(letter % 2 == 0 ? upper : lower);
            letter += 1;
        }
        return List.of(value.toLowerCase(Locale.ROOT), value.toUpperCase(Locale.ROOT), mixed.toString());
    }

    public static CredentialReport credentialConsistency(CredentialAttempt register, CredentialAttempt login) {
        return credentialConsistency(register, login, CredentialOptions.defaults());
    }

    /**
     * The credential consistency oracle. Registers one account, then requires:
     * <ul>
     *   <li>byte-identical: the exact registered email and password log in;</li>
     *   <li>case-variant-email: an email case variant logs in (must be refused when
     *       emailCaseInsensitive is false);</li>
     *   <li>case-variant-password: a password case variant is refused (must log in when
     *       passwordCaseSensitive is false);</li>
     *   <li>trailing-space-password: the password plus one trailing space is refused.</li>
     * </ul>
     * The default password carries diacritics, special characters, and a trailing space, so a
     * silent trim, truncation, or charset strip on only one side (register or login) is RED.
     * The default email is {@code validEmail(<per-JVM sequence>)}; pass an email for a
     * run-unique one and a password when the product documents a stricter password policy.
     * Messages name the checks only, never the credentials.
     */
    public static CredentialReport credentialConsistency(CredentialAttempt register, CredentialAttempt login, CredentialOptions options) {
        if (register == null || login == null) throw new IllegalArgumentException("credentialConsistency: register and login must not be null");
        CredentialOptions settings = options == null ? CredentialOptions.defaults() : options;
        String email = settings.email() != null ? settings.email() : validEmail(SEQUENCE.incrementAndGet());
        String password = settings.password() != null ? settings.password() : DEFAULT_PASSWORD;
        if (email.isEmpty() || password.isEmpty()) throw new IllegalArgumentException("credentialConsistency: email and password must be non-empty strings");
        String emailVariant = differentVariant(email, "email");
        String passwordVariant = differentVariant(password, "password");

        if (!register.accepted(new Credentials(email, password))) {
            throw new AssertionError("credentialConsistency: register refused the credential vector; nothing else can be checked");
        }

        record Step(String name, Credentials credentials, boolean expected) {}
        List<Step> plan = new ArrayList<>(List.of(
                new Step("byte-identical", new Credentials(email, password), true),
                new Step("case-variant-email", new Credentials(emailVariant, password), settings.emailCaseInsensitive()),
                new Step("case-variant-password", new Credentials(email, passwordVariant), !settings.passwordCaseSensitive()),
                new Step("trailing-space-password", new Credentials(email, password + " "), false)));
        // Expected successes run before expected refusals, so a lockout policy cannot mask them.
        plan.sort(Comparator.comparing((Step step) -> !step.expected()));
        List<CredentialCheck> checks = new ArrayList<>();
        for (Step step : plan) {
            checks.add(new CredentialCheck(step.name(), verdict(step.expected()), verdict(login.accepted(step.credentials()))));
        }
        List<String> failures = checks.stream().filter(check -> !check.expected().equals(check.actual()))
                .map(check -> check.name() + " login expected " + check.expected() + ", got " + check.actual()).toList();
        if (!failures.isEmpty()) throw new AssertionError("credentialConsistency: " + String.join("; ", failures));
        return new CredentialReport(email, List.copyOf(checks));
    }

    private static String differentVariant(String value, String label) {
        return caseVariants(value).stream().filter(candidate -> !candidate.equals(value)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException(
                        "credentialConsistency: the " + label + " has no cased letter, so its case handling cannot be checked"));
    }

    private static String verdict(boolean value) {
        return value ? ACCEPTED : REJECTED;
    }

    private static String codePoints(int... points) {
        return new String(points, 0, points.length);
    }

    private static String quote(String value) {
        return value == null ? "null" : Http.JSON.getNodeFactory().textNode(value).toString();
    }
}
