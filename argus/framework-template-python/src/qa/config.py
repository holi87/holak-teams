"""Central config for the target app — the single source of config.

Fill in at the start of an engagement from Kalchas's recon. Everything (URLs,
accounts, roles) comes from the environment with safe local defaults, so the same
suite runs against localhost, CI, or a staging box without code edits.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Account:
    username: str
    password: str


@dataclass(frozen=True)
class Env:
    api_url: str
    ui_url: str
    helper_url: str
    accounts: dict[str, Account]


def _load() -> Env:
    return Env(
        api_url=os.environ.get("API_URL", "http://localhost:3001"),
        ui_url=os.environ.get("UI_URL", "http://localhost:3000"),
        helper_url=os.environ.get("HELPER_URL", "http://localhost:3002"),
        # Test accounts — replace with the real seeded accounts/roles from the docs.
        # Keep secrets out of source: read from env when the engagement provides them.
        accounts={
            "admin": Account(
                username=os.environ.get("ADMIN_USER", "admin@example.com"),
                password=os.environ.get("ADMIN_PASS", "CHANGE_ME"),
            ),
            "user": Account(
                username=os.environ.get("USER_USER", "user@example.com"),
                password=os.environ.get("USER_PASS", "CHANGE_ME"),
            ),
        },
    )


ENV: Env = _load()

# Role names usable with api_as(role) / login(role). Adapt to the real role model.
ROLES: tuple[str, ...] = tuple(ENV.accounts.keys())


def current_api_url() -> str:
    """The API every client uses: ENV.api_url, except in a cf-* evidence pass.

    There the root conftest's counterfactual fixture points ARGUS_COUNTERFACTUAL_API_URL at
    the in-process stub (TEMPLATE-CONTRACT.md SD-10). Only an http://127.0.0.1 URL is
    honoured, so a stray value never redirects the suite to another host. ENV.api_url itself
    always stays the real target.
    """
    if not os.environ.get("ARGUS_EVIDENCE_PASS", "").startswith("cf-"):
        return ENV.api_url
    value = os.environ.get("ARGUS_COUNTERFACTUAL_API_URL", "")
    try:
        parts = urlsplit(value)
        loopback = parts.scheme == "http" and parts.hostname == "127.0.0.1"
    except ValueError:
        return ENV.api_url
    return value if loopback else ENV.api_url
