"""Auth-once helper: log in through the UI a single time and persist storage_state.

The conftest `storage_state` session fixture calls this once per run (re-authenticating
and overwriting the saved state each invocation); every UI test then starts already
authenticated (the canonical Playwright storageState pattern — no per-test login). This
module is import-path-independent on purpose: conftest adds
``tests/setup`` to sys.path and imports it lazily, so it never affects API-only runs.
"""
from __future__ import annotations

import re
from pathlib import Path

from playwright.sync_api import Browser

from qa.config import ENV
from qa.pages.login_page import LoginPage

# <-- adapt the post-login success signal to the app under test.
SUCCESS_URL = re.compile(r"dashboard|home|/$")


def authenticate(browser: Browser, role: str, state_path: str) -> None:
    """Drive a UI login for `role` and write the resulting storage_state to `state_path`."""
    Path(state_path).parent.mkdir(parents=True, exist_ok=True)
    context = browser.new_context(base_url=ENV.ui_url)
    page = context.new_page()
    try:
        LoginPage(page).login_as(role)
        page.wait_for_url(SUCCESS_URL)
        context.storage_state(path=state_path)
    finally:
        context.close()
