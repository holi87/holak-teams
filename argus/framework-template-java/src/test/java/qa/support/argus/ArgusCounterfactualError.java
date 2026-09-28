package qa.support.argus;

/**
 * The counterfactual stub received a request its fixture does not declare
 * (TEMPLATE-CONTRACT.md SD-10).
 *
 * <p>The outcome listener classifies it as
 * {@code automation fail counterfactual-unmatched-request}: the regression reached outside
 * the recorded exchange, so its counterfactual verdict proves nothing.
 */
public class ArgusCounterfactualError extends RuntimeException {

    public ArgusCounterfactualError(String message) {
        super(message);
    }
}
