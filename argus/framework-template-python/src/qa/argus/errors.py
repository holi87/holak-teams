"""Argus error classes — the typed signals the outcome adapter classifies (SD-5).

Raise these instead of a bare exception when the failure is not a product defect, so the
run records the right category: a missing prerequisite is infrastructure, a failed cleanup
is automation. The class names are identical in every Argus runtime; the adapter
(qa.argus_plugin) matches them by name.
"""
from __future__ import annotations

import os


class ArgusCleanupError(Exception):
    """Teardown could not restore the state the test created (automation cleanup-failed)."""


class ArgusPrerequisiteError(Exception):
    """A declared prerequisite is missing from the environment (infrastructure prerequisite-missing)."""


class ArgusRestoreError(Exception):
    """An injected fault could not be removed again (infrastructure fault-restore-failed)."""


class ArgusCounterfactualError(Exception):
    """A counterfactual pass saw a request no stub exchange matched (automation counterfactual-unmatched-request)."""


def require_env(name: str) -> str:
    """Return the environment variable ``name``, or raise ArgusPrerequisiteError when it is unset or empty.

    Tests never self-skip on prerequisites (SD-8): a missing value is an infrastructure
    outcome, not a skipped test. Only the variable name is reported, never a value.
    """
    value = os.environ.get(name, "")
    if not value:
        raise ArgusPrerequisiteError(f"required environment variable {name} is unset or empty")
    return value
