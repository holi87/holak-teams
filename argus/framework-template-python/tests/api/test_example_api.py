"""@api lane — httpx requests validated against the OpenAPI schema oracle.

ADAPT-ME: replace endpoints/shapes with the real OpenAPI surface. Put each
resource/tag in its own module (tests/api/test_<resource>.py) so parallel writers
don't collide. The api lane runs when solution/test-lanes.tsv enables it (run-tests.sh
selects it by marker); a plain ``pytest -m api`` runs it alone.
"""
from __future__ import annotations

import pytest

from qa.api_client import Endpoints, ResourceClient
from qa.argus.errors import require_env
from qa.data.factory import build_order
from qa.oracles import load_openapi
from qa.schema_oracle import SchemaOracle

pytestmark = pytest.mark.api


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


def test_response_matches_openapi_schema(api_as):
    # The spec is the oracle: every mismatch is a contract-drift bug candidate. It requires
    # OPENAPI_PATH: an unset variable or a missing document is reported as
    # prerequisite-missing before any request, never skipped.
    # ADAPT-ME: if the target publishes no OpenAPI document, delete this test and record the
    # missing contract oracle as a residual risk in solution/TEST-STRATEGY.md.
    openapi_path = require_env("OPENAPI_PATH")
    load_openapi(openapi_path)
    oracle = SchemaOracle(openapi_path)
    res = api_as("user").get(Endpoints.ME)
    oracle.assert_matches(res.json(), "#/components/schemas/User")  # <-- adapt schema ref
