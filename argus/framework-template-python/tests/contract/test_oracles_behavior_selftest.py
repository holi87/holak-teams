"""Self-tests for the behaviour oracles (state, concurrency, visual, scaling).

Every helper passes on a correct implementation and fails on a faulty one. evaluate_bounds
and analyze_scaling are pure and get plain values; the others run against a 127.0.0.1 stub on
an ephemeral port that lives for one test, and visual_bounds against a recording stand-in for
a Playwright Locator, so no browser starts and no real target is contacted. Negative cases
assert the rejection itself, so a healthy run reports `product pass` for every case. The
cases mirror the TypeScript behaviour oracle self-tests.
"""
from __future__ import annotations

import dataclasses
import re
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import httpx
import pytest

from qa.argus.stub_server import StubHandler, StubServer
from qa.oracles import (
    BoundsMeasurement,
    BoundsRect,
    DoubleSubmitResult,
    RaceResult,
    ScalingPoint,
    ScalingSample,
    SoftDeleteResult,
    Viewport,
    analyze_scaling,
    concurrent_race,
    double_submit,
    evaluate_bounds,
    n1_scaling,
    soft_delete_sweep,
    valid_email,
    visual_bounds,
)

pytestmark = pytest.mark.contract_smoke

USER_EMAIL = valid_email(7)
USER_PASSWORD = "argus-correct-password"
SIZES = [10, 100, 1000]
PAGE_SIZE = 10
# How long a faulty stub waits between its check and its act: every contender released by the
# start gate arrives well inside this window.
RACE_WINDOW_SECONDS = 0.1
# A 375 px phone viewport and a button that fits inside it.
FITS = BoundsMeasurement(
    rect=BoundsRect(x=16, y=120, width=343, height=48),
    viewport=Viewport(width=375, height=812),
    scroll_width=343,
    client_width=343,
    top_element_is_self=True,
)


@pytest.fixture
def http() -> Iterator[httpx.Client]:
    # trust_env=False: a host proxy setting must never route loopback traffic elsewhere. One
    # client serves every concurrent call: httpx.Client is thread-safe.
    with httpx.Client(timeout=10.0, trust_env=False) as client:
        yield client


@contextmanager
def running_stub(handler: StubHandler) -> Iterator[StubServer]:
    stub = StubServer.start(handler)
    try:
        yield stub
    finally:
        stub.stop()


def user_stub(fault: str | None = None) -> StubHandler:
    """Users 7 and 8 behind DELETE and GET /users/<id>, GET /users, GET /users/export, and POST /login.

    A correct service removes a deleted user from every read path and refuses its login.
    Faults: ``listed`` keeps the deleted user in the export, ``readable`` still serves it by
    id, ``login`` still accepts its credentials, ``delete-200`` answers the delete with 200
    and a body.
    """
    users = {user_id: {"id": user_id, "email": valid_email(user_id), "deleted": False} for user_id in (7, 8)}

    def visible(include_deleted: bool) -> dict[str, Any]:
        items = [{"id": user["id"], "email": user["email"]} for user in users.values() if include_deleted or not user["deleted"]]
        return {"status": 200, "body": {"items": items}}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        by_id = re.fullmatch(r"/users/(\d+)", request["path"])
        if by_id:
            user = users.get(int(by_id.group(1)))
            if request["method"] == "DELETE":
                if user is None or user["deleted"]:
                    return {"status": 404, "body": {"error": "not found"}}
                user["deleted"] = True
                return {"status": 200, "body": {"deleted": True}} if fault == "delete-200" else {"status": 204}
            if request["method"] == "GET":
                if user is not None and (not user["deleted"] or fault == "readable"):
                    return {"status": 200, "body": {"id": user["id"], "email": user["email"]}}
                return {"status": 404, "body": {"error": "not found"}}
        if request["method"] == "GET" and request["path"] == "/users":
            return visible(False)
        if request["method"] == "GET" and request["path"] == "/users/export":
            return visible(fault == "listed")
        if request["method"] == "POST" and request["path"] == "/login":
            email = (request["body"] or {}).get("email")
            user = next((candidate for candidate in users.values() if candidate["email"] == email), None)
            if user is not None and (not user["deleted"] or fault == "login"):
                return {"status": 200, "body": {}}
            return {"status": 401, "body": {"error": "invalid credentials"}}
        return None

    return handler


