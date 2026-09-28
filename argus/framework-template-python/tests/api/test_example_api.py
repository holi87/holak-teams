"""@api lane — httpx requests judged by the exact oracles in qa.oracles.

ADAPT-ME: replace endpoints, operation ids, and the SPEC_* constants with the real OpenAPI
surface. Put each resource/tag in its own module (tests/api/test_<resource>.py) so parallel
writers don't collide. Every oracle is exact: one documented status code, the strict schema
by operationId, and a read-back of what was written. The api lane runs when
solution/test-lanes.tsv enables it (run-tests.sh selects it by marker); a plain
``pytest -m api`` runs it alone.

The schema oracles read OPENAPI_PATH (default ./openapi.json); a missing document is reported
as prerequisite-missing, never skipped. ADAPT-ME: if the target publishes no OpenAPI document,
drop the schema assertions and record the missing contract oracle as a residual risk in
solution/TEST-STRATEGY.md.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from qa.api_client import Endpoints, ResourceClient
from qa.data.factory import build_order
from qa.oracles import (
    assert_rest_status,
    assert_schema,
    boundary3,
    expect_status,
    invalid_object_partitions,
    load_openapi,
    resolve_ref,
)

pytestmark = pytest.mark.api

# ADAPT-ME: each value comes from the OpenAPI document or a written requirement; cite it.
# The status the API documents for an anonymous request to a protected route. Use that one
# code (401 here, 403 if the documentation says so), never a class or a list.
SPEC_ANONYMOUS_STATUS = 401
# The documented rejection of an invalid request body.
SPEC_INVALID_BODY_STATUS = 400
# The documented qty range and the domain's smallest unit (a count moves by 1).
SPEC_QTY_MINIMUM = 1
SPEC_QTY_MAXIMUM = 99
SPEC_QTY_STEP = 1
# The order request schema and the operations whose responses the examples validate.
SPEC_ORDER_INPUT_SCHEMA = "#/components/schemas/OrderInput"
SPEC_READ_ME_OPERATION_ID = "getMe"
SPEC_READ_ORDER_OPERATION_ID = "getOrder"

CreatedResources = list[tuple[httpx.Client, str]]


def register_created(res: httpx.Response, client: httpx.Client, created_resources: CreatedResources) -> str | None:
    """Register the Location for teardown before any assertion, so a RED still cleans up what was created."""
    location = res.headers.get("location")
    if location:
        created_resources.append((client, location))
    return location


def post_json(client: httpx.Client, path: str, value: Any) -> httpx.Response:
    """POST ``value`` as a JSON body; unlike ``json=``, None is sent as a JSON null, not as no body."""
    return client.post(path, content=json.dumps(value).encode("utf-8"), headers={"content-type": "application/json"})


def test_health_endpoint_responds(anon_client):
    res = anon_client.get(Endpoints.HEALTH)  # <-- adapt
    expect_status(res, 200)


def test_authenticated_read_returns_contracted_shape(api_as):
    res = api_as("user").get(Endpoints.ME)  # <-- adapt
    expect_status(res, 200)
    assert_schema(res, SPEC_READ_ME_OPERATION_ID)  # strict, so an undocumented field is RED


def test_create_answers_201_with_a_location_that_reads_back_what_was_written(api_as, created_resources):
    user = api_as("user")
    orders = ResourceClient(user, Endpoints.ORDERS)  # <-- adapt resource
    data = build_order()
    res = orders.create(data)
    location = register_created(res, user, created_resources)
    expect_status(res, 201)
    assert_rest_status(res, "created", require_location=True)  # 201 with a non-empty Location
    read_back = user.get(location)
    expect_status(read_back, 200)
    body = read_back.json()
    assert {name: body.get(name) for name in data} == data, "the read-back differs from what was written"
    assert_schema(read_back, SPEC_READ_ORDER_OPERATION_ID)


def test_protected_route_rejects_anonymous_with_the_documented_status(anon_client):
    res = anon_client.get(Endpoints.ME)  # <-- adapt protected route
    expect_status(res, SPEC_ANONYMOUS_STATUS)


def test_qty_is_accepted_exactly_from_its_minimum_to_its_maximum(api_as, created_resources):
    user = api_as("user")
    orders = ResourceClient(user, Endpoints.ORDERS)  # <-- adapt resource

    def probe(qty: int) -> bool:
        # Accepted means 201 with a Location, rejected means exactly the documented 400; any
        # other status is RED, so the probe cannot mistake a 500 for a validation error.
        res = orders.create(build_order(qty=qty))
        register_created(res, user, created_resources)
        if res.status_code == 201:
            assert_rest_status(res, "created", require_location=True)
            return True
        expect_status(res, SPEC_INVALID_BODY_STATUS)
        return False

    boundary3(boundary=SPEC_QTY_MINIMUM, step=SPEC_QTY_STEP, probe=probe, accept_below=False, accept_at=True, accept_above=True)
    boundary3(boundary=SPEC_QTY_MAXIMUM, step=SPEC_QTY_STEP, probe=probe, accept_below=True, accept_at=True, accept_above=False)


def test_every_invalid_order_partition_is_rejected_with_the_documented_status(api_as, created_resources):
    user = api_as("user")
    # ADAPT-ME: the resolved request schema (no $ref or allOf inside). A bounded number without
    # multipleOf needs its smallest unit: invalid_object_partitions(..., number_steps={"price": 0.01}).
    schema = resolve_ref(load_openapi(), SPEC_ORDER_INPUT_SCHEMA)
    problems: list[str] = []
    for partition in invalid_object_partitions(schema, build_order()):
        res = post_json(user, Endpoints.ORDERS, partition.value)  # <-- adapt resource
        register_created(res, user, created_resources)
        try:
            expect_status(res, SPEC_INVALID_BODY_STATUS)
        except AssertionError as error:
            problems.append(f"{partition.label}: {error}")
    assert not problems, "invalid order partitions not rejected with the documented status:\n" + "\n".join(problems)
