"""Test-data builders: every spec gets fresh, unique, override-friendly data.

Never hardcode shared records in specs — parallel workers (pytest-xdist) collide.
ADAPT-ME: one builder per domain entity from Kalchas's data-model map.
"""
from __future__ import annotations

import itertools
import time
from typing import Any

_counter = itertools.count(1)


def unique(prefix: str) -> str:
    """A process-unique, human-readable token (safe across xdist workers via pid+time)."""
    return f"{prefix}-{int(time.time() * 1000)}-{next(_counter)}"


def build_order(**overrides: Any) -> dict[str, Any]:
    """Example builder — replace with the real entity shape from the OpenAPI spec.

    Override any field by keyword: ``build_order(qty=-5)`` for negative cases.
    """
    data: dict[str, Any] = {
        "item": unique("item"),
        "qty": 1,
    }
    data.update(overrides)
    return data