def sweep_user(http: httpx.Client, stub: StubServer) -> SoftDeleteResult:
    """Sweep user 7 through its detail read, both lists, and a login; the id arrives as a string."""

    def ids(path: str) -> Callable[[], list[Any]]:
        return lambda: [item["id"] for item in http.get(f"{stub.url}{path}").json()["items"]]

    return soft_delete_sweep(
        resource_id="7",
        delete_resource=lambda: http.delete(f"{stub.url}/users/7"),
        get_by_id=lambda: http.get(f"{stub.url}/users/7"),
        list_ids=[ids("/users"), ids("/users/export")],
        login_attempt=lambda: http.post(f"{stub.url}/login", json={"email": USER_EMAIL, "password": USER_PASSWORD}),
    )


def checkout_stub(faulty: bool) -> StubHandler:
    """POST /checkout {cartId} and GET /orders.

    A correct checkout checks and inserts in one atomic step, so a second submit of the same
    cart gets 409. The faulty one waits between the check and the insert, the classic
    check-then-act race: both submits pass the check.
    """
    orders: list[dict[str, Any]] = []
    lock = threading.Lock()

    def insert(cart_id: str) -> dict[str, Any]:
        orders.append({"id": len(orders) + 1, "cartId": cart_id})
        return {"status": 201, "headers": {"location": f"/orders/{len(orders)}"}, "body": {"id": len(orders)}}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] == "GET" and request["path"] == "/orders":
            with lock:
                return {"status": 200, "body": {"items": list(orders)}}
        if request["method"] != "POST" or request["path"] != "/checkout":
            return None
        cart_id = request["body"]["cartId"]
        conflict = {"status": 409, "body": {"error": "already ordered"}}
        if faulty:
            if any(order["cartId"] == cart_id for order in orders):
                return conflict
            time.sleep(RACE_WINDOW_SECONDS)
            with lock:
                return insert(cart_id)
        with lock:
            return conflict if any(order["cartId"] == cart_id for order in orders) else insert(cart_id)

    return handler


def checkout(http: httpx.Client, stub: StubServer) -> dict[str, Callable[[], Any]]:
    return {
        "action": lambda: http.post(f"{stub.url}/checkout", json={"cartId": "cart-1"}),
        "count_effects": lambda: len(http.get(f"{stub.url}/orders").json()["items"]),
    }


def seat_stub(fault: str | None = None) -> StubHandler:
    """POST /seats/claim for the last seat and GET /seats.

    A correct booking decrements atomically and answers 409 once sold out. Faults:
    ``overbook`` waits between the check and the decrement, so every contender passes the
    check; ``crash-when-sold-out`` answers 500 instead of 409.
    """
    seats = {"remaining": 1, "bookings": 0}
    lock = threading.Lock()

    def sold_out() -> dict[str, Any]:
        if fault == "crash-when-sold-out":
            return {"status": 500, "body": {"error": "internal"}}
        return {"status": 409, "body": {"error": "sold out"}}

    def book() -> dict[str, Any]:
        seats["remaining"] -= 1
        seats["bookings"] += 1
        return {"status": 201, "body": {"seat": seats["bookings"]}}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        if request["method"] == "GET" and request["path"] == "/seats":
            with lock:
                return {"status": 200, "body": dict(seats)}
        if request["method"] != "POST" or request["path"] != "/seats/claim":
            return None
        if fault == "overbook":
            if seats["remaining"] <= 0:
                return sold_out()
            time.sleep(RACE_WINDOW_SECONDS)
            with lock:
                return book()
        with lock:
            return sold_out() if seats["remaining"] <= 0 else book()

    return handler


