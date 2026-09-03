"""Target-independent clean-room contract smoke."""
import os
import subprocess

import pytest

pytestmark = pytest.mark.contract_smoke


def test_generated_template_contract_is_runnable():
    # The contract evaluator refuses to invent a passing event, so a smoke run that emits
    # nothing is a contract error rather than a green suite. This case records its own
    # outcome the way every real case does: the event exists because the test ran.
    assert os.environ.get("ARGUS_CONTRACT_SMOKE") == "1"
    subprocess.run(
        [
            "scripts/outcome-event.sh",
            "test_template_contract",
            "product",
            "pass",
            "false",
            "n/a",
            "-",
            "contract-smoke-executed",
        ],
        check=True,
    )
