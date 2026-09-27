"""Fault injection for the resilience lane (TEMPLATE-CONTRACT.md, RUNNER-CONTRACT.md SD-5).

The Python port of the TypeScript template's ``src/argus/fault-injector.ts``. A fault is
injected only around one body and always restored afterwards:

1. A ``server`` fault changes the shared target, so it needs the caller's explicit
   ``ARGUS_FAULT_INJECTION=authorized``; anything else raises ArgusPrerequisiteError before
   anything is injected. Inside an engagement (``ARGUS_ENGAGEMENT_MANIFEST``, or an
   ``ai_agents_internal/engagement.json`` above the working directory or this harness) that
   value is only a request: the fault also needs ``ARGUS_FAULT_INJECTION_GRANT``, which
   ``scripts/runner-lib.sh`` sets only after the chaos grant and the exclusive fault window.
   A ``client`` fault stays inside the test process (``page.route``, a stub) and needs no grant.
2. The restore is recorded before ``inject`` runs, so a partial injection is undone too.
3. ``restore`` runs in every case, then ``verify_restored`` proves the target is back to
   normal. A failure in either raises ArgusRestoreError (``infrastructure fail
   fault-restore-failed``): the environment is in an unknown state and the run must stop
   trusting it. That error outranks an error of the body, which it names in a note; only an
   operator stop (KeyboardInterrupt, SystemExit) still propagates as itself.

Use the module-level ``run(fault, body)``, or the root conftest's ``fault_injector`` fixture,
whose teardown settles whatever fault a test left active. ``fault_active()`` is true while any
fault in this process waits for its verified restore, so the UI console guard ignores the
fault's intended effects. Messages carry only the fault name, never target data.
"""
from __future__ import annotations

import os
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypeVar

from .errors import ArgusPrerequisiteError, ArgusRestoreError, require_env

FaultScope = Literal["client", "server"]
T = TypeVar("T")

_FAULT_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_LANE = re.compile(r"[a-z][a-z0-9-]*")
_OPERATOR_STOP = (KeyboardInterrupt, SystemExit)
_active_lock = threading.Lock()
_active = 0


@dataclass(frozen=True)
class Fault:
    """One fault: a safe token ``name`` (for example ``api-unavailable``), its scope, and the
    inject/restore/verify hooks. ``verify_restored`` raises when the target still shows the
    fault after ``restore``. An invalid fault is refused when it is built, before anything is
    injected."""

    name: str
    scope: FaultScope
    inject: Callable[[], object]
    restore: Callable[[], object]
    verify_restored: Callable[[], object]

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not _FAULT_NAME.fullmatch(self.name):
            raise ValueError("a fault name must be a lowercase token such as api-unavailable")
        if self.scope not in ("client", "server"):
            raise ValueError(f"fault {self.name}: scope must be client or server")
        for hook in ("inject", "restore", "verify_restored"):
            if not callable(getattr(self, hook)):
                raise TypeError(f"fault {self.name}: {hook} must be callable")


class _Recorded:
    """One recorded fault; restored and verified exactly once."""

    __slots__ = ("fault", "lock", "restored", "failure")

    def __init__(self, fault: Fault) -> None:
        self.fault = fault
        self.lock = threading.Lock()
        self.restored = False
        self.failure: ArgusRestoreError | None = None