def last_seat_race(http: httpx.Client, stub: StubServer) -> RaceResult:
    def seats_hold(_result: RaceResult) -> bool:
        seats = http.get(f"{stub.url}/seats").json()
        return seats["remaining"] >= 0 and seats["bookings"] <= 1

    return concurrent_race(
        n=5,
        capacity=1,
        action=lambda index: http.post(f"{stub.url}/seats/claim", json={"account": f"contender-{index}"}),
        invariant=seats_hold,
    )


def collection_stub(fault: str | None = None) -> StubHandler:
    """PUT /seed/<size> sets the collection size; GET /items?pageSize= reads the first page.

    The server-timing header reports a deterministic cost of 0.2 ms per row the request
    touches, so the scaling cases never depend on wall-clock noise. The first read after a new
    size fills a cache over every row. A correct read then touches one page. Faults:
    ``fan-out`` runs one query per row of the collection (N+1), ``over-fetch`` serves every row.
    """
    state = {"size": 0, "cold": False}

    def handler(request: dict[str, Any]) -> dict[str, Any] | None:
        seed = re.fullmatch(r"/seed/(\d+)", request["path"])
        if request["method"] == "PUT" and seed:
            if int(seed.group(1)) != state["size"]:
                state["cold"] = True
            state["size"] = int(seed.group(1))
            return {"status": 204}
        if request["method"] != "GET" or request["path"] != "/items":
            return None
        size = state["size"]
        served = size if fault == "over-fetch" else min(int(request["query"]["pageSize"]), size)
        touched = size if state["cold"] or fault == "fan-out" else served
        state["cold"] = False
        items = [{"id": index + 1, "name": "item"} for index in range(served)]
        return {"status": 200, "headers": {"server-timing": f"db;dur={touched * 0.2}"}, "body": {"items": items, "total": size}}

    return handler


def read_first_page(http: httpx.Client, stub: StubServer) -> Callable[[int | float], dict[str, float]]:
    def measure(size: int | float) -> dict[str, float]:
        http.put(f"{stub.url}/seed/{size}")
        res = http.get(f"{stub.url}/items", params={"pageSize": PAGE_SIZE})
        return {"ms": server_timing_ms(res), "bytes": len(res.content)}

    return measure


def server_timing_ms(res: httpx.Response) -> float:
    match = re.search(r"dur=([\d.]+)", res.headers.get("server-timing", ""))
    if match is None:
        raise TypeError("the collection stub did not send a server-timing duration")
    return float(match.group(1))


class RecordingPage:
    """The sync-API shape of a Playwright Page for visual_bounds: viewport changes are recorded."""

    def __init__(self) -> None:
        self.viewport_size: dict[str, int] | None = {"width": 1280, "height": 720}
        self.resized: list[dict[str, int]] = []

    def set_viewport_size(self, viewport_size: dict[str, int]) -> None:
        self.resized.append(dict(viewport_size))
        self.viewport_size = dict(viewport_size)


class RecordingLocator:
    """A stand-in for a Locator: evaluate() returns ``raw`` as the page would and records the script."""

    def __init__(self, raw: Any) -> None:
        self.page = RecordingPage()
        self.scripts: list[str] = []
        self._raw = raw

    def evaluate(self, expression: str, arg: Any = None) -> Any:
        self.scripts.append(expression)
        return self._raw

    def __str__(self) -> str:
        return 'get_by_role("button", name="Pay")'


def samples(points: list[tuple[int, list[float], float]]) -> list[ScalingSample]:
    return [ScalingSample(size=size, ms=ms, bytes=payload) for size, times, payload in points for ms in times]


# --- soft_delete_sweep --------------------------------------------------------------------


