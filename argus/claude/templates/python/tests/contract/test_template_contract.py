"""Contract smoke: a freshly scaffolded template collects, runs, and reports through the Argus
outcome adapter (qa.argus_plugin), which records this case's event. Tests never append events
by hand."""
import os

import pytest

pytestmark = pytest.mark.contract_smoke


def test_generated_template_contract_is_runnable():
    assert os.environ.get("ARGUS_CONTRACT_SMOKE") == "1"