class FaultInjector:
    """Tracks the faults of one test; ``settle()`` restores whatever a test leaves active."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._recorded: list[_Recorded] = []

    @property
    def active(self) -> bool:
        """True from the moment one of this injector's restores is recorded until it is verified."""
        with self._lock:
            return bool(self._recorded)

    def run(self, fault: Fault, body: Callable[[], T]) -> T:
        """Inject ``fault`` around ``body`` and always restore it; see the module docstring."""
        if not isinstance(fault, Fault):
            raise TypeError("run() needs a qa.argus.fault_injector.Fault")
        if not callable(body):
            raise TypeError(f"fault {fault.name}: body must be callable")
        if fault.scope == "server":
            _require_server_authorization(fault.name)
        entry = self._record(fault)
        try:
            fault.inject()
            value = body()
        except BaseException as error:
            try:
                self._restore(entry)
            except ArgusRestoreError as failure:
                if isinstance(error, _OPERATOR_STOP):
                    raise error  # the restore failure stays visible as its context
                failure.add_note(f"the fault body had already failed with {type(error).__name__}")
                raise
            raise
        self._restore(entry)
        return value

    def settle(self) -> None:
        """Restore and verify every fault still recorded, for example one a test abandoned.

        Raises the first ArgusRestoreError after every recorded fault had its restore.
        """
        with self._lock:
            pending = list(self._recorded)
        first: ArgusRestoreError | None = None
        for entry in pending:
            try:
                self._restore(entry)
            except ArgusRestoreError as failure:
                first = first or failure
        if first is not None:
            raise first

    def _record(self, fault: Fault) -> _Recorded:
        global _active
        entry = _Recorded(fault)
        with self._lock:
            self._recorded.append(entry)
        with _active_lock:
            _active += 1
        return entry

    # Each recorded fault is restored exactly once, whether run() or settle() gets there first;
    # a later caller waits for that restore and sees the same outcome.
    def _restore(self, entry: _Recorded) -> None:
        global _active
        with entry.lock:
            if not entry.restored:
                entry.restored = True
                try:
                    entry.failure = _restore_and_verify(entry.fault)
                finally:
                    with self._lock:
                        self._recorded.remove(entry)
                    with _active_lock:
                        _active -= 1
            if entry.failure is not None:
                raise entry.failure


def run(fault: Fault, body: Callable[[], T]) -> T:
    """Inject ``fault`` around ``body`` and always restore it; see the module docstring."""
    return FaultInjector().run(fault, body)


def fault_active() -> bool:
    """True while any fault in this process has been recorded and its restore is not yet verified."""
    with _active_lock:
        return _active > 0


def _restore_and_verify(fault: Fault) -> ArgusRestoreError | None:
    """None after a verified restore, else the ArgusRestoreError to raise.

    A hook that raises anything, pytest.fail() included, is a failed restore; an operator stop
    still propagates as itself.
    """
    for hook, failed in ((fault.restore, "restore failed"), (fault.verify_restored, "the restore could not be verified")):
        try:
            hook()
        except _OPERATOR_STOP:
            raise
        except BaseException as error:  # noqa: BLE001 - any failed hook leaves the target in an unknown state
            failure = ArgusRestoreError(f"fault {fault.name}: {failed}")
            failure.__cause__ = error
            return failure
    return None


def inside_engagement() -> bool:
    """True when ARGUS_ENGAGEMENT_MANIFEST is set or an ai_agents_internal/engagement.json sits in
    the working directory, this harness, or an ancestor of either (as argus-assets finds one)."""
    if os.environ.get("ARGUS_ENGAGEMENT_MANIFEST"):
        return True
    starts = [Path(__file__).resolve().parent]
    try:
        starts.append(Path.cwd())
    except OSError:
        pass
    return any((directory / "ai_agents_internal" / "engagement.json").exists() for start in starts for directory in (start, *start.parents))


def _require_server_authorization(name: str) -> None:
    if require_env("ARGUS_FAULT_INJECTION") != "authorized":
        raise ArgusPrerequisiteError(f"server-side fault {name} requires ARGUS_FAULT_INJECTION=authorized")
    if inside_engagement() and not _LANE.fullmatch(os.environ.get("ARGUS_FAULT_INJECTION_GRANT", "")):
        raise ArgusPrerequisiteError(
            f"server-side fault {name} inside an Argus engagement requires the grant scripts/runner-lib.sh "
            "issues after the chaos authorization; run it through run-tests.sh"
        )
