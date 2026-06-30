"""@ui lane — pytest-playwright, role/label locators, page objects.

Keep UI tests FEW (critical paths only); push coverage to the API layer. The UI
context starts AUTHENTICATED via the saved storage_state (conftest -> auth_setup),
so there's no per-test login. console_guard is autouse here (tests/ui/conftest.py).
"""
from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect

from qa.pages.login_page import LoginPage

pytestmark = pytest.mark.ui


def test_authenticated_user_reaches_app(page):
    page.goto("/")  # storage_state already carries the session
    expect(page).to_have_url(re.compile(r"dashboard|home|/$"))  # <-- adapt success signal


def test_login_rejects_bad_credentials(page):
    # This test wants a fresh, unauthenticated state — drop the saved session first.
    # ADAPT-ME: SPAs that store the token in localStorage also need page.evaluate(clear).
    page.context.clear_cookies()
    login_page = LoginPage(page)
    login_page.goto()
    login_page.username_input.fill("nobody@example.com")
    login_page.password_input.fill("wrong-password")
    login_page.submit_button.click()
    expect(page.get_by_text(re.compile(r"invalid|incorrect|failed", re.I))).to_be_visible()
