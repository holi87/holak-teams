"""Self-tests for the data oracles (partitions, pagination, boundary, identity, i18n).

Every helper passes on a correct in-memory or stub implementation and fails on a faulty one.
Nothing contacts a real target; each stub binds 127.0.0.1 on an ephemeral port and lives for
one test. Negative cases assert the rejection itself, so a healthy run reports `product
pass` for every case. The cases mirror the TypeScript and Java data oracle self-tests.
"""
from __future__ import annotations

import copy
import dataclasses
from email.headerregistry import Address
from email.errors import HeaderParseError
import json
import re
import unicodedata
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from decimal import Decimal
from typing import Any

import httpx
import pytest
from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators

from qa.argus.stub_server import StubHandler, StubServer
from qa.oracles import (
    I18N_VECTORS,
    IDENTITY_VECTORS,
    INVALID_EMAILS,
    Credentials,
    CredentialCheck,
    MoneyReconciliation,
    PageRequest,
    PageResult,
    PaginationResult,
    Partition,
    assert_collection_conservation,
    boundary3,
    case_variants,
    credential_consistency,
    expect_status,
    i18n_charset,
    invalid_object_partitions,
    invalid_partitions,
    money_reconciles,
    paginate_all,
    percentages_sum_to_100,
    valid_email,
)

pytestmark = pytest.mark.contract_smoke

# The partition reference checks the dot-atom email subset used here, including single-label
# domains (jsonschema's own email check only looks for an "@"), and exact decimal multipleOf
# (a float quotient judges 19.99 as no multiple of 0.01).
_EMAIL = re.compile(
    r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?",
    re.IGNORECASE | re.ASCII,
)
FORMATS = FormatChecker(formats=())


@FORMATS.checks("email")
def _is_email(value: object) -> bool:
    return not isinstance(value, str) or _EMAIL.fullmatch(value) is not None


def _exact_multiple_of(validator: Any, divisor: Any, instance: Any, schema: Any) -> Iterator[ValidationError]:
    if validator.is_type(instance, "number") and Decimal(repr(instance)) % Decimal(repr(divisor)) != 0:
        yield ValidationError(f"{instance!r} is not a multiple of {divisor!r}")


ReferenceValidator = validators.extend(Draft202012Validator, {"multipleOf": _exact_multiple_of})

ORDER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["sku", "qty"],
    "properties": {
        "id": {"type": "integer", "readOnly": True},
        "sku": {"type": "string", "minLength": 3, "maxLength": 12, "pattern": "^[A-Za-z0-9-]+$"},
        "qty": {"type": "integer", "minimum": 1, "maximum": 99},
        "note": {"type": ["string", "null"], "maxLength": 20},
    },
    "additionalProperties": False,
}
VALID_ORDER: dict[str, Any] = {"sku": "SKU-1", "qty": 2, "note": None}
PROFILE_MAX_LENGTH = 20


@pytest.fixture
def http() -> Iterator[httpx.Client]:
    # trust_env=False: a host proxy setting must never route loopback traffic elsewhere.
    with httpx.Client(timeout=10.0, trust_env=False) as client:
        yield client


@contextmanager
def running_stub(handler: StubHandler) -> Iterator[StubServer]:
    stub = StubServer.start(handler)
    try:
        yield stub
    finally:
        stub.stop()


def validator(schema: dict[str, Any]) -> Any:
    return ReferenceValidator(schema, format_checker=FORMATS)


def labels(partitions: list[Partition]) -> list[str]:
    return [partition.label for partition in partitions]


def value_of(partitions: list[Partition], label: str) -> Any:
    return next((partition.value for partition in partitions if partition.label == label), None)


def code_points(value: str) -> list[int]:
    return [ord(char) for char in value]


def post_json(http: httpx.Client, url: str, value: Any) -> httpx.Response:
    # json= would send no body at all for None; the null-body partition must send a JSON null.
    return http.post(url, content=json.dumps(value).encode("utf-8"), headers={"content-type": "application/json"})


def order_endpoint(schema: dict[str, Any]) -> StubHandler:
    """POST /orders answers 201 when ``schema`` accepts the body and 400 otherwise."""
    check = validator(schema)

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] != "POST" or request["path"] != "/orders":
            return None
        if check.is_valid(request["body"]):
            return {"status": 201, "body": {"id": 1}}
        return {"status": 400, "body": {"error": "invalid order"}}

    return handler


def page_stub(count: int, *, overlap: bool = False, total_drift: int = 0, ignore_page: bool = False) -> StubHandler:
    """GET /items?page=&pageSize= over ``count`` items with 1-based pages.

    Faults: ``overlap`` starts every page after the first one item early (the last item of a
    page repeats), ``total_drift`` reports a wrong total, ``ignore_page`` serves the first
    page for every page number.
    """
    items = [{"id": index + 1} for index in range(count)]

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] != "GET" or request["path"] != "/items":
            return None
        page = 1 if ignore_page else int(request["query"]["page"])
        size = int(request["query"]["pageSize"])
        start = (page - 1) * size - (1 if overlap and page > 1 else 0)
        return {"status": 200, "body": {"items": items[start:start + size], "total": count + total_drift}}

    return handler


