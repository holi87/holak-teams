package qa.support;

import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Emits the small aggregated summary alongside Surefire's XML.
 *
 * <p>Registered via ServiceLoader
 * ({@code META-INF/services/org.junit.platform.launcher.TestExecutionListener}) so the
 * JUnit Platform launcher — the one Surefire drives — invokes it in-process for the whole
 * run. On {@code testPlanExecutionFinished} it writes:
 * <ul>
 *   <li>{@code reports/summary.json} — machine-readable (CI gates, dashboards),</li>
 *   <li>{@code reports/summary.html} — a one-glance human report.</li>
 * </ul>
 *
 * The process exit code (pass/fail) still comes from Surefire/Maven; this is the
 * single human+machine digest on top of the per-class XML in {@code target/surefire-reports/}.
 */
public class SummaryListener implements TestExecutionListener {

    private final AtomicInteger passed  = new AtomicInteger();
    private final AtomicInteger failed  = new AtomicInteger();
    private final AtomicInteger aborted = new AtomicInteger();  // assumptions / gated self-skips at runtime
    private final AtomicInteger skipped = new AtomicInteger();  // @Disabled / @EnabledIf... not met
    private long startNanos;
    private TestPlan plan;

    @Override
    public void testPlanExecutionStarted(TestPlan testPlan) {
        startNanos = System.nanoTime();
        plan = testPlan;
    }

    @Override
    public void executionSkipped(TestIdentifier id, String reason) {
        if (id.isTest()) {
            skipped.incrementAndGet();
        } else if (plan != null) {
            // A whole container was skipped (e.g. a class-level @EnabledIfEnvironmentVariable
            // gate not met): JUnit fires ONE event for the container, not one per method.
            // Count its descendant tests so gated lanes show their real skip count.
            for (TestIdentifier child : plan.getDescendants(id)) {
                if (child.isTest()) skipped.incrementAndGet();
            }
        }
    }

    @Override
    public void executionFinished(TestIdentifier id, TestExecutionResult result) {
        if (!id.isTest()) return;
        switch (result.getStatus()) {
            case SUCCESSFUL -> passed.incrementAndGet();
            case FAILED     -> failed.incrementAndGet();
            case ABORTED    -> aborted.incrementAndGet();
        }
    }

    @Override
    public void testPlanExecutionFinished(TestPlan testPlan) {
        long durationMs = (System.nanoTime() - startNanos) / 1_000_000L;
        int p = passed.get(), f = failed.get(), a = aborted.get(), s = skipped.get();
        int total = p + f + a + s;
        boolean success = (f == 0);
        String generatedAt = Instant.now().toString();

        try {
            File dir = new File("reports");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();

            String json = """
                    {
                      "generatedAt": "%s",
                      "durationMs": %d,
                      "total": %d,
                      "passed": %d,
                      "failed": %d,
                      "aborted": %d,
                      "skipped": %d,
                      "success": %b
                    }
                    """.formatted(generatedAt, durationMs, total, p, f, a, s, success);
            write(new File(dir, "summary.json"), json);
            write(new File(dir, "summary.html"), html(generatedAt, durationMs, total, p, f, a, s, success));
        } catch (IOException e) {
            System.err.println("[SummaryListener] could not write reports/summary.*: " + e.getMessage());
        }
    }

    private static void write(File f, String content) throws IOException {
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private static String html(String at, long durationMs, int total, int p, int f, int a, int s, boolean ok) {
        String verdict = ok ? "PASS" : "FAIL";
        String color = ok ? "#1a7f37" : "#cf222e";
        return """
                <!doctype html><html lang="en"><head><meta charset="utf-8">
                <title>Argus QA — run summary</title>
                <style>
                  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:2rem;color:#1f2328}
                  h1{margin:0 0 .25rem} .sub{color:#656d76;margin:0 0 1.5rem}
                  .verdict{display:inline-block;padding:.2rem .6rem;border-radius:6px;color:#fff;font-weight:700;background:%s}
                  table{border-collapse:collapse;margin-top:1rem} td,th{border:1px solid #d0d7de;padding:.4rem .8rem;text-align:left}
                  th{background:#f6f8fa} .n{text-align:right;font-variant-numeric:tabular-nums}
                </style></head><body>
                <h1>Argus QA — run summary <span class="verdict">%s</span></h1>
                <p class="sub">generated %s · duration %d ms</p>
                <table>
                  <tr><th>Metric</th><th class="n">Count</th></tr>
                  <tr><td>Total tests</td><td class="n">%d</td></tr>
                  <tr><td>Passed</td><td class="n">%d</td></tr>
                  <tr><td>Failed</td><td class="n">%d</td></tr>
                  <tr><td>Aborted (assumptions / runtime self-skip)</td><td class="n">%d</td></tr>
                  <tr><td>Skipped (gated lane off / @Disabled)</td><td class="n">%d</td></tr>
                </table>
                <p class="sub">Per-class detail: <code>target/surefire-reports/</code> (XML). Machine summary: <code>reports/summary.json</code>.</p>
                </body></html>
                """.formatted(color, verdict, at, durationMs, total, p, f, a, s);
    }
}
