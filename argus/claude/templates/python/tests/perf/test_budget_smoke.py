"""@perf lane — a GATE on a STATED budget (PERF_BUDGET_MS), never an invented one.

The lane runs only when solution/test-lanes.tsv enables it, with PERF_BUDGET_MS as its
prerequisite. A missing, non-numeric or non-positive budget is reported through
ArgusPrerequisiteError as ``prerequisite-missing``; the tests never skip themselves. With a
real budget (from recon + the strategy) a light latency probe against a target endpoint
asserts that p95 stays under it.

ADAPT-ME: point PERF_TARGET at a meaningful endpoint; for serious load use a
dedicated probe (e.g. a `locust`/`k6` job) and feed its result here.
"""
from __future__ import annotations

import math
import os
import statistics
import time

import httpx
import pytest

from qa.api_client import Endpoints
from qa.argus.errors import ArgusPrerequisiteError, require_env
from qa.config import ENV

PERF_TARGET = os.environ.get("PERF_TARGET", Endpoints.HEALTH)

pytestmark = pytest.mark.perf


def budget_ms() -> float:
    """The stated budget in milliseconds; anything but a positive number is a missing prerequisite."""
    try:
        budget = float(require_env("PERF_BUDGET_MS"))
    except ValueError:
        budget = math.nan  # reported below without echoing the value
    if not math.isfinite(budget) or budget <= 0:
        raise ArgusPrerequisiteError("PERF_BUDGET_MS must be a positive number of milliseconds")
    return budget


def sample_count() -> int:
    """PERF_SAMPLES (default 20); anything but a positive integer is a missing prerequisite."""
    raw = os.environ.get("PERF_SAMPLES", "20")
    if not raw.isdigit() or int(raw) < 1:
        raise ArgusPrerequisiteError("PERF_SAMPLES must be a positive integer")
    return int(raw)


def test_perf_budget_is_a_stated_positive_number():
    # Guard against a typo'd / non-numeric budget silently weakening the gate.
    assert budget_ms() > 0, "PERF_BUDGET_MS must parse to a positive number"


def test_endpoint_p95_latency_within_budget():
    budget = budget_ms()
    samples = sample_count()
    samples_ms: list[float] = []
    with httpx.Client(base_url=ENV.api_url, timeout=10.0) as client:
        for _ in range(samples):
            start = time.perf_counter()
            client.get(PERF_TARGET)
            samples_ms.append((time.perf_counter() - start) * 1000)

    # p95 via the 20-quantile cut points (needs >= 2 samples).
    p95 = statistics.quantiles(samples_ms, n=20)[-1] if len(samples_ms) >= 2 else samples_ms[0]
    assert p95 <= budget, (
        f"{PERF_TARGET} p95={p95:.1f}ms exceeds budget {budget:.0f}ms "
        f"(n={len(samples_ms)}, min={min(samples_ms):.1f} max={max(samples_ms):.1f})"
    )
