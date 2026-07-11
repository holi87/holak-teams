"""Target-independent clean-room contract smoke."""
import os

import pytest

pytestmark = pytest.mark.contract_smoke


def test_generated_template_contract_is_runnable():
    assert os.environ.get("ARGUS_CONTRACT_SMOKE") == "1"
