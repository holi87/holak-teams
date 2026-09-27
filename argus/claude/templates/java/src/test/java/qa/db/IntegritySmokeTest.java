package qa.db;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import qa.support.argus.ArgusPrerequisiteError;

import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Enumeration;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * @db lane — prerequisite {@code DB_URL}, READ-ONLY only.
 *
 * <p>Direct-DB checks (state integrity, orphan rows, constraint enforcement) need a
 * connection the target may not expose, so {@code solution/test-lanes.tsv} enables this lane
 * only with {@code DB_URL} (the common black-box case keeps it disabled with a named residual).
 * When it is enabled, an unset {@code DB_URL} or a missing JDBC driver is reported through
 * {@link ArgusPrerequisiteError} as {@code prerequisite-missing}; the test never skips itself.
 * The connection is forced {@link Connection#setReadOnly(boolean) read-only} — this lane never
 * mutates the app. Messages never echo {@code DB_URL}, which may carry credentials.
 *
 * <p>No JDBC driver is bundled (drivers are app-specific). Add yours in {@code pom.xml} (see
 * the commented {@code postgres} profile). ADAPT-ME: add the real integrity queries once DB
 * access is confirmed.
 */
@Tag("db")
class IntegritySmokeTest {

    @Test
    void db_url_is_a_jdbc_connection_string() {
        String dbUrl = ArgusPrerequisiteError.requireEnv("DB_URL");
        assertTrue(dbUrl.startsWith("jdbc:") && dbUrl.length() > "jdbc:".length(),
                "DB_URL must be a JDBC URL like 'jdbc:postgresql://host:5432/db'");
    }

    @Test
    void read_only_connection_runs_a_trivial_select() throws Exception {
        String dbUrl = ArgusPrerequisiteError.requireEnv("DB_URL");
        if (!hasDriverFor(dbUrl)) {
            throw new ArgusPrerequisiteError("no JDBC driver on the classpath for the DB_URL scheme"
                    + " — add the driver dependency to pom.xml");
        }
        try (Connection c = DriverManager.getConnection(dbUrl)) {
            c.setReadOnly(true); // this lane NEVER mutates the app under test
            try (Statement s = c.createStatement();
                 ResultSet rs = s.executeQuery("SELECT 1")) { // <-- adapt to a real integrity query
                assertTrue(rs.next(), "SELECT 1 returned no row");
            }
        }
    }

    private static boolean hasDriverFor(String url) {
        Enumeration<Driver> drivers = DriverManager.getDrivers();
        while (drivers.hasMoreElements()) {
            try {
                if (drivers.nextElement().acceptsURL(url)) return true;
            } catch (Exception ignored) {
                // a driver that can't answer acceptsURL simply doesn't match
            }
        }
        return false;
    }
}
