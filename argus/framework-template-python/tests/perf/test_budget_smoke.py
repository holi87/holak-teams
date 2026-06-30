"""@perf lane — GATED on a STATED budget (PERF_BUDGET_MS), never an invented one.

The whole module self-skips unless PERF_BUDGET_MS is set, so an unset run shows
perf as skipped (not failed) and exit stays 0. When a real budget is provided
(from recon + the strategy), it runs a light latency probe against a target
endpoint and asserts p95 stays under budget.

ADAPT-ME: point PERF_TARGET at a meaningful endpoint; for serious load use a
dedicated probe (e.g. a `locust`/`k6` job) and feed its result here.
"""
from __future__ import annotations

import os
import statistics
import time

import httpx
import pytest

from qa.api_client import Endpoints
from qa.config import ENV

PERF_BUDGET_MS = os.environ.get("PERF_BUDGET_MS")
PERF_TARGET = os.environ.get("PERF_TARGET", Endpoints.HEALTH)
PERF_SAMPLES = int(os.environ.get("PERF_SAMPLES", "20"))

pytestmark = [
    pytest.mark.perf,
    pytest.mark.skipif(
        PERF_BUDGET_MS is None,
        reason="perf gate disabled: set PERF_BUDGET_MS to a STATED budget to enable the perf lane",
    ),
]


def test_perf_budget_is_a_stated_positive_number():
    # Guard against a typo'd / non-numeric budget silently disabling the gate.
    assert PERF_BUDGET_MS is not None
    assert float(PERF_BUDGET_MS) > 0, "PERF_BUDGET_MS must parse to a positive number"


def test_endpoint_p95_latency_within_budget():
    budget = float(PERF_BUDGET_MS)  # type: ignore[arg-type]
    samples_ms: list[float] = []
    with httpx.Client(base_url=ENV.api_url, timeout=10.0) as client:
        for _ in range(PERF_SAMPLES):
            start = time.perf_counter()
            client.get(PERF_TARGET)
            samples_ms.append((time.perf_counter() - start) * 1000)

    # p95 via the 20-quantile cut points (needs >= 2 samples).
    p95 = statistics.quantiles(samples_ms, n=20)[-1] if len(samples_ms) >= 2 else samples_ms[0]
    assert p95 <= budget, (
        f"{PERF_TARGET} p95={p95:.1f}ms exceeds budget {budget:.0f}ms "
        f"(n={len(samples_ms)}, min={min(samples_ms):.1f} max={max(samples_ms):.1f})"
    )