def test_soft_delete_sweep_resource_gone_from_every_read_path_is_green(http: httpx.Client) -> None:
    with running_stub(user_stub()) as stub:
        assert sweep_user(http, stub) == SoftDeleteResult(delete_status=204, get_status=404, lists=2, login_status=401)
        # User 8 is untouched: the sweep deleted exactly one resource.
        assert http.get(f"{stub.url}/users/8").status_code == 200


def test_soft_delete_sweep_list_still_serving_the_deleted_id_is_red(http: httpx.Client) -> None:
    with running_stub(user_stub("listed")) as stub:
        # The export serves the number 7; the id is the string "7". The type never hides it.
        with pytest.raises(AssertionError, match=r'resource "7" is not gone after the delete\nlist_ids\[1\] still serves the deleted id "7"'):
            sweep_user(http, stub)


@pytest.mark.parametrize(
    ("fault", "message"),
    [
        ("readable", r"get_by_id: expected HTTP 404 after the delete, got 200: method=GET url=http://127\.0\.0\.1:\d+/users/7"),
        ("login", r"login_attempt: expected HTTP 401 for the deleted account, got 200"),
        ("delete-200", r"deleted: expected HTTP 204, got 200"),
    ],
)
def test_soft_delete_sweep_readable_detail_accepted_login_and_wrong_delete_status_are_red(http: httpx.Client, fault: str, message: str) -> None:
    with running_stub(user_stub(fault)) as stub:
        with pytest.raises(AssertionError, match=message):
            sweep_user(http, stub)


def test_soft_delete_sweep_accepts_a_delete_documented_as_200(http: httpx.Client) -> None:
    with running_stub(user_stub("delete-200")) as stub:
        result = soft_delete_sweep(
            resource_id=7,
            delete_resource=lambda: http.delete(f"{stub.url}/users/7"),
            get_by_id=lambda: http.get(f"{stub.url}/users/7"),
            list_ids=[lambda: [8]],
            expected_delete_state="ok",
        )
        assert result == SoftDeleteResult(delete_status=200, get_status=404, lists=1)


def test_soft_delete_sweep_usage_errors_raise_type_error() -> None:
    gone: dict[str, Any] = {
        "delete_resource": lambda: {"status": 204},
        "get_by_id": lambda: {"status": 404},
        "list_ids": [lambda: [8]],
        "resource_id": 7,
    }
    with pytest.raises(TypeError, match="list_ids must be a non-empty list"):
        soft_delete_sweep(**{**gone, "list_ids": []})
    with pytest.raises(TypeError, match="resource_id must be a non-empty string"):
        soft_delete_sweep(**{**gone, "resource_id": ""})
    with pytest.raises(TypeError, match="resource_id"):
        soft_delete_sweep(**{**gone, "resource_id": True})
    with pytest.raises(TypeError, match="unknown expected_delete_state"):
        soft_delete_sweep(**{**gone, "expected_delete_state": "gone"})
    with pytest.raises(TypeError, match="delete_resource and get_by_id must be callables"):
        soft_delete_sweep(**{**gone, "delete_resource": None})
    with pytest.raises(TypeError, match="login_attempt must be a callable"):
        soft_delete_sweep(**{**gone, "login_attempt": "credentials"})
    with pytest.raises(TypeError, match=r"list_ids\[0\] must return a list"):
        soft_delete_sweep(**{**gone, "list_ids": [lambda: "id-7"]})
    assert soft_delete_sweep(**gone) == SoftDeleteResult(delete_status=204, get_status=404, lists=1)


# --- double_submit ------------------------------------------------------------------------


def test_double_submit_checkout_refusing_the_second_submit_is_green(http: httpx.Client) -> None:
    with running_stub(checkout_stub(False)) as stub:
        assert double_submit(**checkout(http, stub)) == DoubleSubmitResult(before=0, after=1, delta=1)
        assert len([record for record in stub.requests() if record["path"] == "/checkout"]) == 2


