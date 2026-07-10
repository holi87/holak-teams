"""Base for all Page Objects: shared navigation + helpers.

POM rules: locators live in the page class (get_by_role / get_by_label — never CSS
tied to styling), methods express USER intent (login(), add_item()), assertions stay
in the spec.
"""
from __future__ import annotations

from abc import ABC

from playwright.sync_api import Page


class BasePage(ABC):
    # Each page declares its route; goto() uses the context base_url (UI_URL).
    path: str = "/"

    def __init__(self, page: Page) -> None:
        self.page = page

    def goto(self) -> None:
        self.page.goto(self.path)
