"""Concurrency oracles.

Two submits of one commit-style action and N contenders for a scarce resource are fired
together, not one after another: a check-then-act race only shows when the requests overlap.
Every call runs on its own thread behind a Barrier start gate, so all of them start at the
same moment, and each oracle judges the outcome only after every call has settled. A RED
raises AssertionError (product); every misuse raises TypeError (automation).

The actions run concurrently, so the client they share must be thread-safe: an
``httpx.Client`` is; a Playwright sync object is bound to its own thread and is not.
"""
from __future__ import annotations

import dataclasses
import functools
import math
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, TypeVar

from .boundary import _show
from .http import status_of

T = TypeVar("T")

#: How long the start gate waits for every call's thread before it gives up (automation).
START_GATE_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class DoubleSubmitResult:
    before: int | float
    after: int | float
    delta: int | float


@dataclass(frozen=True)
class RaceResult:
    #: Calls answered 2xx.
    succeeded: int
    #: Calls answered with any other status.
    failed: int
    #: Every call's status, in call order.
    statuses: list[int]


def double_submit(
    *,
    action: Callable[[], Any],
    count_effects: Callable[[], int | float],
    expected_delta: int = 1,
) -> DoubleSubmitResult:
    """Fire ``action`` twice at once and require the effect count to grow by exactly ``expected_delta``.

    The default is 1: a second order, payment, or enrollment from one double-clicked submit
    is RED. ``count_effects()`` reads the effect count (for example the length of the orders
    list) before and after; pass the delta the action contract names, 2 when two submits are
    two legitimate effects. A call that raises is re-raised as it is once both have settled.
    """
    if not callable(action) or not callable(count_effects):
        raise TypeError("double_submit: action and count_effects must be callables")
    if isinstance(expected_delta, bool) or not isinstance(expected_delta, int) or expected_delta < 0:
        raise TypeError(f"double_submit: expected_delta must be a non-negative integer, got {_show(expected_delta)}")
    before = _read_count(count_effects)
    _start_together([action, action], "double_submit")
    after = _read_count(count_effects)
    delta = after - before
    if delta != expected_delta:
        raise AssertionError(
            f"double_submit: two simultaneous submits changed the effect count by {delta} ({before} -> {after}), expected exactly {expected_delta}"
        )
    return DoubleSubmitResult(before=before, after=after, delta=delta)


def concurrent_race(
    *,
    n: int,
    action: Callable[[int], Any],
    invariant: Callable[[RaceResult], bool],
    capacity: int | None = None,
) -> RaceResult:
    """Start ``n`` calls of ``action(index)`` at once against one scarce resource.

    Once all have settled: no call may answer 5xx, at most ``capacity`` calls may succeed
    (2xx) when a capacity is given, and ``invariant(result)`` must return True (for example:
    the stock read back afterwards is not negative and the bookings do not exceed the seats).
    ``index`` lets each contender use its own account. Each call returns an httpx or
    Playwright response or a ``{"status": ...}`` record. A call that raises has no HTTP answer
    to judge: once every call has settled, the first raising call's exception (in call order)
    is re-raised as it is, so a usage error stays an automation failure and a refused
    connection stays an infrastructure one.
    """
    if isinstance(n, bool) or not isinstance(n, int) or n < 2:
        raise TypeError(f"concurrent_race: n must be an integer >= 2, got {_show(n)}")
    if not callable(action) or not callable(invariant):
        raise TypeError("concurrent_race: action and invariant must be callables")
    if capacity is not None and (isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 0):
        raise TypeError(f"concurrent_race: capacity must be a non-negative integer, got {_show(capacity)}")
    responses = _start_together([functools.partial(action, index) for index in range(n)], "concurrent_race")
    statuses = [_race_status(response, index) for index, response in enumerate(responses)]
    succeeded = sum(1 for status in statuses if 200 <= status < 300)
    result = RaceResult(succeeded=succeeded, failed=n - succeeded, statuses=statuses)
    holds = invariant(dataclasses.replace(result, statuses=list(statuses)))
    if not isinstance(holds, bool):
        raise TypeError("concurrent_race: invariant must return True (holds) or False (violated)")
    problems: list[str] = []
    server_errors = [(index, status) for index, status in enumerate(statuses) if status >= 500]
    if server_errors:
        listed = ", ".join(f"call {index} HTTP {status}" for index, status in server_errors)
        problems.append(f"{len(server_errors)} call(s) answered 5xx: {listed}")
    if capacity is not None and succeeded > capacity:
        problems.append(f"{succeeded} call(s) succeeded for a capacity of {capacity}")
    if not holds:
        problems.append("the invariant does not hold after the race")
    if problems:
        raise AssertionError(f"concurrent_race (n={n}): {'; '.join(problems)}\nstatuses: {', '.join(str(status) for status in statuses)}")
    return result


def _start_together(calls: Sequence[Callable[[], T]], label: str) -> list[T]:
    """Run every call on its own thread, released together by one Barrier; results in call order.

    The pool has exactly one thread per call, so every party reaches the gate. The first
    exception in call order is re-raised only after every call has settled, so nothing is
    left in flight.
    """
    gate = threading.Barrier(len(calls))

    def gated(call: Callable[[], T]) -> T:
        try:
            gate.wait(timeout=START_GATE_TIMEOUT_SECONDS)
        except threading.BrokenBarrierError:
            raise RuntimeError(f"{label}: the start gate broke before all {len(calls)} calls were ready") from None
        return call()

    futures: list[Future[T]] = []
    with ThreadPoolExecutor(max_workers=len(calls), thread_name_prefix=f"argus-{label}") as pool:
        try:
            for call in calls:
                futures.append(pool.submit(gated, call))
        except BaseException:
            # A thread that could not start would leave the others waiting at the gate.
            gate.abort()
            raise
    # Leaving the pool waited for every call; result() re-raises a call's own exception.
    return [future.result() for future in futures]


def _read_count(count_effects: Callable[[], int | float]) -> int | float:
    count = count_effects()
    if isinstance(count, bool) or not isinstance(count, (int, float)) or not math.isfinite(count):
        raise TypeError("double_submit: count_effects must return a finite number")
    return count


def _race_status(response: Any, index: int) -> int:
    try:
        status = status_of(response)
    except (TypeError, ValueError, KeyError):
        status = None
    if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
        raise TypeError(f"concurrent_race: action({index}) must return an HTTP response or a {{status}} record")
    return status
