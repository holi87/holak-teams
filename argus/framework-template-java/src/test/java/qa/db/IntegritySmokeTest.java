package qa.db;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Enumeration;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * @db lane — GATED on {@code DB_URL}, READ-ONLY only.
 *
 * <p>Direct-DB checks (state integrity, orphan rows, constraint enforcement) need a
 * connection the target may not expose. With no {@code DB_URL} the lane skips (the common
 * black-box case); with one set it verifies the prerequisite is usable. The connection is
 * forced {@link Connection#setReadOnly(boolean) read-only} — this lane never mutates the app.
 *
 * <p>No JDBC driver is bundled (drivers are app-specific). Add yours in {@code pom.xml}
 * (see the commented {@code postgres} profile); until then the live check self-skips with a
 * clear message rather than failing — consistent with the "gated, not broken" doctrine.
 * ADAPT-ME: add the real integrity queries once DB access is confirmed.
 */
@Tag("db")
@EnabledIfEnvironmentVariable(named = "DB_URL", matches = ".+")
class IntegritySmokeTest {

    private static final String DB_URL = System.getenv("DB_URL");

    @Test
    void db_url_is_a_jdbc_connection_string() {
        assertTrue(DB_URL != null && DB_URL.startsWith("jdbc:") && DB_URL.length() > "jdbc:".length(),
                "DB_URL must be a JDBC URL like 'jdbc:postgresql://host:5432/db', got: '" + DB_URL + "'");
    }

    @Test
    void read_only_connection_runs_a_trivial_select() throws Exception {
        assumeTrue(hasDriverFor(DB_URL),
                "no JDBC driver on the classpath for " + DB_URL + " — add the driver dependency to pom.xml to enable this check");
        try (Connection c = DriverManager.getConnection(DB_URL)) {
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
