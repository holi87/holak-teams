"""Resource-oriented API client over httpx — endpoint paths live in ONE place.

`Endpoints` is the single registry of paths: specs reference `Endpoints.ORDERS`,
never a raw string, so an API rename is a one-line change here. `login()` + the
per-role token cache keep auth out of the specs (the conftest `api_as` fixture
wraps this). ADAPT-ME: rename/extend per the real OpenAPI surface.
"""
from __future__ import annotations

from typing import Any

import httpx

from qa.config import ENV


class Endpoints:
    """Every path the suite hits, declared once. Adapt to the real OpenAPI surface."""

    AUTH_LOGIN = "/auth/login"
    HEALTH = "/health"
    ME = "/me"
    ORDERS = "/orders"


def make_client(
    *,
    base_url: str | None = None,
    token: str | None = None,
    timeout: float = 30.0,
) -> httpx.Client:
    """Build an httpx.Client pinned to the API base URL, optionally bearer-authed."""
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"  # <-- adapt scheme (Bearer/JWT/cookie)
    return httpx.Client(base_url=base_url or ENV.api_url, headers=headers, timeout=timeout)


# Token cache — one login per role for the whole run, not per test.
_token_cache: dict[str, str] = {}


def login(role: str) -> str:
    """Authenticate `role` and return its token (cached). Adapt to the real auth flow."""
    cached = _token_cache.get(role)
    if cached:
        return cached

    creds = ENV.accounts[role]
    with make_client() as client:
        res = client.post(
            Endpoints.AUTH_LOGIN,
            json={"username": creds.username, "password": creds.password},  # <-- adapt payload
        )
    if res.status_code >= 400:
        raise RuntimeError(f"login({role}) failed: {res.status_code} {res.text[:300]}")
    body = res.json()
    token = body.get("token") or body.get("accessToken")  # <-- adapt token field
    if not token:
        raise RuntimeError(f"login({role}) returned no token field in {body!r}")
    _token_cache[role] = token
    return token


class ResourceClient:
    """Thin REST wrapper for one resource — keeps specs readable, paths centralised.

    Example: ``ResourceClient(api_as("user"), Endpoints.ORDERS).create(build_order())``.
    """

    def __init__(self, client: httpx.Client, base_path: str) -> None:
        self._client = client
        self._base = base_path.rstrip("/")

    def list(self, params: dict[str, Any] | None = None) -> httpx.Response:
        return self._client.get(self._base, params=params)

    def get(self, resource_id: str | int) -> httpx.Response:
        return self._client.get(f"{self._base}/{resource_id}")

    def create(self, data: Any) -> httpx.Response:
        return self._client.post(self._base, json=data)

    def update(self, resource_id: str | int, data: Any) -> httpx.Response:
        return self._client.put(f"{self._base}/{resource_id}", json=data)

    def delete(self, resource_id: str | int) -> httpx.Response:
        return self._client.delete(f"{self._base}/{resource_id}")
