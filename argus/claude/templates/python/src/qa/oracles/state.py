"""Lifecycle state oracles.

A deleted resource must be gone from every read path, not only from the detail GET: a list,
a search, or an export that still serves it is a soft-delete defect, and a deleted user who
can still log in is a security one. A RED raises AssertionError (product); every misuse
raises TypeError (automation).
"""
from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from .boundary import _show
from .http import REST_STATUS, RestState, assert_rest_status, describe_result, read_result, status_of


@dataclass(frozen=True)
class SoftDeleteResult:
    #: The delete status (the exact code of expected_delete_state).
    delete_status: int
    #: The status of the detail read after the delete (404).
    get_status: int
    #: How many list reads were checked.
    lists: int
    #: The login status after the delete (401), when login_attempt was given.
    login_status: int | None = None


def soft_delete_sweep(
    *,
    delete_resource: Callable[[], Any],
    get_by_id: Callable[[], Any],
    list_ids: Sequence[Callable[[], Sequence[Any]]],
    resource_id: str | int,
    login_attempt: Callable[[], Any] | None = None,
    expected_delete_state: RestState = "deleted",
) -> SoftDeleteResult:
    """Delete a resource, then sweep every read path.

    The delete must answer ``assert_rest_status(expected_delete_state)`` (default "deleted":
    204 with an empty body); then ``get_by_id()`` must answer 404 ("missing"), every callable
    in ``list_ids`` must return ids that exclude ``resource_id``, and ``login_attempt()``, when
    given (a deleted user's credentials), must answer 401 ("unauthenticated"). A failed delete
    stops the sweep; after a successful one every read path is checked and all of the failures
    are reported together. Ids compare as strings, so a list serving 7 still matches the id
    "7" read from a Location header: a type mismatch never hides a resurrected resource.
    """
    if not callable(delete_resource) or not callable(get_by_id):
        raise TypeError("soft_delete_sweep: delete_resource and get_by_id must be callables")
    if (
        not isinstance(list_ids, (list, tuple))
        or len(list_ids) == 0
        or not all(callable(list_read) for list_read in list_ids)
    ):
        raise TypeError("soft_delete_sweep: list_ids must be a non-empty list of callables, one per list read that could still serve the resource")
    if not _is_resource_id(resource_id):
        raise TypeError(f"soft_delete_sweep: resource_id must be a non-empty string or a finite number, got {_show(resource_id)}")
    if login_attempt is not None and not callable(login_attempt):
        raise TypeError("soft_delete_sweep: login_attempt must be a callable")
    if not isinstance(expected_delete_state, str) or expected_delete_state not in REST_STATUS:
        raise TypeError(f"soft_delete_sweep: unknown expected_delete_state {_show(expected_delete_state)}")

    deleted = delete_resource()
    assert_rest_status(deleted, expected_delete_state)
    delete_status = status_of(deleted)

    target = str(resource_id)
    problems: list[str] = []
    read = read_result(get_by_id())
    if read.status != REST_STATUS["missing"]:
        problems.append(f"get_by_id: expected HTTP {REST_STATUS['missing']} after the delete, got {read.status}: {describe_result(read)}")
    for index, list_read in enumerate(list_ids):
        ids = list_read()
        if not isinstance(ids, (list, tuple)):
            raise TypeError(f"soft_delete_sweep: list_ids[{index}] must return a list of ids")
        if any(str(entry) == target for entry in ids):
            problems.append(f"list_ids[{index}] still serves the deleted id {_show(resource_id)}")
    login_status: int | None = None
    if login_attempt is not None:
        login = read_result(login_attempt())
        login_status = login.status
        if login.status != REST_STATUS["unauthenticated"]:
            problems.append(
                f"login_attempt: expected HTTP {REST_STATUS['unauthenticated']} for the deleted account, "
                f"got {login.status}: {describe_result(login, include_body=False)}"
            )
    if problems:
        raise AssertionError(f"soft_delete_sweep: resource {_show(resource_id)} is not gone after the delete\n" + "\n".join(problems))
    return SoftDeleteResult(delete_status=delete_status, get_status=read.status, lists=len(list_ids), login_status=login_status)


def _is_resource_id(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)
