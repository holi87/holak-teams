"""Argus runner-kit support for pytest: typed error classes and prerequisite lookup.

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

__all__ = [
    "ArgusCleanupError",
    "ArgusCounterfactualError",
    "ArgusPrerequisiteError",
    "ArgusRestoreError",
    "require_env",
]