def test_double_submit_checkout_creating_two_orders_is_red(http: httpx.Client) -> None:
    with running_stub(checkout_stub(True)) as stub:
        with pytest.raises(AssertionError, match=r"two simultaneous submits changed the effect count by 2 \(0 -> 2\), expected exactly 1"):
            double_submit(**checkout(http, stub))


def test_double_submit_starts_both_submits_together() -> None:
    # Each submit waits until the other one has started: run one after another, this would
    # time out; behind the start gate both are in flight at once.
    started = threading.Barrier(2, timeout=5)
    effects: list[int] = []

    def action() -> dict[str, int]:
        started.wait()
        effects.append(1)
        return {"status": 201}

    assert double_submit(action=action, count_effects=lambda: len(effects), expected_delta=2) == DoubleSubmitResult(before=0, after=2, delta=2)


def test_double_submit_usage_errors_raise_type_error() -> None:
    def action() -> dict[str, int]:
        return {"status": 201}

    with pytest.raises(TypeError, match="expected_delta"):
        double_submit(action=action, count_effects=lambda: 0, expected_delta=-1)
    with pytest.raises(TypeError, match="expected_delta"):
        double_submit(action=action, count_effects=lambda: 0, expected_delta=1.5)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="count_effects must return a finite number"):
        double_submit(action=action, count_effects=lambda: float("nan"))
    with pytest.raises(TypeError, match="action and count_effects must be callables"):
        double_submit(action=None, count_effects=lambda: 0)  # type: ignore[arg-type]


# --- concurrent_race ----------------------------------------------------------------------


def test_concurrent_race_last_seat_admitting_one_contender_is_green(http: httpx.Client) -> None:
    with running_stub(seat_stub()) as stub:
        result = last_seat_race(http, stub)
        assert result.succeeded == 1
        assert result.failed == 4
        assert sorted(result.statuses) == [201, 409, 409, 409, 409]


def test_concurrent_race_overbooking_check_then_act_is_red(http: httpx.Client) -> None:
    with running_stub(seat_stub("overbook")) as stub:
        with pytest.raises(AssertionError, match=r"5 call\(s\) succeeded for a capacity of 1; the invariant does not hold after the race"):
            last_seat_race(http, stub)


def test_concurrent_race_5xx_under_contention_is_red(http: httpx.Client) -> None:
    with running_stub(seat_stub("crash-when-sold-out")) as stub:
        with pytest.raises(AssertionError, match=r"concurrent_race \(n=5\): 4 call\(s\) answered 5xx: call \d HTTP 500"):
            last_seat_race(http, stub)


def test_concurrent_race_raising_call_reraises_its_own_error_after_every_call_settled() -> None:
    settled: list[int] = []
    refused = ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:9")

    def action(index: int) -> dict[str, int]:
        time.sleep(index * 0.01)
        settled.append(index)
        if index == 0:
            raise refused
        return {"status": 201}

    with pytest.raises(ConnectionRefusedError) as caught:
        concurrent_race(n=3, action=action, invariant=lambda _result: True)
    assert caught.value is refused
    # Every call settled before the exception surfaced: nothing is left in flight.
    assert sorted(settled) == [0, 1, 2]


def test_concurrent_race_usage_errors_raise_type_error() -> None:
    def action(_index: int) -> dict[str, int]:
        return {"status": 201}

    def bad_arrange(_index: int) -> dict[str, int]:
        raise TypeError("bad arrange")

    with pytest.raises(TypeError, match="n must be an integer >= 2"):
        concurrent_race(n=1, action=action, invariant=lambda _result: True)
    with pytest.raises(TypeError, match="capacity"):
        concurrent_race(n=2, action=action, capacity=-1, invariant=lambda _result: True)
    with pytest.raises(TypeError, match="invariant must return True"):
        concurrent_race(n=2, action=action, invariant=lambda _result: "yes")  # type: ignore[arg-type,return-value]
    with pytest.raises(TypeError, match=r"action\(0\) must return an HTTP response"):
        concurrent_race(n=2, action=lambda _index: {"code": 201}, invariant=lambda _result: True)
    with pytest.raises(TypeError, match="bad arrange"):
        concurrent_race(n=2, action=bad_arrange, invariant=lambda _result: True)
    assert concurrent_race(n=2, action=action, invariant=lambda _result: True) == RaceResult(succeeded=2, failed=0, statuses=[201, 201])


