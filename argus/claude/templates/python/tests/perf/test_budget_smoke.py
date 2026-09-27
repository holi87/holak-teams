"""@perf lane — a GATE, not a benchmark.

- The p95 check asserts only a budget the strategy has STATED (PERF_BUDGET_MS); never invent a
  threshold. A missing, non-numeric or non-positive budget is reported through
  ArgusPrerequisiteError as ``prerequisite-missing``; the tests never skip themselves.
- n1_scaling needs no budget: it compares the product with itself at growing collection sizes
  and requires the read to grow sub-linearly, so an N+1 fan-out is RED.
The lane runs only when solution/test-lanes.tsv enables it, with PERF_BUDGET_MS as its
prerequisite. For serious load use a dedicated probe (e.g. a `locust`/`k6` job) and feed its
result here.
"""
from __future__ import annotations

import math
import time
from collections.abc import Callable

import httpx
import pytest

from qa.api_client import Endpoints, ResourceClient
from qa.argus.errors import ArgusPrerequisiteError, require_env
from qa.data.factory import build_order
from qa.oracles import assert_rest_status, expect_status, n1_scaling

pytestmark = pytest.mark.perf

# ADAPT-ME: the endpoint the stated budget covers, the sample counts, and the collection read
# Hermes flagged for N+1. The read uses a fixed page size, so a correct read stays flat in
# payload; the smallest size must fill that page, or the payload grows between the first two
# sizes on a correct app.
BUDGET_ENDPOINT = Endpoints.HEALTH
WARMUP_REQUESTS = 3
MEASURED_REQUESTS = 40
COLLECTION_PATH = Endpoints.ORDERS
COLLECTION_PAGE_SIZE = 10
COLLECTION_SIZES = [10, 40, 160]


def budget_ms() -> float:
    """The stated budget in milliseconds; anything but a positive number is a missing prerequisite."""
    try:
        budget = float(require_env("PERF_BUDGET_MS"))
    except ValueError:
        budget = math.nan  # reported below without echoing the value
    if not math.isfinite(budget) or budget <= 0:
        raise ArgusPrerequisiteError("PERF_BUDGET_MS must be a positive number of milliseconds")
    return budget


def timed(send: Callable[[], httpx.Response]) -> tuple[httpx.Response, float, int]:
    """One request, timed from send to the last body byte: the response, the ms, and the body bytes."""
    start = time.perf_counter()
    res = send()
    body = res.read()
    return res, (time.perf_counter() - start) * 1000, len(body)


def percentile(samples: list[float], p: float) -> float:
    """Nearest-rank percentile: the smallest sample with at least p% of the samples at or below it."""
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def test_endpoint_p95_latency_within_budget(anon_client):
    budget = budget_ms()
    timings: list[float] = []
    for call in range(WARMUP_REQUESTS + MEASURED_REQUESTS):
        res, ms, _ = timed(lambda: anon_client.get(BUDGET_ENDPOINT))
        expect_status(res, 200)
        if call >= WARMUP_REQUESTS:
            timings.append(ms)
    p95 = percentile(timings, 95)
    assert p95 <= budget, f"p95 of {MEASURED_REQUESTS} sequential GET {BUDGET_ENDPOINT} is {p95:.1f} ms; the stated budget is {budget:g} ms"


def test_collection_read_grows_sub_linearly_with_the_collection_size(api_as, created_resources):
    user = api_as("user")
    orders = ResourceClient(user, COLLECTION_PATH)
    # ADAPT-ME: start from an empty or freshly reset collection (solution/environment.tsv) so
    # each size is exact, or arrange through the app's seed command instead of the API.
    arranged = 0

    def arrange_to(size: int) -> None:
        nonlocal arranged
        while arranged < size:
            res = orders.create(build_order())
            location = res.headers.get("location")
            if location:
                created_resources.append((user, location))
            assert_rest_status(res, "created")
            arranged += 1

    def measure(size: int) -> dict[str, float]:
        arrange_to(size)
        res, ms, payload = timed(lambda: orders.list({"pageSize": COLLECTION_PAGE_SIZE}))
        expect_status(res, 200)
        return {"ms": ms, "bytes": payload}

    n1_scaling(sizes=COLLECTION_SIZES, measure=measure)
