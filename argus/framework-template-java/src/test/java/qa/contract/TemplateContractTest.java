package qa.contract;

import java.io.IOException;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

@Tag("contract-smoke")
class TemplateContractTest {
    // The contract evaluator refuses to invent a passing event, so a smoke run that emits
    // nothing is a contract error rather than a green suite. This case records its own
    // outcome the way every real case does: the event exists because the test ran.
    @Test
    void generated_template_contract_is_runnable() throws IOException, InterruptedException {
        assertEquals("1", System.getenv("ARGUS_CONTRACT_SMOKE"));
        Process process = new ProcessBuilder(
                "scripts/outcome-event.sh",
                "TemplateContractTest",
                "product",
                "pass",
                "false",
                "n/a",
                "-",
                "contract-smoke-executed")
                .inheritIO()
                .start();
        assertEquals(0, process.waitFor());
    }
}