# --- evaluate_bounds and visual_bounds ----------------------------------------------------


@pytest.mark.parametrize(
    ("change", "violation"),
    [
        ({"rect": dataclasses.replace(FITS.rect, x=-4)}, "renders past the left edge (x -4)"),
        ({"rect": dataclasses.replace(FITS.rect, y=-0.5)}, "renders above the top edge (y -0.5)"),
        ({"rect": dataclasses.replace(FITS.rect, width=360)}, "renders past the right edge (right 376 > viewport width 375)"),
        ({"scroll_width": 412}, "content overflows the box (scroll_width 412 > client_width 343)"),
        ({"top_element_is_self": False}, "another element covers its center (occluded)"),
    ],
    ids=["left-edge", "top-edge", "right-edge", "overflow", "occluded"],
)
def test_evaluate_bounds_each_rule_fails_on_its_own(change: dict[str, Any], violation: str) -> None:
    verdict = evaluate_bounds(dataclasses.replace(FITS, **change))
    assert verdict.ok is False
    assert verdict.violations == [violation]


def test_evaluate_bounds_element_inside_the_viewport_is_ok() -> None:
    assert evaluate_bounds(FITS).ok is True
    assert evaluate_bounds(FITS).violations == []
    # Exactly at the right edge is inside.
    assert evaluate_bounds(dataclasses.replace(FITS, rect=BoundsRect(x=0, y=120, width=375, height=48))).ok is True
    # Several violations are all reported, in rule order.
    assert evaluate_bounds(dataclasses.replace(FITS, rect=BoundsRect(x=-10, y=-10, width=400, height=48), top_element_is_self=False)).violations == [
        "renders past the left edge (x -10)",
        "renders above the top edge (y -10)",
        "renders past the right edge (right 390 > viewport width 375)",
        "another element covers its center (occluded)",
    ]


def test_evaluate_bounds_usage_errors_raise_type_error() -> None:
    with pytest.raises(TypeError, match="pass a BoundsMeasurement"):
        evaluate_bounds(None)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match=r"rect\.x must be a finite number"):
        evaluate_bounds(dataclasses.replace(FITS, rect=dataclasses.replace(FITS.rect, x=float("nan"))))
    with pytest.raises(TypeError, match="viewport non-empty"):
        evaluate_bounds(dataclasses.replace(FITS, viewport=Viewport(width=0, height=812)))
    with pytest.raises(TypeError, match="top_element_is_self"):
        evaluate_bounds(dataclasses.replace(FITS, top_element_is_self="yes"))  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="scroll_width"):
        evaluate_bounds(dataclasses.replace(FITS, scroll_width=None))  # type: ignore[arg-type]


def test_visual_bounds_measures_at_the_phone_width_restores_the_viewport_and_asserts_the_rules() -> None:
    fits = RecordingLocator(dataclasses.asdict(FITS))
    assert visual_bounds(fits) == FITS
    assert fits.page.resized == [{"width": 375, "height": 720}, {"width": 1280, "height": 720}]
    assert len(fits.scripts) == 1 and fits.scripts[0].startswith("(element) =>")
    covered = RecordingLocator(dataclasses.asdict(dataclasses.replace(FITS, top_element_is_self=False)))
    with pytest.raises(AssertionError, match=r'visual_bounds at 320px: get_by_role\("button", name="Pay"\) another element covers its center \(occluded\)'):
        visual_bounds(covered, viewport_width=320)
    assert covered.page.resized == [{"width": 320, "height": 720}, {"width": 1280, "height": 720}]


