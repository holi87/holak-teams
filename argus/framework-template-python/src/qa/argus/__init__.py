"""Argus runner-kit support for pytest: typed error classes, prerequisite lookup, repetition.

The outcome adapter itself is the pytest plugin ``qa.argus_plugin`` (loaded by the root
conftest); this package holds what tests and fixtures import.
"""
from .errors import (
    ArgusCleanupError,
    ArgusCounterfactualError,
    ArgusPrerequisiteError,
    ArgusRestoreError,
    require_env,
)
from .repetition import reproduce

__all__ = [
    "ArgusCleanupError",
    "ArgusCounterfactualError",
    "ArgusPrerequisiteError",
    "ArgusRestoreError",
    "reproduce",
    "require_env",
]
