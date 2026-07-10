"""UI-lane local conftest: make `console_guard` automatic for every UI test.

Defined here (not in the root conftest) so the guard — which requires a `page` —
only attaches to UI tests and never forces a browser launch for the API lanes.
"""
import pytest


@pytest.fixture(autouse=True)
def _ui_console_guard(console_guard):
    # Pulling in `console_guard` (root conftest) arms the listeners for this test.
    yield