def test_visual_bounds_usage_errors_raise_type_error() -> None:
    with pytest.raises(TypeError, match="viewport_width"):
        visual_bounds(RecordingLocator(dataclasses.asdict(FITS)), viewport_width=0)
    with pytest.raises(TypeError, match="pass a Playwright Locator"):
        visual_bounds(object())
    broken = RecordingLocator({"rect": [16, 120]})
    with pytest.raises(TypeError, match="did not return a bounds measurement"):
        visual_bounds(broken)
    # The viewport is restored even when the measurement is unusable.
    assert broken.page.resized == [{"width": 375, "height": 720}, {"width": 1280, "height": 720}]


# --- analyze_scaling and n1_scaling -------------------------------------------------------


def test_analyze_scaling_flat_growth_is_ok_and_the_median_ignores_an_outlier() -> None:
    analysis = analyze_scaling(samples([(10, [5, 5, 90, 5, 5], 2048), (100, [5, 6, 5, 5, 4], 2048), (1000, [5, 5, 5, 70, 5], 2048)]))
    assert analysis.points == [
        ScalingPoint(size=10, ms=5, bytes=2048, runs=5),
        ScalingPoint(size=100, ms=5, bytes=2048, runs=5),
        ScalingPoint(size=1000, ms=5, bytes=2048, runs=5),
    ]
    assert (analysis.time_exponent, analysis.bytes_exponent, analysis.ok, analysis.violations) == (0, 0, True, [])
    # Sub-linear growth passes: 4 ms -> 16 ms over 100x the size is exponent 0.301.
    sublinear = analyze_scaling(samples([(1000, [16], 100), (10, [4], 100), (100, [8], 100)]))
    assert [point.size for point in sublinear.points] == [10, 100, 1000]
    assert sublinear.time_exponent == pytest.approx(0.301, abs=5e-4)
    assert sublinear.ok is True
    # An even count takes the mean of the two middle values; a mapping is a sample too.
    assert analyze_scaling([{"size": 1, "ms": 2, "bytes": 10}, {"size": 1, "ms": 4, "bytes": 10}, *samples([(2, [3, 3], 10)])]).points[0].ms == 3


def test_analyze_scaling_linear_time_and_a_growing_payload_are_violations() -> None:
    linear = analyze_scaling(samples([(10, [2, 2, 2], 1000), (100, [20, 20, 20], 10000), (1000, [200, 200, 200], 100000)]))
    assert linear.time_exponent == 1
    assert linear.bytes_exponent == 1
    assert linear.ok is False
    assert linear.violations == [
        "time exponent 1 > 0.5 (median 2 ms at size 10 -> 200 ms at size 1000)",
        "bytes exponent 1 > 0.1 (median 1000 bytes at size 10 -> 100000 bytes at size 1000)",
    ]
    # The thresholds are the caller's: a documented linear read passes with explicit limits.
    assert analyze_scaling(samples([(10, [2], 1000), (1000, [200], 100000)]), max_time_exponent=1, max_bytes_exponent=1).ok is True
    # A payload that grows from nothing is infinite growth; an always-empty one is flat.
    assert analyze_scaling(samples([(10, [1], 0), (100, [1], 64)])).bytes_exponent == float("inf")
    assert analyze_scaling(samples([(10, [1], 0), (100, [1], 0)])).bytes_exponent == 0


