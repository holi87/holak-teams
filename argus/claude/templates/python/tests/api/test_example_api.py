"""@api lane — httpx requests validated against the OpenAPI schema oracle.

ADAPT-ME: replace endpoints/shapes with the real OpenAPI surface. Put each
resource/tag in its own module (tests/api/test_<resource>.py) so parallel writers
don't collide.
"""
from __future__ import annotations

import os

import pytest

from qa.api_client import Endpoints, ResourceClient
from qa.data.factory import build_order
from qa.schema_oracle import SchemaOracle

pytestmark = pytest.mark.api

OPENAPI_PATH = os.environ.get("OPENAPI_PATH", "./openapi.json")


def test_health_endpoint_responds(anon_client):
    res = anon_client.get(Endpoints.HEALTH)  # <-- adapt
    assert res.status_code == 200


def test_authenticated_read_returns_contracted_shape(api_as):
    res = api_as("user").get(Endpoints.ME)  # <-- adapt
    assert res.status_code == 200
    body = res.json()
    assert "id" in body  # <-- assert the real contract from OpenAPI


def test_create_with_valid_data_succeeds(api_as, created_resources):
    user = api_as("user")
    orders = ResourceClient(user, Endpoints.ORDERS)  # <-- adapt resource
    res = orders.create(build_order())
    assert res.status_code == 201  # <-- assert per OpenAPI
    # Register for teardown so the run leaves no residue (app has no reset command).
    created_resources.append((user, f"{Endpoints.ORDERS}/{res.json().get('id')}"))


def test_protected_route_rejects_anonymous(anon_client):
    res = anon_client.get(Endpoints.ME)  # <-- adapt protected route
    assert res.status_code in (401, 403)


@pytest.mark.skipif(
    not os.path.exists(OPENAPI_PATH),
    reason=(
        "schema oracle disabled: no OpenAPI doc at OPENAPI_PATH "
        "(set OPENAPI_PATH to the spec to enable contract validation)"
    ),
)
def test_response_matches_openapi_schema(api_as):
    # The spec is the oracle: every mismatch is a contract-drift bug candidate.
    oracle = SchemaOracle(OPENAPI_PATH)
    res = api_as("user").get(Endpoints.ME)
    oracle.assert_matches(res.json(), "#/components/schemas/User")  # <-- adapt schema ref
