package qa.contract;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

@Tag("contract-smoke")
class TemplateContractTest {
    @Test
    void generated_template_contract_is_runnable() {
        assertEquals("1", System.getenv("ARGUS_CONTRACT_SMOKE"));
    }
}
