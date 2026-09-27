"""@security lane — behind an explicit clearance (SECURITY_ENABLED=1).

Authz / IDOR / broken-access-control checks never run by accident against an
environment that hasn't been cleared for them. The lane runs only when
solution/test-lanes.tsv enables it, and then every case requires SECURITY_ENABLED=1: any
other value is reported through ArgusPrerequisiteError as ``prerequisite-missing``; the tests
never skip themselves.

ADAPT-ME: replace the placeholder routes/roles with the real protected surface
and threat model from recon + OpenAPI.
"""
from __future__ import annotations

import pytest

from qa.api_client import Endpoints
from qa.argus.errors import ArgusPrerequisiteError, require_env

pytestmark = pytest.mark.security


@pytest.fixture(autouse=True)
def _cleared_for_security_checks() -> None:
    if require_env("SECURITY_ENABLED") != "1":
        raise ArgusPrerequisiteError("SECURITY_ENABLED must be 1 once the target is cleared")


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