def cursor_stub(count: int, fault: str | None = None) -> StubHandler:
    """GET /feed?cursor=&pageSize= over ``count`` items; the cursor is an offset.

    Faults: ``unstable`` drops item 7 from the second walk, ``cycle`` points back to offset 5
    once the offset reaches 10.
    """
    items = [{"id": index + 1} for index in range(count)]
    walks = {"count": 0}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] != "GET" or request["path"] != "/feed":
            return None
        cursor = request["query"].get("cursor")
        offset = int(cursor) if isinstance(cursor, str) else 0
        size = int(request["query"]["pageSize"])
        if offset == 0:
            walks["count"] += 1
        source = [item for item in items if item["id"] != 7] if fault == "unstable" and walks["count"] == 2 else items
        next_cursor = str(offset + size) if offset + size < len(source) else None
        if fault == "cycle" and offset >= 10:
            next_cursor = "5"
        return {"status": 200, "body": {"items": source[offset:offset + size], "nextCursor": next_cursor}}

    return handler


def pages(http: httpx.Client, stub: StubServer) -> Callable[[PageRequest], Any]:
    return lambda request: http.get(f"{stub.url}/items", params={"page": request.page or 1, "pageSize": request.page_size}).json()


def feed(http: httpx.Client, stub: StubServer) -> Callable[[PageRequest], Any]:
    def fetch(request: PageRequest) -> Any:
        params: dict[str, Any] = {"pageSize": request.page_size}
        if request.cursor is not None:
            params["cursor"] = request.cursor
        return http.get(f"{stub.url}/feed", params=params).json()

    return fetch


def item_id(item: dict[str, Any]) -> Any:
    return item["id"]


def auth_stub(fault: str | None = None) -> StubHandler:
    """POST /register and POST /login; a correct service keys email case-insensitively and compares passwords byte for byte."""
    accounts: dict[str, str] = {}

    def email_key(email: str) -> str:
        return email if fault == "case-sensitive-email" else email.lower()

    def password(value: str, side: str) -> str:
        return value.strip() if fault in (f"trim-{side}", "trim-both") else value

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        body = request["body"]
        if request["method"] == "POST" and request["path"] == "/register":
            if email_key(body["email"]) in accounts:
                return {"status": 409, "body": {"error": "exists"}}
            accounts[email_key(body["email"])] = password(body["password"], "register")
            return {"status": 201, "body": {}}
        if request["method"] == "POST" and request["path"] == "/login":
            stored = accounts.get(email_key(body["email"]))
            given = password(body["password"], "login")
            if fault == "case-insensitive-password":
                matches = stored is not None and stored.lower() == given.lower()
            else:
                matches = stored == given
            return {"status": 200 if stored is not None and matches else 401, "body": {}}
        return None

    return handler


def account_calls(http: httpx.Client, stub: StubServer) -> dict[str, Callable[[Credentials], bool]]:
    return {
        "register": lambda credentials: http.post(f"{stub.url}/register", json=credentials).status_code == 201,
        "login": lambda credentials: http.post(f"{stub.url}/login", json=credentials).status_code == 200,
    }


def profile_stub(store: Callable[[str], str | None]) -> StubHandler:
    """PUT /profile stores ``store(name)`` (None refuses with 400); GET /profile reads it back."""
    state = {"name": ""}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["path"] != "/profile":
            return None
        if request["method"] == "GET":
            return {"status": 200, "body": {"name": state["name"]}}
        if request["method"] != "PUT":
            return None
        stored = store(request["body"]["name"])
        if stored is None:
            return {"status": 400, "body": {"error": "invalid name"}}
        state["name"] = stored
        return {"status": 200, "body": {}}

    return handler


def profile_calls(http: httpx.Client, stub: StubServer) -> dict[str, Callable[..., Any]]:
    return {
        "submit": lambda value: http.put(f"{stub.url}/profile", json={"name": value}).status_code == 200,
        "read_back": lambda: http.get(f"{stub.url}/profile").json()["name"],
    }


def within_limit(value: str) -> bool:
    return len(value) <= PROFILE_MAX_LENGTH


# --- Partitions ---------------------------------------------------------------------------


def test_partitions_email_field_yields_the_email_labels_then_the_string_labels() -> None:
    assert invalid_partitions({"type": "string", "format": "email", "maxLength": 64}) == [
        Partition("email.missing-at", "argus.qa.example.com"),
        Partition("email.missing-domain", "argus.qa@"),
        Partition("email.missing-local-part", "@example.com"),
        Partition("email.double-at", "argus.qa@@example.com"),
        Partition("email.embedded-whitespace", "argus qa@example.com"),
        Partition("string.above-max-length", "a" * 65),
        Partition("type.number-for-string", 1),
        Partition("type.null-for-non-nullable", None),
    ]
    assert [email.label for email in INVALID_EMAILS] == labels(invalid_partitions({"type": "string", "format": "email"}))[:5]