def test_analyze_scaling_usage_errors_raise_type_error() -> None:
    with pytest.raises(TypeError, match="non-empty list"):
        analyze_scaling([])
    with pytest.raises(TypeError, match="at least two distinct sizes"):
        analyze_scaling(samples([(10, [1, 2], 5)]))
    with pytest.raises(TypeError, match="size must be a finite number > 0"):
        analyze_scaling(samples([(0, [1], 5), (10, [1], 5)]))
    with pytest.raises(TypeError, match="ms must be a finite number >= 0"):
        analyze_scaling(samples([(1, [-1], 5), (10, [1], 5)]))
    with pytest.raises(TypeError, match="bytes"):
        analyze_scaling(samples([(1, [1], float("nan")), (10, [1], 5)]))
    with pytest.raises(TypeError, match="max_time_exponent"):
        analyze_scaling(samples([(1, [1], 5), (10, [1], 5)]), max_time_exponent=float("inf"))
    with pytest.raises(TypeError, match=r"sample 0 must be a ScalingSample"):
        analyze_scaling([(1, 1, 5), (10, 1, 5)])  # type: ignore[list-item]


def test_n1_scaling_one_page_read_is_green_once_the_cold_read_is_discarded(http: httpx.Client) -> None:
    with running_stub(collection_stub()) as stub:
        calls: list[int | float] = []
        measure = read_first_page(http, stub)

        def counted(size: int | float) -> dict[str, float]:
            calls.append(size)
            return measure(size)

        analysis = n1_scaling(sizes=SIZES, measure=counted)
        assert len(calls) == len(SIZES) * 6
        assert [(point.size, point.ms, point.runs) for point in analysis.points] == [(10, 2, 5), (100, 2, 5), (1000, 2, 5)]
        assert analysis.time_exponent == 0
        assert analysis.bytes_exponent <= 0.1
    # Without the warm-up discard the cache fill over every row is measured as the read.
    with running_stub(collection_stub()) as stub:
        with pytest.raises(AssertionError, match=r"time exponent 1 > 0\.5"):
            n1_scaling(sizes=SIZES, measure=read_first_page(http, stub), warmup=0, runs=1)


def test_n1_scaling_per_row_query_fan_out_and_over_fetching_read_are_red(http: httpx.Client) -> None:
    with running_stub(collection_stub("fan-out")) as stub:
        with pytest.raises(
            AssertionError,
            match=r"n1_scaling: the read does not scale sub-linearly: time exponent 1 > 0\.5 \(median 2 ms at size 10 -> 200 ms at size 1000\)\nmedians: size 10: 2 ms",
        ):
            n1_scaling(sizes=SIZES, measure=read_first_page(http, stub), runs=3)
    with running_stub(collection_stub("over-fetch")) as stub:
        with pytest.raises(AssertionError, match=r"time exponent 1 > 0\.5 .*; bytes exponent 0\.9\d* > 0\.1"):
            n1_scaling(sizes=SIZES, measure=read_first_page(http, stub), runs=3)


def test_n1_scaling_usage_errors_raise_type_error() -> None:
    def measure(_size: int | float) -> dict[str, float]:
        return {"ms": 1, "bytes": 1}

    with pytest.raises(TypeError, match="at least three collection sizes"):
        n1_scaling(measure=measure, sizes=[10, 100])
    with pytest.raises(TypeError, match="strictly ascending"):
        n1_scaling(measure=measure, sizes=[10, 1000, 100])
    with pytest.raises(TypeError, match="runs must be a positive integer"):
        n1_scaling(measure=measure, sizes=SIZES, runs=0)
    with pytest.raises(TypeError, match="warmup"):
        n1_scaling(measure=measure, sizes=SIZES, warmup=-1)
    with pytest.raises(TypeError, match=r"measure\(10\) must return \{ms, bytes\}"):
        n1_scaling(measure=lambda _size: None, sizes=SIZES)  # type: ignore[arg-type,return-value]
    with pytest.raises(TypeError, match="max_bytes_exponent"):
        n1_scaling(measure=measure, sizes=SIZES, max_bytes_exponent=float("nan"))
    analysis = n1_scaling(measure=measure, sizes=SIZES)
    assert (analysis.time_exponent, analysis.bytes_exponent, analysis.ok) == (0, 0, True)
