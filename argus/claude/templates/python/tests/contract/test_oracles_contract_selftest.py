"""Self-tests for the contract oracles (qa.oracles) and the loopback stub (qa.argus.stub_server).

Every helper passes on a correct stub and fails on a faulty one. Nothing contacts a real
target; each stub binds 127.0.0.1 on an ephemeral port and lives for one test. Negative
cases assert the rejection itself, so a healthy run reports `product pass` for every case.
The OpenAPI fixture is byte-identical to the TypeScript and Java self-test fixtures.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest

from qa.argus.errors import ArgusPrerequisiteError
from qa.argus.stub_server import StubHandler, StubServer
from qa.oracles import (
    REST_STATUS,
    assert_rest_status,
    assert_schema,
    assert_schema_ref,
    assert_schema_strict,
    expect_status,
    idempotent_replay,
    load_openapi,
    normalize,
    replay_with_idempotency_key,
)
from qa.schema_oracle import SchemaOracle

pytestmark = pytest.mark.contract_smoke

OPENAPI_FIXTURE = Path(__file__).parent / "fixtures" / "openapi.selftest.json"
SCHEMAS = "#/components/schemas"
BASE = f"{SCHEMAS}/Base"
WIDGET = f"{SCHEMAS}/Widget"
WIDGET_LIST = f"{SCHEMAS}/WidgetList"
PET = f"{SCHEMAS}/Pet"
SHAPE = f"{SCHEMAS}/Shape"
LABELS = f"{SCHEMAS}/Labels"
USER = f"{SCHEMAS}/User"
COUNTERS = f"{SCHEMAS}/Counters"
ORDER = f"{SCHEMAS}/Order"
SECRET = "argus-never-print-me"
WIDGET_BODY = {"id": 1, "name": "widget", "color": "red", "weight": 2.5}

CONFORMING: dict[str, tuple[str, dict[str, Any]]] = {
    "created": ("POST", {"status": 201, "headers": {"location": "/widgets/9"}, "body": {"id": 9}}),
    "deleted": ("DELETE", {"status": 204}),
    "missing": ("GET", {"status": 404, "body": {"error": "missing"}}),
    "method-not-allowed": ("PATCH", {"status": 405, "headers": {"allow": "GET, DELETE"}}),
    "unsupported-media-type": ("PUT", {"status": 415}),
    "malformed": ("POST", {"status": 400, "body": {"error": "malformed"}}),
    "unauthenticated": ("GET", {"status": 401}),
    "forbidden": ("GET", {"status": 403}),
    "conflict": ("PUT", {"status": 409}),
    "ok": ("GET", {"status": 200, "body": {"id": 1}}),
}


@pytest.fixture(autouse=True)
def _openapi_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    # The schema oracle reads OPENAPI_PATH at call time.
    monkeypatch.setenv("OPENAPI_PATH", str(OPENAPI_FIXTURE))


@pytest.fixture
def http() -> Iterator[httpx.Client]:
    # trust_env=False: a host proxy setting must never route loopback traffic elsewhere.
    with httpx.Client(timeout=10.0, trust_env=False) as client:
        yield client


@contextmanager
def running_stub(exchanges: list[dict[str, Any]] | None = None, handler: StubHandler | None = None) -> Iterator[StubServer]:
    stub = StubServer.start(handler)
    try:
        if exchanges is not None:
            stub.load(exchanges)
        yield stub
    finally:
        stub.stop()


def order_stub(honour_keys: bool) -> StubHandler:
    orders: list[int] = []
    by_key: dict[str, int] = {}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] == "POST" and request["path"] == "/orders":
            key = request["headers"].get("idempotency-key")
            if honour_keys and key and key in by_key:
                return {"status": 200, "body": {"id": by_key[key]}}
            order_id = len(orders) + 1
            orders.append(order_id)
            if key:
                by_key[key] = order_id
            return {"status": 201, "headers": {"location": f"/orders/{order_id}"}, "body": {"id": order_id}}
        if request["method"] == "GET" and request["path"] == "/orders/count":
            return {"status": 200, "body": {"count": len(orders)}}
        return None

    return handler


class PlaywrightShapedResponse:
    """The sync-API shape of a Playwright APIResponse: properties plus a text() method."""

    status = 201
    url = f"http://127.0.0.1:9/widgets?access_token={SECRET}"
    headers = {"Location": "/widgets/9"}

    def text(self) -> str:
        return json.dumps({"id": 9, "password": SECRET})


def test_strict_schema_undocumented_field_is_red() -> None:
    assert_schema_ref({"id": 1, "name": "widget"}, BASE)
    with pytest.raises(AssertionError, match="surprise"):
        assert_schema_ref({"id": 1, "name": "widget", "surprise": True}, BASE)


def test_strict_schema_valid_all_of_body_is_green() -> None:
    assert_schema_ref(WIDGET_BODY, WIDGET)
    assert_schema_ref({"id": 2, "name": "plain"}, WIDGET)


def test_strict_schema_all_of_body_with_extra_field_is_red() -> None:
    with pytest.raises(AssertionError, match="surprise"):
        assert_schema_ref({**WIDGET_BODY, "surprise": 1}, WIDGET)


def test_strict_schema_one_of_body_is_green_and_extra_field_is_red() -> None:
    assert_schema_ref({"kind": "cat", "meows": True}, PET)
    assert_schema_ref({"kind": "dog", "barks": False}, PET)
    # Members are closed too, so a body of loose members matches exactly one of them.
    assert_schema_ref({"radius": 2}, SHAPE)
    with pytest.raises(AssertionError):
        assert_schema_ref({"kind": "cat", "meows": True, "barks": True}, PET)


def test_strict_schema_use_site_declaring_pattern_properties_stays_open() -> None:
    assert_schema_ref({"name": "labels", "x-trace": "abc", "other": 1}, LABELS)
    with pytest.raises(AssertionError, match="x-trace"):
        assert_schema_ref({"x-trace": 5}, LABELS)


def test_openapi_30_nullable_null_is_green_where_documented() -> None:
    assert_schema_ref({"id": 7, "email": "qa@example.com", "nickname": None, "manager": None}, USER)
    assert_schema_ref({"id": 7, "email": "qa@example.com", "manager": {"id": 1, "name": "lead"}}, USER)
    assert_schema_ref({"id": 1, "name": "widget", "color": None}, WIDGET)
    with pytest.raises(AssertionError):
        assert_schema_ref({"id": 1, "name": None}, BASE)


def test_openapi_30_boolean_exclusive_minimum_is_enforced() -> None:
    assert_schema_ref({"id": 1, "name": "widget", "weight": 0.5}, WIDGET)
    with pytest.raises(AssertionError, match="weight"):
        assert_schema_ref({"id": 1, "name": "widget", "weight": 0}, WIDGET)


def test_response_direction_write_only_field_is_red_and_redacted() -> None:
    leaked = {"id": 7, "email": "qa@example.com", "password": SECRET}
    with pytest.raises(AssertionError, match="password") as caught:
        assert_schema_ref(leaked, USER)
    assert "[REDACTED]" in str(caught.value)
    assert SECRET not in str(caught.value)
    # The response direction drops the writeOnly property from `required` as well.
    assert_schema_ref({"id": 7, "email": "qa@example.com"}, USER)


def test_request_direction_read_only_fields_are_removed() -> None:
    assert_schema_ref({"email": "qa@example.com", "password": "correct-horse"}, USER, direction="request")
    with pytest.raises(AssertionError, match="'id' was unexpected"):
        assert_schema_ref({"id": 7, "email": "qa@example.com", "password": "correct-horse"}, USER, direction="request")
    # A violation below a secret-looking key never echoes the value.
    with pytest.raises(AssertionError, match="/password: minLength") as caught:
        assert_schema_ref({"email": "qa@example.com", "password": "hunter2"}, USER, direction="request")
    assert "hunter2" not in str(caught.value)


def test_documented_additional_properties_map_extra_keys_are_green() -> None:
    assert_schema_ref({"widgets": 3, "orders": 0, "any key": 12}, COUNTERS)
    with pytest.raises(AssertionError, match="widgets"):
        assert_schema_ref({"widgets": "three"}, COUNTERS)


def test_array_of_objects_item_with_extra_field_is_red() -> None:
    assert_schema_ref([{"id": 1, "name": "a"}, {"id": 2, "name": "b"}], WIDGET_LIST)
    with pytest.raises(AssertionError, match="surprise"):
        assert_schema_ref([{"id": 1, "name": "a"}, {"id": 2, "name": "b", "surprise": True}], WIDGET_LIST)


def test_nested_inline_object_extra_field_is_red() -> None:
    assert_schema_ref({"id": 1, "shipping": {"city": "Gdansk", "zip": "80-001"}}, ORDER)
    with pytest.raises(AssertionError, match="shipping"):
        assert_schema_ref({"id": 1, "shipping": {"city": "Gdansk", "surprise": True}}, ORDER)


def test_operation_lookup_undocumented_status_is_red(http: httpx.Client) -> None:
    exchanges = [
        {"id": "widget-ok", "request": {"method": "GET", "path": "/widgets/1"}, "response": {"status": 200, "body": WIDGET_BODY}},
        {"id": "widget-created", "request": {"method": "GET", "path": "/widgets/2"}, "response": {"status": 201, "body": WIDGET_BODY}},
    ]
    with running_stub(exchanges) as stub:
        assert_schema(http.get(f"{stub.url}/widgets/1"), "getWidget")
        with pytest.raises(AssertionError, match="HTTP 201 is not documented"):
            assert_schema(http.get(f"{stub.url}/widgets/2"), "getWidget")
    with pytest.raises(AssertionError, match="HTTP 500 is not documented"):
        assert_schema({"status": 500, "body": {"error": "boom"}}, "getWidget")


def test_operation_lookup_referenced_and_bodiless_responses() -> None:
    assert_schema({"status": 404, "body": {"error": "no such user"}}, "getUser")
    with pytest.raises(AssertionError, match="trace"):
        assert_schema({"status": 404, "body": {"error": "no such user", "trace": "x"}}, "getUser")
    assert_schema({"status": 204}, "deleteWidget")
    with pytest.raises(AssertionError, match="documents no content"):
        assert_schema({"status": 204, "body": {"deleted": True}}, "deleteWidget")
    with pytest.raises(ValueError, match="not defined"):
        assert_schema({"status": 200, "body": {}}, "noSuchOperation")


def test_operation_lookup_resolves_exact_code_then_range_then_default() -> None:
    # 404 has its own key, so the 4XX schema's extra field is RED there.
    assert_schema({"status": 404, "body": {"error": "no such gadget"}}, "getGadget")
    with pytest.raises(AssertionError, match="fields"):
        assert_schema({"status": 404, "body": {"error": "no such gadget", "fields": []}}, "getGadget")
    # 422 falls under 4XX, which requires fields: the default Error body alone is RED.
    assert_schema({"status": 422, "body": {"error": "invalid", "fields": ["name"]}}, "getGadget")
    with pytest.raises(AssertionError, match="HTTP 422 via 4XX"):
        assert_schema({"status": 422, "body": {"error": "invalid"}}, "getGadget")
    # 500 falls under default.
    assert_schema({"status": 500, "body": {"error": "boom"}}, "getGadget")
    with pytest.raises(AssertionError, match="HTTP 500 via default"):
        assert_schema({"status": 500, "body": {"error": "boom", "trace": "x"}}, "getGadget")


def test_strict_false_with_reason_is_green_and_without_reason_raises() -> None:
    drifted = {"status": 200, "body": {"id": 1, "name": "widget", "legacyField": True}}
    assert_schema(drifted, "getWidget", strict=False, reason="legacyField is a recorded, accepted drift")
    with pytest.raises(ValueError, match="reason"):
        assert_schema(drifted, "getWidget", strict=False)
    with pytest.raises(ValueError, match="reason"):
        assert_schema(drifted, "getWidget", strict=False, reason="  ")
    with pytest.raises(AssertionError, match="legacyField"):
        assert_schema(drifted, "getWidget")


def test_assert_schema_strict_and_schema_oracle_are_strict() -> None:
    with pytest.raises(AssertionError, match="surprise"):
        assert_schema_strict({"id": 1, "name": "widget", "surprise": 1}, BASE)
    oracle = SchemaOracle(str(OPENAPI_FIXTURE))
    with pytest.raises(AssertionError, match="surprise"):
        oracle.assert_matches({"id": 1, "name": "widget", "surprise": 1}, BASE)
    assert any("surprise" in problem for problem in oracle.errors({"id": 1, "name": "widget", "surprise": 1}, "Base"))
    assert oracle.errors({"id": 1, "name": "widget"}, "Base") == []
    oracle.assert_matches({"id": 1, "name": "widget"}, BASE)


def test_missing_or_invalid_openapi_document_is_not_a_product_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OPENAPI_PATH", str(tmp_path / "missing.json"))
    with pytest.raises(ArgusPrerequisiteError, match="OPENAPI_PATH"):
        assert_schema_ref({"id": 1}, BASE)
    swagger = tmp_path / "swagger.json"
    swagger.write_text(json.dumps({"swagger": "2.0"}), encoding="utf-8")
    monkeypatch.setenv("OPENAPI_PATH", str(swagger))
    with pytest.raises(ValueError, match="not an OpenAPI 3.x document"):
        assert_schema_ref({"id": 1}, BASE)


def test_normalize_component_roots_and_all_of_members_stay_open_use_sites_close() -> None:
    source = load_openapi(OPENAPI_FIXTURE)
    normalized = normalize(source, "response")
    response = normalized["components"]["schemas"]

    def body_schema(path: str) -> Any:
        return normalized["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]

    assert body_schema("/widgets/{id}") == {"allOf": [{"$ref": f"{SCHEMAS}/Widget"}], "unevaluatedProperties": False}
    # A use site whose target declares additionalProperties is left as the author wrote it.
    assert body_schema("/counters") == {"$ref": f"{SCHEMAS}/Counters"}
    assert "unevaluatedProperties" not in response["Base"]
    assert response["Widget"] == {"allOf": [{"$ref": f"{SCHEMAS}/Base"}, {"$ref": f"{SCHEMAS}/Ext"}]}
    assert response["Base"]["properties"]["name"] == {"allOf": [{"type": "string"}], "unevaluatedProperties": False}
    assert response["Order"]["properties"]["shipping"]["unevaluatedProperties"] is False
    assert response["Counters"] == {"type": "object", "additionalProperties": {"allOf": [{"type": "integer"}], "unevaluatedProperties": False}}
    assert response["Ext"]["properties"]["weight"]["allOf"][0] == {"type": "number", "exclusiveMinimum": 0}
    assert response["Ext"]["properties"]["color"]["allOf"][0] == {"type": ["string", "null"], "enum": ["red", "blue", None]}
    assert "password" not in response["User"]["properties"]
    assert response["User"]["required"] == ["id", "email"]
    assert response["User"]["properties"]["nickname"]["allOf"][0] == {"type": ["string", "null"]}
    assert '"anyOf"' in json.dumps(response["User"]["properties"]["manager"])
    request = normalize(source, "request", strict=False)["components"]["schemas"]
    assert request["User"]["required"] == ["email", "password"]
    assert "id" not in request["User"]["properties"]
    assert request["Base"]["properties"]["name"] == {"type": "string"}
    assert source["components"]["schemas"]["User"]["required"] == ["id", "email", "password"]


def test_expect_status_compares_one_exact_status_code(http: httpx.Client) -> None:
    exchanges = [{
        "id": "create",
        "request": {"method": "POST", "path": "/widgets"},
        "response": {"status": 201, "headers": {"location": "/widgets/9"}, "body": {"id": 9, "token": SECRET}},
    }]
    with running_stub(exchanges) as stub:
        res = http.post(f"{stub.url}/widgets", json={"name": "widget"})
        expect_status(res, 201)
        with pytest.raises(AssertionError, match=r"expected HTTP 200, got 201: method=POST url=http://127\.0\.0\.1:\d+/widgets"):
            expect_status(res, 200, method="POST")
        with pytest.raises(AssertionError) as caught:
            expect_status(res, 200)
        assert "[REDACTED]" in str(caught.value)
        assert SECRET not in str(caught.value)
        with pytest.raises(ValueError):
            expect_status(res, 2)


def test_oracles_accept_a_playwright_shaped_response() -> None:
    fake = PlaywrightShapedResponse()
    expect_status(fake, 201)
    assert_rest_status(fake, "created")
    with pytest.raises(AssertionError, match=r"expected HTTP 200, got 201: method=- url=http://127\.0\.0\.1:9/widgets") as caught:
        expect_status(fake, 200)
    assert SECRET not in str(caught.value)


def test_assert_rest_status_every_state_is_green_on_a_conforming_stub(http: httpx.Client) -> None:
    assert len(REST_STATUS) == 10
    assert set(CONFORMING) == set(REST_STATUS)
    exchanges = [
        {"id": state, "request": {"method": method, "path": f"/rest/{state}"}, "response": response}
        for state, (method, response) in CONFORMING.items()
    ]
    with running_stub(exchanges) as stub:
        for state, (method, _response) in CONFORMING.items():
            assert_rest_status(http.request(method, f"{stub.url}/rest/{state}"), state)
        assert stub.unmatched() == []


def test_assert_rest_status_wrong_code_or_missing_location_allow_or_empty_body_is_red(http: httpx.Client) -> None:
    exchanges = [
        {"id": "no-location", "request": {"method": "POST", "path": "/no-location"}, "response": {"status": 201, "body": {"id": 1}}},
        {"id": "no-allow", "request": {"method": "PATCH", "path": "/no-allow"}, "response": {"status": 405}},
        {"id": "gone", "request": {"method": "GET", "path": "/gone"}, "response": {"status": 410}},
        {"id": "no-content", "request": {"method": "GET", "path": "/no-content"}, "response": {"status": 204}},
    ]
    with running_stub(exchanges) as stub:
        with pytest.raises(AssertionError, match="Location"):
            assert_rest_status(http.post(f"{stub.url}/no-location"), "created")
        with pytest.raises(AssertionError, match="Allow"):
            assert_rest_status(http.patch(f"{stub.url}/no-allow"), "method-not-allowed")
        with pytest.raises(AssertionError, match="expected HTTP 404, got 410"):
            assert_rest_status(http.get(f"{stub.url}/gone"), "missing")
        with pytest.raises(AssertionError, match="expected HTTP 200, got 204"):
            assert_rest_status(http.get(f"{stub.url}/no-content"), "ok")
    # HTTP drops content on a 204, so a body can only be shown through the record form.
    with pytest.raises(AssertionError, match="non-empty body"):
        assert_rest_status({"status": 204, "body": {"deleted": True}}, "deleted")
    with pytest.raises(AssertionError, match="Location"):
        assert_rest_status({"status": 201, "headers": {"Location": " "}}, "created")
    with pytest.raises(ValueError, match="unknown state"):
        assert_rest_status({"status": 200}, "fine")  # type: ignore[arg-type]


def test_assert_rest_status_documented_status_overrides_the_code_never_a_class() -> None:
    assert_rest_status({"status": 200, "body": {"id": 9}}, "created", documented_status=200)
    with pytest.raises(AssertionError, match="expected HTTP 200, got 201"):
        assert_rest_status({"status": 201, "headers": {"location": "/x/9"}}, "created", documented_status=200)
    assert_rest_status({"status": 422}, "malformed", documented_status=422)
    with pytest.raises(TypeError, match="never a class"):
        assert_rest_status({"status": 422}, "malformed", documented_status="4XX")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="never a class"):
        assert_rest_status({"status": 400}, "malformed", documented_status=4)


def test_idempotent_replay_is_green_on_a_deterministic_stub(http: httpx.Client) -> None:
    calls = {"put": 0}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] == "PUT" and request["path"] == "/widgets/1":
            calls["put"] += 1
            return {"status": 200, "body": {"id": 1, "name": "widget", "meta": {"requestId": calls["put"]}}}
        if request["method"] == "GET" and request["path"] == "/widgets/1":
            return {"status": 200, "body": {"id": 1, "name": "widget"}}
        return None

    with running_stub(handler=handler) as stub:
        result = idempotent_replay(
            send=lambda: http.put(f"{stub.url}/widgets/1", json={"name": "widget"}),
            read=lambda: http.get(f"{stub.url}/widgets/1").json(),
            volatile_fields=["requestId"],
            require_same_response=True,
        )
    assert result.status == 200
    assert calls["put"] == 2


def test_idempotent_replay_is_red_on_a_counter_stub(http: httpx.Client) -> None:
    counters = {"version": 0, "visits": 0}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] == "PUT" and request["path"] == "/widgets/1":
            counters["version"] += 1
            return {"status": 200, "body": {"id": 1, "version": counters["version"]}}
        if request["method"] == "GET" and request["path"] == "/widgets/1":
            return {"status": 200, "body": {"id": 1}}
        if request["method"] == "POST" and request["path"] == "/visits":
            counters["visits"] += 1
            return {"status": 204}
        if request["method"] == "GET" and request["path"] == "/visits":
            return {"status": 200, "body": {"total": counters["visits"]}}
        return None

    with running_stub(handler=handler) as stub:
        with pytest.raises(AssertionError, match="changed the body"):
            idempotent_replay(
                send=lambda: http.put(f"{stub.url}/widgets/1"),
                read=lambda: http.get(f"{stub.url}/widgets/1").json(),
                require_same_response=True,
            )
        # Identical responses, but the state keeps counting.
        with pytest.raises(AssertionError, match="changed the state"):
            idempotent_replay(
                send=lambda: http.post(f"{stub.url}/visits"),
                read=lambda: http.get(f"{stub.url}/visits").json(),
            )


def test_idempotent_replay_compares_responses_only_for_an_explicit_api_contract() -> None:
    responses = iter([{"status": 200, "body": {"requestId": 1}}, {"status": 200, "body": {"requestId": 2}}])
    idempotent_replay(send=lambda: next(responses), read=lambda: {"id": 1})
    responses = iter([{"status": 201, "body": {"id": 1}}, {"status": 200, "body": {"id": 1}}])
    with pytest.raises(AssertionError, match="changed the status"):
        idempotent_replay(send=lambda: next(responses), read=lambda: {"id": 1}, require_same_response=True)


def test_idempotent_replay_requires_an_independent_effect_oracle_before_sending() -> None:
    sends = []
    with pytest.raises(TypeError, match=r"read\(\) is required"):
        idempotent_replay(send=lambda: sends.append(True) or {"status": 200}, require_same_response=True)
    assert sends == []


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
def test_idempotent_replay_accepts_response_changes_when_the_effect_is_unchanged(http: httpx.Client, method: str) -> None:
    state = {"present": method == "DELETE", "sends": 0}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] == method and request["path"] == "/widgets/1":
            state["sends"] += 1
            state["present"] = method == "PUT"
            if method == "PUT":
                return {"status": 201 if state["sends"] == 1 else 200, "body": {"action": "created" if state["sends"] == 1 else "replaced"}}
            return {"status": 204} if state["sends"] == 1 else {"status": 404, "body": {"error": "missing"}}
        if request["method"] == "GET" and request["path"] == "/widgets/1":
            return {"status": 200, "body": {"present": state["present"]}}
        return None

    with running_stub(handler=handler) as stub:
        result = idempotent_replay(
            send=lambda: http.request(method, f"{stub.url}/widgets/1"),
            read=lambda: http.get(f"{stub.url}/widgets/1").json(),
        )
    assert result.state == {"present": method == "PUT"}
    assert state["sends"] == 2


def test_replay_with_idempotency_key_is_green_when_the_key_deduplicates_the_create(http: httpx.Client) -> None:
    with running_stub(handler=order_stub(True)) as stub:
        result = replay_with_idempotency_key(
            send=lambda key: http.post(f"{stub.url}/orders", headers={"Idempotency-Key": key}, json={"sku": "A-1"}),
            count=lambda: http.get(f"{stub.url}/orders/count").json()["count"],
            id_of=lambda res: res.json()["id"],
        )
        assert result.id == 1
        keys = [record["headers"]["idempotency-key"] for record in stub.requests() if record["method"] == "POST"]
    assert result.key.startswith("argus-idem-") and result.key[len("argus-idem-"):].isdigit()
    assert keys == [result.key, result.key]


def test_replay_with_idempotency_key_is_red_when_the_key_is_ignored(http: httpx.Client) -> None:
    with running_stub(handler=order_stub(False)) as stub:
        with pytest.raises(AssertionError, match="exactly one effect"):
            replay_with_idempotency_key(
                send=lambda key: http.post(f"{stub.url}/orders", headers={"Idempotency-Key": key}, json={"sku": "A-1"}),
                count=lambda: http.get(f"{stub.url}/orders/count").json()["count"],
                id_of=lambda res: res.json()["id"],
            )


def test_stub_unmatched_request_gets_501_and_is_recorded(http: httpx.Client) -> None:
    exchanges = [
        {"id": "widget", "request": {"method": "GET", "path": "/widgets/1"}, "response": {"status": 200, "body": {"id": 1, "name": "widget"}}},
        {"id": "page-two", "request": {"method": "GET", "path": "/widgets", "query": {"page": "2"}}, "response": {"status": 200, "body": []}},
    ]
    with running_stub(exchanges) as stub:
        hit = http.get(f"{stub.url}/widgets/1")
        expect_status(hit, 200)
        assert hit.headers["content-type"] == "application/json"
        assert hit.json() == {"id": 1, "name": "widget"}
        expect_status(http.get(f"{stub.url}/widgets?page=2&sort=name"), 200)
        miss = http.get(f"{stub.url}/widgets?page=3")
        expect_status(miss, 501)
        assert miss.json() == {"argusStub": "unmatched"}
        expect_status(http.post(f"{stub.url}/widgets/1"), 501)
        assert [f"{record['method']} {record['path']}" for record in stub.unmatched()] == ["GET /widgets", "POST /widgets/1"]
        assert [record["matched"] for record in stub.requests()] == ["widget", "page-two", None, None]
        stub.load([])
        assert stub.requests() == []


def test_stub_resolve_serves_exchanges_without_the_network_and_a_failing_handler_answers_500(http: httpx.Client) -> None:
    exchanges = [
        {"id": "widget", "request": {"method": "GET", "path": "/widgets/1"}, "response": {"status": 200, "body": {"id": 1}}},
        {"id": "page-two", "request": {"method": "GET", "path": "/widgets", "query": {"page": "2"}}, "response": {"status": 200, "body": []}},
    ]

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["path"] == "/explode":
            raise RuntimeError("handler failure on purpose")
        return None

    with running_stub(exchanges, handler) as stub:
        assert stub.resolve("GET", "/widgets/1") == {"status": 200, "body": {"id": 1}}
        assert stub.resolve("get", "/widgets?page=2") == {"status": 200, "body": []}
        assert stub.resolve("GET", "/widgets", {"page": "3"}) is None
        assert [record["path"] for record in stub.unmatched()] == ["/widgets"]
        exploded = http.get(f"{stub.url}/explode")
        expect_status(exploded, 500)
        assert exploded.json() == {"argusStub": "handler-error"}
        assert stub.requests()[-1]["matched"] == "handler-error"


def test_stub_invalid_exchanges_are_refused() -> None:
    valid = {"id": "ok", "request": {"method": "GET", "path": "/ok"}, "response": {"status": 200}}
    with running_stub() as stub:
        with pytest.raises(TypeError):
            stub.load([{**valid, "id": "Not Valid"}])
        with pytest.raises(TypeError, match="duplicate"):
            stub.load([valid, valid])
        with pytest.raises(TypeError, match="uppercase"):
            stub.load([{**valid, "request": {"method": "get", "path": "/ok"}}])
        with pytest.raises(TypeError, match="start with"):
            stub.load([{**valid, "request": {"method": "GET", "path": "ok"}}])
        with pytest.raises(TypeError, match="lowercase"):
            stub.load([{**valid, "response": {"status": 200, "headers": {"Content-Type": "text/plain"}}}])
        with pytest.raises(TypeError, match="status"):
            stub.load([{**valid, "response": {"status": 42}}])
