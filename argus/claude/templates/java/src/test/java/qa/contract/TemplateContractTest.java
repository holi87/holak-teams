package qa.contract;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Contract smoke: a freshly scaffolded template compiles, collects, runs, and reports through
 * the Argus outcome adapter ({@code qa.support.argus.ArgusOutcomeListener}), which records this
 * case's event. Tests never append events by hand.
 */
@Tag("contract-smoke")
class TemplateContractTest {

    @Test
    void generated_template_contract_is_runnable() {
        assertEquals("1", System.getenv("ARGUS_CONTRACT_SMOKE"));
    }
}
