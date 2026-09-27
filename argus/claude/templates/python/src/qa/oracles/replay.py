"""Idempotency oracles.

A replayed idempotent request (PUT, DELETE, or a POST carrying an idempotency key) must not
change the outcome or the state a second time. Every RED raises AssertionError (product);
misuse raises TypeError (automation).
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from typing import Any, Callable, Iterable, TypeVar

from .http import describe_result, read_result, redacted_excerpt

R = TypeVar("R")


@dataclass(frozen=True)
class ReplayResult:
    """The first response's status and body, and the state read after the replay (or None)."""

    status: int
    body: Any
    state: Any = None


@dataclass(frozen=True)
class IdempotencyReplay:
    """The idempotency key both sends carried and the id both responses named."""

    key: str
    id: Any


def idempotent_replay(
    send: Callable[[], Any],
    read: Callable[[], Any] | None = None,
    volatile_fields: Iterable[str] = (),
) -> ReplayResult:
    """Send the same request twice, sequentially.

    Both responses must have the same status and deep-equal bodies once ``volatile_fields``
    (key names, removed at any depth) are dropped; with ``read``, the state read after each
    send must be equal too.
    """
    volatile = frozenset(volatile_fields)
    first = read_result(send())
    state_after_first = read() if read else None
    second = read_result(send())
    state_after_second = read() if read else None
    if second.status != first.status:
        raise AssertionError(f"idempotent replay changed the status from {first.status} to {second.status}: {describe_result(second)}")
    first_body = _without_volatile(first.body, volatile)
    second_body = _without_volatile(second.body, volatile)
    if not _same(first_body, second_body):
        raise AssertionError(
            f"idempotent replay changed the body: {describe_result(second, include_body=False)}\n"
            f"first:  {redacted_excerpt(first_body)}\nreplay: {redacted_excerpt(second_body)}"
        )
    if read:
        before = _without_volatile(state_after_first, volatile)
        after = _without_volatile(state_after_second, volatile)
        if not _same(before, after):
            raise AssertionError(
                "idempotent replay changed the state read back\n"
                f"after first:  {redacted_excerpt(before)}\nafter replay: {redacted_excerpt(after)}"
            )
    return ReplayResult(status=first.status, body=first.body, state=state_after_second)


_sequence = itertools.count(1)


def next_idempotency_key() -> str:
    """The next deterministic idempotency key, ``argus-idem-<seq>``.

    The sequence is per process (each pytest-xdist worker has its own); against an
    environment that keeps keys across runs, use keys scoped to the run instead.
    """
    return f"argus-idem-{next(_sequence)}"


def replay_with_idempotency_key(
    send: Callable[[str], R],
    count: Callable[[], float],
    id_of: Callable[[R], Any],
) -> IdempotencyReplay:
    """Send one create twice with the same idempotency key.

    Exactly one effect must exist (count after == count before + 1) and both responses must
    name the same id.
    """
    key = next_idempotency_key()
    before = count()
    first = send(key)
    second = send(key)
    after = count()
    if not (_is_finite_number(before) and _is_finite_number(after)):
        raise TypeError("replay_with_idempotency_key: count() must return a finite number")
    first_id = id_of(first)
    second_id = id_of(second)
    if after != before + 1:
        raise AssertionError(f"idempotency key {key}: expected exactly one effect (count {before} -> {before + 1}), observed {after}")
    if first_id is None or first_id == "":
        raise AssertionError(f"idempotency key {key}: the first response carries no id")
    if not _same(first_id, second_id):
        raise AssertionError(
            f"idempotency key {key}: the replay returned a different id "
            f"({redacted_excerpt(first_id, 80)} then {redacted_excerpt(second_id, 80)})"
        )
    return IdempotencyReplay(key=key, id=first_id)


def _without_volatile(value: Any, volatile: frozenset[str]) -> Any:
    if not volatile or not isinstance(value, (dict, list)):
        return value
    if isinstance(value, list):
        return [_without_volatile(item, volatile) for item in value]
    return {key: _without_volatile(item, volatile) for key, item in value.items() if key not in volatile}


def _same(left: Any, right: Any) -> bool:
    """Strict deep equality of JSON values: True never equals 1, 1 equals 1.0."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same(left[key], right[key]) for key in left)
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    return type(left) is type(right) and left == right


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