def test_partitions_string_length_and_pattern_constraints_in_order() -> None:
    assert invalid_partitions({"type": "string", "minLength": 2, "maxLength": 5, "pattern": "^[a-z]+$"}) == [
        Partition("string.below-min-length", "a"),
        Partition("string.above-max-length", "aaaaaa"),
        Partition("string.pattern-mismatch", ""),
        Partition("string.empty", ""),
        Partition("type.number-for-string", 1),
        Partition("type.null-for-non-nullable", None),
    ]

    # The first candidate the pattern rejects wins; a pattern that accepts all of them has no mismatch.
    def mismatch(pattern: str) -> Any:
        return value_of(invalid_partitions({"type": "string", "pattern": pattern}), "string.pattern-mismatch")

    assert mismatch("^[a-z]*$") == " "
    assert mismatch("^[^0-9]*$") == "0"
    assert mismatch(".*") is None
    assert invalid_partitions({"type": "string", "minLength": 1})[:2] == [
        Partition("string.below-min-length", ""),
        Partition("string.empty", ""),
    ]
    assert labels(invalid_partitions({"type": "string", "minLength": 0})) == ["type.number-for-string", "type.null-for-non-nullable"]


def test_partitions_integer_bounds_fractional_unsafe_and_multiple_of_values() -> None:
    assert invalid_partitions({"type": "integer", "minimum": 1, "maximum": 10}) == [
        Partition("number.below-minimum", 0),
        Partition("number.above-maximum", 11),
        Partition("number.fractional-for-integer", 1.5),
        Partition("type.string-for-number", "1"),
        Partition("type.null-for-non-nullable", None),
    ]
    assert invalid_partitions({"type": "integer", "minimum": 0}) == [
        Partition("number.below-minimum", -1),
        Partition("number.fractional-for-integer", 0.5),
        Partition("number.unsafe-integer", 2**53),
        Partition("type.string-for-number", "0"),
        Partition("type.null-for-non-nullable", None),
    ]
    # An integer multipleOf is the step, so every value breaks exactly one constraint.
    assert invalid_partitions({"type": "integer", "minimum": 10, "maximum": 50, "multipleOf": 5}) == [
        Partition("number.below-minimum", 5),
        Partition("number.above-maximum", 55),
        Partition("number.fractional-for-integer", 10.5),
        Partition("number.multiple-of-violation", 11),
        Partition("type.string-for-number", "10"),
        Partition("type.null-for-non-nullable", None),
    ]
    assert labels(invalid_partitions({"type": "integer", "enum": [1, 2, 3]})) == [
        "number.fractional-for-integer",
        "number.unsafe-integer",
        "type.string-for-number",
        "enum.out-of-enum",
        "type.null-for-non-nullable",
    ]
    assert value_of(invalid_partitions({"type": "integer", "enum": [1, 2, 3]}), "enum.out-of-enum") == 4
    # Integral values are ints and fractional ones floats, so a JSON body carries 0, not 0.0.
    values = {partition.label: partition.value for partition in invalid_partitions({"type": "integer", "minimum": 1, "maximum": 10})}
    assert type(values["number.below-minimum"]) is int and type(values["number.fractional-for-integer"]) is float


