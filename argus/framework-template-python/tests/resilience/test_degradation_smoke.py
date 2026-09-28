"""@resilience lane example: graceful degradation while the API is unavailable.

A ``client`` fault stays inside this browser (``page.route``), so it needs no
ARGUS_FAULT_INJECTION grant; a ``server`` fault that changes the shared target does
(qa.argus.fault_injector). ``fault_injector`` records the restore before injecting, always
restores, and fails the run as ``fault-restore-failed`` when the restore cannot be verified;
the console guard ignores the fault's intended 503s while it is active. The lane runs only
when solution/test-lanes.tsv enables it.

ADAPT-ME: point PAGE at a screen that loads data from the API and replace the error-state
locator with the app's real error banner or empty state. The API calls are matched by
ARGUS_API_ROUTE_PATTERN, else the real API_URL + ``/**``.
"""
from __future__ import annotations

import os

import pytest
from playwright.sync_api import Page, Route, expect

from qa.argus.fault_injector import Fault, FaultInjector
from qa.config import ENV

pytestmark = [pytest.mark.resilience, pytest.mark.usefixtures("console_guard")]

API_PREFIX = ENV.api_url.rstrip("/")
API_PATTERN = os.environ.get("ARGUS_API_ROUTE_PATTERN") or f"{API_PREFIX}/**"
PAGE = "/"  # ADAPT-ME


def test_ui_shows_an_error_state_while_the_api_answers_503_and_recovers(page: Page, fault_injector: FaultInjector):
    intercepted = 0

    def unavailable(route: Route) -> None:
        nonlocal intercepted
        intercepted += 1
        route.fulfill(status=503, content_type="application/json", body='{"error":"unavailable"}')

    def verify_restored() -> None:
        # The next API request must reach the real API again instead of the injected 503.
        before = intercepted
        with page.expect_response(lambda response: response.url.startswith(API_PREFIX)):
            page.reload()
        if intercepted != before:
            raise AssertionError("an API request was still intercepted after the restore")

    def degraded() -> None:
        page.reload()
        expect(page.get_by_role("alert")).to_be_visible()  # ADAPT-ME: the app's error state

    page.goto(PAGE)
    fault_injector.run(
        Fault(
            name="api-unavailable",
            scope="client",
            inject=lambda: page.route(API_PATTERN, unavailable),
            restore=lambda: page.unroute(API_PATTERN, unavailable),
            verify_restored=verify_restored,
        ),
        degraded,
    )
