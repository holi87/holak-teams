"""@ui lane — pytest-playwright, role/label locators, page objects.

ADAPT-ME: example tests for the funded, risk-derived UI lane. Every assertion is exact: the
full URL and the heading text the requirement names, never a pattern that several pages
would match. The UI context starts AUTHENTICATED via the saved storage_state (conftest ->
auth_setup), so there's no per-test login. console_guard is autouse here
(tests/ui/conftest.py). Use page objects for interactions; keep assertions in the test.
"""
from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

from qa.oracles import visual_bounds
from qa.pages.login_page import LoginPage

pytestmark = pytest.mark.ui

# ADAPT-ME: routes and texts from the requirement or Kalchas's recon, cited in the strategy.
UI_HOME_PATH = "/dashboard"
UI_HOME_HEADING = "Dashboard"
UI_PRIMARY_ACTION = "New order"
UI_LOGIN_HEADING = "Sign in"
UI_BAD_CREDENTIALS_MESSAGE = "Invalid email or password."
# A fresh, unauthenticated state: no cookies and no stored tokens (localStorage included).
ANONYMOUS_STATE = {"cookies": [], "origins": []}


def test_authenticated_user_lands_on_the_dashboard(page: Page) -> None:
    page.goto("/")  # storage_state already carries the session
    # A path resolves against UI_URL (the context base_url) and must match the full URL exactly.
    expect(page).to_have_url(UI_HOME_PATH)
    expect(page.get_by_role("heading", level=1)).to_have_text(UI_HOME_HEADING)


def test_primary_action_fits_a_375px_phone_viewport(page: Page) -> None:
    page.goto(UI_HOME_PATH)
    # Off-screen, overflowing, or covered at 375 px is RED; the viewport is restored afterwards.
    visual_bounds(page.get_by_role("button", name=UI_PRIMARY_ACTION, exact=True))


@pytest.mark.browser_context_args(storage_state=ANONYMOUS_STATE)
def test_login_rejects_bad_credentials(page: Page) -> None:
    # The marker replaces the saved session for this test only.
    login_page = LoginPage(page)
    login_page.goto()
    login_page.username_input.fill("nobody@example.com")
    login_page.password_input.fill("wrong-password")
    login_page.submit_button.click()
    expect(page.get_by_role("alert")).to_have_text(UI_BAD_CREDENTIALS_MESSAGE)
    expect(page).to_have_url(LoginPage.path)
    expect(page.get_by_role("heading", level=1)).to_have_text(UI_LOGIN_HEADING)
