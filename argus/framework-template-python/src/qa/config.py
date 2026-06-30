"""Central config for the target app — the single source of config.

Fill in at the start of an engagement from Kalchas's recon. Everything (URLs,
accounts, roles) comes from the environment with safe local defaults, so the same
suite runs against localhost, CI, or a staging box without code edits.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


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
