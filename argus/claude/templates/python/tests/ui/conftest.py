"""UI-lane local conftest: make `console_guard` automatic for every UI test.

Defined here (not in the root conftest) so the guard — which requires a `page` —
only attaches to UI tests and never forces a browser launch for the API lanes.

In a cf-* evidence pass (TEMPLATE-CONTRACT.md SD-10) the browser context also routes API
requests matching ARGUS_API_ROUTE_PATTERN (default ``<API_URL>/**``) to the counterfactual
stub; an unmatched one gets 501 and fails the test with ArgusCounterfactualError.
"""
import os

import pytest

from qa.argus.counterfactual import fulfill_from_stub
from qa.config import ENV


@pytest.fixture(autouse=True)
def _ui_counterfactual_route(_argus_counterfactual, page):
    # _argus_counterfactual (root conftest) is None outside a cf-* pass, and a test without a
    # variant has already skipped before a page exists.
    if _argus_counterfactual is not None:
        stub = _argus_counterfactual.stub
        # ENV.api_url is the real target the UI calls, never the stub.
        pattern = os.environ.get("ARGUS_API_ROUTE_PATTERN") or f"{ENV.api_url.rstrip('/')}/**"
        page.context.route(pattern, lambda route: fulfill_from_stub(route, stub))
    yield


@pytest.fixture(autouse=True)
def _ui_console_guard(console_guard):
    # Pulling in `console_guard` (root conftest) arms the listeners for this test.
    yield
