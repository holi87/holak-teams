"""Counterfactual fixture for scripts/smoke-argus-runtime-python.sh (TEMPLATE-CONTRACT.md SD-10).

In a cf-* pass anon_client reaches only the in-process stub serving
solution/counterfactual/BUG-0001.json; the smoke points API_URL at a closed port, so nothing
contacts a real target. The smoke deletes the strict-body line to build a weakened copy, and
ARGUS_SMOKE_EXTRA_REQUEST=1 adds a request the fixture does not declare.
"""
import os

import pytest

from qa.config import ENV, current_api_url
from qa.oracles import assert_schema_ref

pytestmark = pytest.mark.contract_smoke


@pytest.mark.regression
@pytest.mark.bug("ATA-001")
def test_widget_read_returns_the_specified_widget(anon_client, _argus_counterfactual):
    assert current_api_url() == (_argus_counterfactual.api_url if _argus_counterfactual else ENV.api_url)
    res = anon_client.get("/widgets/1")
    if os.environ.get("ARGUS_SMOKE_EXTRA_REQUEST") == "1":
        anon_client.get("/widgets/2")
    assert res.status_code == 200
    assert_schema_ref(res.json(), "#/components/schemas/Widget")  # argus-smoke: strict body


def test_a_test_without_a_bound_bug_has_no_counterfactual_variant():
    assert True
