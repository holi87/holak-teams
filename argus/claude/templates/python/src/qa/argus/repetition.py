"""Declared repetition of an intermittent-defect regression (RUNNER-CONTRACT.md SD-6)."""
from __future__ import annotations

from collections.abc import Callable

MAX_REPETITION = 200


def reproduce(n: int, attempt: Callable[[], object]) -> None:
    """Run ``attempt`` ``n`` (1..200) times in one test, stopping at the first failure.

    Each attempt starts from fresh state, and the first oracle violation propagates as raised:
    it is never a retry. Declare the same ``n`` with ``@pytest.mark.repetition(n)``. Never
    parametrize the regression instead; each parametrized item is a separate case.
    """
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_REPETITION:
        raise ValueError(f"repetition must be an integer in 1..{MAX_REPETITION}, got {n!r}")
    for _ in range(n):
        attempt()
