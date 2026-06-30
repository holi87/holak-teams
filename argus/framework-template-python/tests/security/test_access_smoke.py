"""@security lane — GATED behind SECURITY_ENABLED=1 (explicit opt-in).

Authz / IDOR / broken-access-control checks never run by accident against an
environment that hasn't been cleared for them. The module self-skips unless
SECURITY_ENABLED=1, so an unset run shows security as skipped and exit stays 0.

ADAPT-ME: replace the placeholder routes/roles with the real protected surface
and threat model from recon + OpenAPI.
"""
from __future__ import annotations

import os

import pytest

from qa.api_client import Endpoints

SECURITY_ENABLED = os.environ.get("SECURITY_ENABLED") == "1"

pytestmark = [
    pytest.mark.security,
    pytest.mark.skipif(
        not SECURITY_ENABLED,
        reason="security lane disabled: set SECURITY_ENABLED=1 once the target is cleared",
    ),
]


def test_protected_route_rejects_anonymous(anon_client):
    res = anon_client.get(Endpoints.ME)  # <-- adapt: a real protected route
    assert res.status_code in (401, 403)


# role x operation deny matrix — a non-privileged role must NOT perform privileged
# operations. ADAPT-ME: fill with real (role, method, path) tuples from the threat model.
DENY_MATRIX = [
    ("user", "DELETE", f"{Endpoints.ORDERS}/1"),  # a regular user deleting arbitrary data
    ("user", "GET", "/admin/users"),  # a regular user reading an admin-only resource
]


@pytest.mark.parametrize(
    "role,method,path",
    DENY_MATRIX,
    ids=[f"{r}-cannot-{m}-{p}" for r, m, p in DENY_MATRIX],
)
def test_role_is_denied_privileged_operation(api_as, role, method, path):
    res = api_as(role).request(method, path)
    # 404 is acceptable: a well-behaved API may hide the resource's existence entirely.
    assert res.status_code in (401, 403, 404), (
        f"{role} {method} {path} should be denied, got {res.status_code}"
    )