def test_partitions_number_steps_come_from_multiple_of_or_number_step_never_a_blind_plus_minus_one() -> None:
    assert invalid_partitions({"type": "number", "minimum": 0, "maximum": 100, "multipleOf": 0.01}) == [
        Partition("number.below-minimum", -0.01),
        Partition("number.above-maximum", 100.01),
        Partition("number.multiple-of-violation", 0.005),
        Partition("type.string-for-number", "0"),
        Partition("type.null-for-non-nullable", None),
    ]
    assert invalid_partitions({"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1}, number_step=0.1) == [
        Partition("number.exclusive-minimum-equal", 0),
        Partition("number.exclusive-maximum-equal", 1),
        Partition("type.string-for-number", "0.1"),
        Partition("type.null-for-non-nullable", None),
    ]
    # Exact cents where floating point drifts: 0.07 - 0.01 is 0.060000000000000005.
    assert invalid_partitions({"type": "number", "minimum": 0.07, "maximum": 0.7}, number_step=0.01)[:2] == [
        Partition("number.below-minimum", 0.06),
        Partition("number.above-maximum", 0.71),
    ]
    assert invalid_partitions({"type": "number", "minimum": Decimal("0.07")}, number_step=Decimal("0.01"))[0] == Partition("number.below-minimum", 0.06)
    # OpenAPI 3.0: a boolean exclusiveMinimum and nullable read the same as the 3.1 forms.
    assert invalid_partitions({"type": "number", "minimum": 0, "exclusiveMinimum": True, "maximum": 5, "nullable": True}, number_step=0.5) == [
        Partition("number.above-maximum", 5.5),
        Partition("number.exclusive-minimum-equal", 0),
        Partition("type.string-for-number", "0.5"),
    ]
    with pytest.raises(TypeError, match="number_step.*never a blind"):
        invalid_partitions({"type": "number", "minimum": 0})
    with pytest.raises(TypeError, match="number_step"):
        invalid_partitions({"type": "number", "maximum": 1}, number_step=0)
    # An unbounded number needs no step.
    assert invalid_partitions({"type": "number"}) == [
        Partition("type.string-for-number", "0"),
        Partition("type.null-for-non-nullable", None),
    ]


def test_partitions_enum_boolean_nullable_and_usage_errors() -> None:
    assert invalid_partitions({"type": "string", "enum": ["red", "blue"]}) == [
        Partition("type.number-for-string", 1),
        Partition("enum.out-of-enum", "argus-out-of-enum"),
        Partition("type.null-for-non-nullable", None),
    ]
    assert invalid_partitions({"type": "boolean"}) == [
        Partition("type.string-for-boolean", "true"),
        Partition("type.null-for-non-nullable", None),
    ]
    assert value_of(invalid_partitions({"type": "boolean", "enum": [True]}), "enum.out-of-enum") is False
    # True is not 1 (JSON has no boolean-integer equality), so 1 is outside this enum.
    assert value_of(invalid_partitions({"type": "integer", "enum": [0, True]}), "enum.out-of-enum") == 1
    assert labels(invalid_partitions({"type": ["string", "null"], "maxLength": 2})) == ["string.above-max-length", "type.number-for-string"]
    assert labels(invalid_partitions({"enum": ["a", None]})) == ["enum.out-of-enum"]
    assert invalid_partitions({}) == []
    with pytest.raises(TypeError, match=r"resolve \$ref"):
        invalid_partitions({"$ref": "#/components/schemas/Order"})
    with pytest.raises(TypeError, match="one field type"):
        invalid_partitions({"type": ["string", "integer"]})
    with pytest.raises(TypeError, match="not a valid regular expression"):
        invalid_partitions({"type": "string", "pattern": "("})
    with pytest.raises(TypeError, match="minLength"):
        invalid_partitions({"type": "string", "minLength": -1})
    with pytest.raises(TypeError, match="unsupported type"):
        invalid_partitions({"type": "file"})
    with pytest.raises(TypeError, match="minimum must be a finite number"):
        invalid_partitions({"type": "integer", "minimum": True})


def test_partitions_every_value_violates_its_schema_and_a_valid_value_does_not() -> None:
    cases: list[tuple[dict[str, Any], Any, float | None]] = [
        ({"type": "string", "format": "email", "minLength": 6, "maxLength": 64}, valid_email(1), None),
        ({"type": "string", "minLength": 2, "maxLength": 5, "pattern": "^[a-z]+$"}, "abc", None),
        ({"type": "integer", "minimum": 1, "maximum": 10}, 5, None),
        ({"type": "integer", "minimum": 10, "maximum": 50, "multipleOf": 5}, 25, None),
        ({"type": "integer", "minimum": 0}, 3, None),
        ({"type": "number", "minimum": 0, "maximum": 100, "multipleOf": 0.01}, 19.99, None),
        ({"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1}, 0.5, 0.1),
        ({"type": "number", "minimum": 0.07, "maximum": 0.7}, 0.5, 0.01),
        ({"type": "string", "enum": ["red", "blue"]}, "red", None),
        ({"type": "boolean"}, True, None),
    ]
    for schema, valid, number_step in cases:
        check = validator(schema)
        assert check.is_valid(valid), f"the valid example of {json.dumps(schema)}"
        partitions = invalid_partitions(schema, number_step=number_step)
        assert partitions
        for partition in partitions:
            # 2**53 is a valid JSON Schema integer: number.unsafe-integer probes precision loss, not the schema.
            if partition.label == "number.unsafe-integer":
                continue
            assert not check.is_valid(partition.value), f"{partition.label} must violate {json.dumps(schema)}"


def test_object_partitions_labels_in_schema_order_each_a_fresh_copy() -> None:
    partitions = invalid_object_partitions(ORDER_SCHEMA, VALID_ORDER)
    assert labels(partitions) == [
        "object.missing-required.sku",
        "object.missing-required.qty",
        "object.extra-field",
        "object.null-body",
        "object.wrong-type-body",
        "field.sku.string.below-min-length",
        "field.sku.string.above-max-length",
        "field.sku.string.pattern-mismatch",
        "field.sku.string.empty",
        "field.sku.type.number-for-string",
        "field.sku.type.null-for-non-nullable",
        "field.qty.number.below-minimum",
        "field.qty.number.above-maximum",
        "field.qty.number.fractional-for-integer",
        "field.qty.type.string-for-number",
        "field.qty.type.null-for-non-nullable",
        "field.note.string.above-max-length",
        "field.note.type.number-for-string",
    ]
    assert value_of(partitions, "object.missing-required.sku") == {"qty": 2, "note": None}
    assert value_of(partitions, "object.extra-field") == {**VALID_ORDER, "argusUndocumentedField": "argus"}
    assert value_of(partitions, "object.null-body") is None
    assert value_of(partitions, "object.wrong-type-body") == [VALID_ORDER]
    assert value_of(partitions, "field.qty.number.above-maximum") == {"sku": "SKU-1", "qty": 100, "note": None}
    assert value_of(partitions, "field.sku.type.null-for-non-nullable") == {"sku": None, "qty": 2, "note": None}
    assert VALID_ORDER == {"sku": "SKU-1", "qty": 2, "note": None}
    assert len({id(partition.value) for partition in partitions}) == len(partitions)
    # A schema that allows extra fields has no extra-field partition.
    assert "object.extra-field" not in labels(invalid_object_partitions({**ORDER_SCHEMA, "additionalProperties": True}, VALID_ORDER))
    priced = {"type": "object", "properties": {"price": {"type": "number", "minimum": 0}}}
    with pytest.raises(TypeError, match="property price: .*number_step"):
        invalid_object_partitions(priced, {"price": 1})
    assert "field.price.number.below-minimum" in labels(invalid_object_partitions(priced, {"price": 1}, number_steps={"price": 0.01}))
    with pytest.raises(TypeError, match="lacks the required field sku"):
        invalid_object_partitions(ORDER_SCHEMA, {"qty": 2})
    with pytest.raises(TypeError, match=r"property owner: resolve \$ref"):
        invalid_object_partitions({"type": "object", "properties": {"owner": {"$ref": "#/components/schemas/User"}}}, {})
    with pytest.raises(TypeError, match="must describe an object"):
        invalid_object_partitions({"type": "string"}, {})


def test_object_partitions_correct_endpoint_rejects_all_of_them_faulty_one_is_red(http: httpx.Client) -> None:
    partitions = invalid_object_partitions(ORDER_SCHEMA, VALID_ORDER)
    with running_stub(order_endpoint(ORDER_SCHEMA)) as stub:
        expect_status(post_json(http, f"{stub.url}/orders", VALID_ORDER), 201)
        for partition in partitions:
            expect_status(post_json(http, f"{stub.url}/orders", partition.value), 400)
        # object.null-body (request 4 after the valid order) is a 4-byte JSON null, not an empty body.
        null_body = stub.requests()[4]
        assert null_body["body"] is None and null_body["headers"]["content-length"] == "4"
    # The faulty endpoint forgot the sku maxLength and the qty maximum.
    lenient = copy.deepcopy(ORDER_SCHEMA)
    del lenient["properties"]["sku"]["maxLength"]
    del lenient["properties"]["qty"]["maximum"]
    with running_stub(order_endpoint(lenient)) as stub:
        accepted = [
            partition.label for partition in partitions if post_json(http, f"{stub.url}/orders", partition.value).status_code != 400
        ]
        assert accepted == ["field.sku.string.above-max-length", "field.qty.number.above-maximum"]
        over_limit = value_of(partitions, "field.qty.number.above-maximum")
        with pytest.raises(AssertionError, match="expected HTTP 400, got 201"):
            expect_status(post_json(http, f"{stub.url}/orders", over_limit), 400)


# --- Pagination ---------------------------------------------------------------------------


def test_pagination_conserving_page_walk_is_green(http: httpx.Client) -> None:
    with running_stub(page_stub(24)) as stub:
        result = paginate_all(fetch_page=pages(http, stub), mode="page", page_size=5, id_of=item_id)
        assert result == PaginationResult(
            ids=list(range(1, 25)),
            total=24,
            duplicates=[],
            missing=[],
            pages=5,
            consistent=True,
            anomalies=[],
        )
        assert_collection_conservation(result)
        assert len(stub.requests()) == 10
    # An exact multiple of the page size ends on an empty page.
    with running_stub(page_stub(20)) as stub:
        result = paginate_all(fetch_page=pages(http, stub), mode="page", page_size=5, id_of=item_id)
        assert result.pages == 5
        assert_collection_conservation(result)


def test_pagination_page_boundary_that_repeats_an_item_is_red(http: httpx.Client) -> None:
    with running_stub(page_stub(23, overlap=True)) as stub:
        result = paginate_all(fetch_page=pages(http, stub), mode="page", page_size=5, id_of=item_id)
        assert result.duplicates == [5]
        with pytest.raises(AssertionError, match=r"1 id\(s\) served more than once: 5"):
            assert_collection_conservation(result)


def test_pagination_total_that_drifts_from_the_items_is_red(http: httpx.Client) -> None:
    with running_stub(page_stub(23, total_drift=1)) as stub:
        result = paginate_all(fetch_page=pages(http, stub), mode="page", page_size=5, id_of=item_id)
        assert result.duplicates == []
        with pytest.raises(AssertionError, match="total 24 reported, 23 distinct ids served"):
            assert_collection_conservation(result)


def test_pagination_ignored_page_parameter_stops_at_max_pages_and_is_red(http: httpx.Client) -> None:
    with running_stub(page_stub(23, ignore_page=True)) as stub:
        result = paginate_all(fetch_page=pages(http, stub), mode="page", page_size=5, id_of=item_id, max_pages=4)
        assert result.pages == 4
        assert result.consistent is False
        with pytest.raises(AssertionError, match="did not end within max_pages=4"):
            assert_collection_conservation(result)


def test_pagination_stable_cursor_walk_is_green(http: httpx.Client) -> None:
    with running_stub(cursor_stub(12)) as stub:
        result = paginate_all(fetch_page=feed(http, stub), mode="cursor", page_size=5, id_of=item_id)
        assert result.ids == list(range(1, 13))
        assert result.total is None
        assert result.pages == 3
        assert_collection_conservation(result)
    # A PageResult with next_cursor walks the same way as a decoded JSON page.
    source = [{"id": f"item-{index}"} for index in range(7)]

    def in_memory(request: PageRequest) -> PageResult[dict[str, str]]:
        offset = int(request.cursor or 0)
        following = offset + request.page_size
        return PageResult(items=source[offset:following], total=7, next_cursor=str(following) if following < len(source) else None)

    result = paginate_all(fetch_page=in_memory, mode="cursor", page_size=3, id_of=item_id)
    assert result.ids == [item["id"] for item in source] and result.pages == 3
    assert_collection_conservation(result)


def test_pagination_unstable_or_looping_cursor_walk_is_red(http: httpx.Client) -> None:
    with running_stub(cursor_stub(12, "unstable")) as stub:
        result = paginate_all(fetch_page=feed(http, stub), mode="cursor", page_size=5, id_of=item_id)
        assert result.missing == [7]
        with pytest.raises(AssertionError, match="served in one walk only: 7"):
            assert_collection_conservation(result)
    with running_stub(cursor_stub(20, "cycle")) as stub:
        result = paginate_all(fetch_page=feed(http, stub), mode="cursor", page_size=5, id_of=item_id)
        assert result.pages == 3
        with pytest.raises(AssertionError, match="repeated an earlier cursor"):
            assert_collection_conservation(result)


def test_pagination_usage_errors_raise_type_error() -> None:
    def fetch_page(_request: PageRequest) -> dict[str, Any]:
        return {"items": [{"id": 1}]}

    with pytest.raises(TypeError, match="mode"):
        paginate_all(fetch_page=fetch_page, mode="offset", page_size=5, id_of=item_id)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="page_size"):
        paginate_all(fetch_page=fetch_page, mode="page", page_size=0, id_of=item_id)
    with pytest.raises(TypeError, match="id_of"):
        paginate_all(fetch_page=fetch_page, mode="page", page_size=5, id_of=lambda item: {"id": item["id"]})
    with pytest.raises(TypeError, match="id_of"):
        paginate_all(fetch_page=fetch_page, mode="page", page_size=5, id_of=lambda item: True)
    with pytest.raises(TypeError, match="fetch_page"):
        paginate_all(fetch_page=lambda _request: {"rows": []}, mode="page", page_size=5, id_of=item_id)
    with pytest.raises(TypeError):
        assert_collection_conservation({})  # type: ignore[arg-type]


# --- Boundary and exact sums --------------------------------------------------------------


def test_boundary3_exact_validator_is_green_at_both_edges_of_a_range() -> None:
    def accepts(value: Any) -> bool:
        return 1 <= value <= 10

    upper = boundary3(boundary=10, step=1, probe=accepts, accept_below=True, accept_at=True, accept_above=False)
    assert [upper.below.value, upper.at.value, upper.above.value] == [9, 10, 11]
    assert dataclasses.asdict(upper.above) == {"value": 11, "expected": "rejected", "actual": "rejected"}
    boundary3(boundary=1, step=1, probe=accepts, accept_below=False, accept_at=True, accept_above=True)


def test_boundary3_off_by_one_validator_is_red() -> None:
    with pytest.raises(AssertionError, match="value 10 expected accepted, got rejected"):
        boundary3(boundary=10, step=1, probe=lambda value: 1 <= value < 10, accept_below=True, accept_at=True, accept_above=False)
    with pytest.raises(AssertionError, match="value 11 expected rejected, got accepted"):
        boundary3(boundary=10, step=1, probe=lambda value: value >= 1, accept_below=True, accept_at=True, accept_above=False)


def test_boundary3_money_step_probes_exact_cents_and_a_bad_step_raises() -> None:
    probed: list[Any] = []

    def probe(value: Any) -> bool:
        probed.append(value)
        return value <= 0.07

    boundary3(boundary=0.07, step=0.01, probe=probe, accept_below=True, accept_at=True, accept_above=False)
    assert probed == [0.06, 0.07, 0.08]
    # The floating-point path this avoids.
    assert 0.07 - 0.01 != 0.06
    # Decimal inputs probe Decimal values.
    decimals = boundary3(boundary=Decimal("0.07"), step=Decimal("0.01"), probe=lambda value: value <= Decimal("0.07"), accept_below=True, accept_at=True, accept_above=False)
    assert decimals.below.value == Decimal("0.06") and isinstance(decimals.below.value, Decimal)
    for step in (0, -0.01, float("nan")):
        with pytest.raises(TypeError, match="step"):
            boundary3(boundary=1, step=step, probe=probe, accept_below=True, accept_at=True, accept_above=False)
    with pytest.raises(TypeError, match="probe must return"):
        boundary3(boundary=1, step=1, probe=lambda value: "yes", accept_below=True, accept_at=True, accept_above=False)  # type: ignore[arg-type,return-value]
    with pytest.raises(TypeError, match="accept_at"):
        boundary3(boundary=1, step=1, probe=probe, accept_below=True, accept_at=None, accept_above=False)  # type: ignore[arg-type]


def test_money_reconciles_exact_minor_units_are_green_penny_drift_is_red() -> None:
    assert money_reconciles(["0.07", "0.01"], "0.08") == MoneyReconciliation(sum="0.08", total="0.08")
    assert money_reconciles([19.99, 0.01, "-5.00"], "15") == MoneyReconciliation(sum="15.00", total="15.00")
    assert money_reconciles([Decimal("19.99"), Decimal("0.01")], Decimal("20")) == MoneyReconciliation(sum="20.00", total="20.00")
    assert money_reconciles(["100", "250"], "350", minor_units=0) == MoneyReconciliation(sum="350", total="350")
    assert money_reconciles(["1.500"], "1.50") == MoneyReconciliation(sum="1.50", total="1.50")
    with pytest.raises(AssertionError, match=r"the parts sum to 99\.99, the total is 100\.00 \(difference -0\.01\)"):
        money_reconciles(["33.33", "33.33", "33.33"], "100.00")
    # Floating-point money surfaces as sub-cent precision.
    with pytest.raises(AssertionError, match="more than 2 decimal places"):
        money_reconciles([0.1 + 0.2], "0.30")
    with pytest.raises(AssertionError, match="not a plain decimal"):
        money_reconciles(["12,50"], "12.50")
    with pytest.raises(TypeError):
        money_reconciles(["1"], "1", minor_units=-1)
    with pytest.raises(TypeError):
        money_reconciles("1", "1")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        money_reconciles([{"amount": 1}], "1")  # type: ignore[list-item]
    with pytest.raises(TypeError):
        money_reconciles([True], "1")  # type: ignore[list-item]


def test_percentages_sum_to_100_exact_breakdown_is_green_rounded_one_is_red() -> None:
    assert percentages_sum_to_100([33.33, 33.33, 33.34], decimals=2) == "100.00"
    assert percentages_sum_to_100(["50", "50"]) == "100"
    with pytest.raises(AssertionError, match=r"sum to 99\.99, not exactly 100"):
        percentages_sum_to_100([33.33, 33.33, 33.33], decimals=2)
    with pytest.raises(AssertionError, match="more than 0 decimal places"):
        percentages_sum_to_100([33.3, 33.3, 33.4])
    with pytest.raises(TypeError):
        percentages_sum_to_100([])


# --- Identity -----------------------------------------------------------------------------


def test_identity_vectors_carry_the_exact_code_points() -> None:
    assert code_points(IDENTITY_VECTORS.diacritics[0]) == [0x17B, 0xF3, 0x142, 0x107, 0x20, 0x104, 0x107, 0x119, 0x142, 0x144]
    assert code_points(IDENTITY_VECTORS.diacritics[1]) == [0x5A, 0x6F, 0xEB, 0x20, 0x53, 0x61, 0x6C, 0x64, 0x61, 0xF1, 0x61]
    edge = IDENTITY_VECTORS.unicode_edge
    assert code_points(edge.nfc) == [0xE9]
    assert code_points(edge.nfd) == [0x65, 0x301]
    assert edge.combining == edge.nfd
    assert unicodedata.normalize("NFC", edge.nfd) == edge.nfc
    assert code_points(edge.rtl) == [0x202E, 0x61, 0x62, 0x63]
    assert code_points(edge.zero_width) == [0x61, 0x200B, 0x62]
    assert all(point > 0xFFFF for point in code_points(edge.emoji))
    assert len(edge.overlong) == 1025
    assert dataclasses.asdict(IDENTITY_VECTORS.whitespace) == {
        "leading": " Argus",
        "trailing": "Argus ",
        "internal": "Argus QA",
        "tab": "Argus\tQA",
        "space_only": "   ",
    }
    assert IDENTITY_VECTORS.special == "!@#$%^&*()\"'<>"
    assert isinstance(IDENTITY_VECTORS.diacritics, tuple) and isinstance(INVALID_EMAILS, tuple)
    for frozen, field_name in ((IDENTITY_VECTORS, "special"), (edge, "nfd"), (INVALID_EMAILS[0], "value")):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(frozen, field_name, "x")
    assert len(INVALID_EMAILS) == 5
    assert valid_email(7) == "argus.qa+7@example.com"
    assert valid_email("run-42") == "argus.qa+run-42@example.com"
    for bad in (-1, "Run 1", True, "run-1\n"):
        with pytest.raises(TypeError):
            valid_email(bad)  # type: ignore[arg-type]
    assert case_variants("Argus QA+1@Example.com") == ("argus qa+1@example.com", "ARGUS QA+1@EXAMPLE.COM", "ArGuS qA+1@eXaMpLe.CoM")


def test_credential_consistency_byte_exact_account_service_is_green(http: httpx.Client) -> None:
    with running_stub(auth_stub()) as stub:
        report = credential_consistency(**account_calls(http, stub))
        assert re.fullmatch(r"argus\.qa\+[1-9][0-9]*@example\.com", report.email)
        assert report.checks == (
            CredentialCheck("byte-identical", "accepted", "accepted"),
            CredentialCheck("case-variant-email", "accepted", "accepted"),
            CredentialCheck("case-variant-password", "rejected", "rejected"),
            CredentialCheck("trailing-space-password", "rejected", "rejected"),
        )
        registered = stub.requests()[0]["body"]
        assert registered["password"].endswith(" ")
        assert {0x17B, 0xF3, 0x142, 0x107} <= set(code_points(registered["password"]))


def test_credential_consistency_trimming_on_one_side_only_is_red(http: httpx.Client) -> None:
    for fault in ("trim-register", "trim-login"):
        with running_stub(auth_stub(fault)) as stub:
            with pytest.raises(AssertionError) as caught:
                credential_consistency(**account_calls(http, stub))
            assert "byte-identical login expected accepted, got rejected" in str(caught.value), fault
            assert "Qa7" not in str(caught.value)


def test_credential_consistency_silent_trimming_case_folded_passwords_and_case_sensitive_emails_are_red(http: httpx.Client) -> None:
    cases = [
        ("trim-both", "trailing-space-password login expected rejected, got accepted"),
        ("case-insensitive-password", "case-variant-password login expected rejected, got accepted"),
        ("case-sensitive-email", "case-variant-email login expected accepted, got rejected"),
    ]
    for fault, message in cases:
        with running_stub(auth_stub(fault)) as stub:
            with pytest.raises(AssertionError, match=message):
                credential_consistency(**account_calls(http, stub))
    # A documented case-sensitive email contract turns the same service GREEN.
    with running_stub(auth_stub("case-sensitive-email")) as stub:
        credential_consistency(**account_calls(http, stub), email_case_insensitive=False)


def test_credential_consistency_usage_errors_raise_type_error() -> None:
    def ok(_credentials: Credentials) -> bool:
        return True

    with pytest.raises(TypeError, match="no cased letter"):
        credential_consistency(register=ok, login=ok, password="12345678")
    with pytest.raises(TypeError, match="register must return"):
        credential_consistency(register=lambda _credentials: 201, login=ok)  # type: ignore[arg-type,return-value]
    with pytest.raises(TypeError, match="email_case_insensitive"):
        credential_consistency(register=ok, login=ok, email_case_insensitive="yes")  # type: ignore[arg-type]


# --- i18n ---------------------------------------------------------------------------------


def test_i18n_charset_character_exact_store_is_green(http: httpx.Client) -> None:
    assert [vector.label for vector in I18N_VECTORS] == ["diacritics.0", "diacritics.1", "emoji", "nfd"]
    with running_stub(profile_stub(lambda value: value if within_limit(value) else None)) as stub:
        checked = i18n_charset(**profile_calls(http, stub), max_length=PROFILE_MAX_LENGTH)
        assert checked == ["diacritics.0", "diacritics.1", "emoji", "nfd", "max-length.20", "max-length.21"]
        i18n_charset(**profile_calls(http, stub))


def test_i18n_charset_byte_truncating_store_is_red(http: httpx.Client) -> None:
    # A column sized in bytes: the value keeps its first PROFILE_MAX_LENGTH UTF-8 bytes.
    def truncate(value: str) -> str | None:
        return value.encode("utf-8")[:PROFILE_MAX_LENGTH].decode("utf-8", errors="replace") if within_limit(value) else None

    with running_stub(profile_stub(truncate)) as stub:
        with pytest.raises(AssertionError, match=r"max-length\.20: sent 20 code points \(40 UTF-8 bytes\): U\+017C .*read back 10 code points"):
            i18n_charset(**profile_calls(http, stub), max_length=PROFILE_MAX_LENGTH)


def test_i18n_charset_normalization_stripped_emoji_and_byte_counted_limits_are_red(http: httpx.Client) -> None:
    faults: list[tuple[Callable[[str], str | None], str]] = [
        (
            lambda value: unicodedata.normalize("NFC", value) if within_limit(value) else None,
            r"nfd: sent 2 code points \(3 UTF-8 bytes\): U\+0065 U\+0301, read back 1 code points",
        ),
        (lambda value: re.sub("[\U00010000-\U0010ffff]", "", value) if within_limit(value) else None, "emoji: sent 3 code points"),
        (
            lambda value: value if len(value.encode("utf-8")) <= PROFILE_MAX_LENGTH else None,
            r"max-length\.20: refused 20 code points \(40 UTF-8 bytes\)",
        ),
        (lambda value: value, r"accepted max_length \+ 1 = 21 characters"),
    ]
    for store, message in faults:
        with running_stub(profile_stub(store)) as stub:
            with pytest.raises(AssertionError, match=message):
                i18n_charset(**profile_calls(http, stub), max_length=PROFILE_MAX_LENGTH)


def test_i18n_charset_usage_errors_raise_type_error() -> None:
    def submit(_value: str) -> bool:
        return True

    def read_back() -> str:
        return ""

    with pytest.raises(TypeError, match="max_length"):
        i18n_charset(submit=submit, read_back=read_back, max_length=0)
    with pytest.raises(TypeError, match="submit must return"):
        i18n_charset(submit=lambda _value: 200, read_back=read_back)  # type: ignore[arg-type,return-value]
    with pytest.raises(TypeError, match="read_back must return"):
        i18n_charset(submit=submit, read_back=lambda: 42)  # type: ignore[arg-type,return-value]


def test_email_partitions_do_not_require_a_dotted_domain() -> None:
    assert Address(addr_spec="argus.qa@example").domain == "example"
    for partition in INVALID_EMAILS:
        try:
            mailbox = Address(addr_spec=partition.value)
            accepted = bool(mailbox.username and mailbox.domain)
        except (ValueError, HeaderParseError):
            accepted = False
        assert not accepted, partition.label
