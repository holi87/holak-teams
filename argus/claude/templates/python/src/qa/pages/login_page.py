"""Example Page Object — adjust locators to the real SPA at engagement start.

Locators use role/label (resilient to styling churn, mirror what a user sees);
methods express intent. ADAPT-ME everywhere marked.
"""
from __future__ import annotations

import re

from playwright.sync_api import Page

from qa.config import ENV
from qa.pages.base_page import BasePage


class LoginPage(BasePage):
    path = "/"  # <-- adapt (e.g. "/login")

    def __init__(self, page: Page) -> None:
        super().__init__(page)
        self.username_input = page.get_by_label(re.compile(r"email|username", re.I))
        self.password_input = page.get_by_label(re.compile(r"password", re.I))
        self.submit_button = page.get_by_role(
            "button", name=re.compile(r"log\s*in|sign\s*in", re.I)
        )

    def login_as(self, role: str) -> None:
        account = ENV.accounts[role]
        self.goto()
        self.username_input.fill(account.username)
        self.password_input.fill(account.password)
        self.submit_button.click()
