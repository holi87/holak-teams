"""Strict teardown of the resources a test created (RUNNER-CONTRACT.md SD-5).

The root conftest's ``created_resources`` fixture hands each test a list of ``(client, path)``
pairs and calls ``cleanup_created_resources`` in its teardown. Every registered resource gets
its DELETE, newest first, even after an earlier one failed. A status outside 200/204/404
or an exception (a closed client, a dropped connection, a malformed registration) is a
failure, and the ArgusCleanupError it raises (``automation fail cleanup-failed``) names only
the count, never a path, a status, or a body.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .errors import ArgusCleanupError

#: A DELETE that answers one of these removed the resource or found it already gone.
# 202 only accepts deletion; without a target-specific completion check it is not cleanup.
CLEANUP_STATUSES = frozenset({200, 204, 404})


def cleanup_created_resources(created: Sequence[Any]) -> None:
    """DELETE every ``(client, path)`` in ``created``, newest first; raise ArgusCleanupError on any failure.

    ``client`` is anything with ``delete(path)`` returning a response with ``status_code``,
    such as the ``httpx.Client`` that ``api_as`` or ``anon_client`` hands out.
    """
    failures = 0
    for registration in reversed(list(created)):
        try:
            client, path = registration
            status = client.delete(path).status_code
        except Exception:  # noqa: BLE001 - every resource still gets its DELETE; the count reports this one
            failures += 1
            continue
        if status not in CLEANUP_STATUSES:
            failures += 1
    if failures:
        raise ArgusCleanupError(f"cleanup failed for {failures} resource(s)")
