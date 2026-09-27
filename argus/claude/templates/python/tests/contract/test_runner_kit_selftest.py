"""Self-tests for the runner-kit helpers behind the ``fault_injector`` and ``created_resources``
fixtures (qa.argus.fault_injector, qa.argus.cleanup) and for qa.argus.reproduce.

Nothing contacts a real target: faults are recorded calls, and cleanup DELETEs go to a
127.0.0.1 stub. Negative cases assert the rejection itself, so a healthy run reports
``product pass`` for every case.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Iterator

import httpx
import pytest

from qa.argus.cleanup import cleanup_created_resources
from qa.argus.errors import ArgusCleanupError, ArgusPrerequisiteError, ArgusRestoreError
from qa.argus.fault_injector import Fault, FaultInjector, FaultScope, fault_active, run
from qa.argus.repetition import reproduce
from qa.argus.stub_server import StubServer

pytestmark = pytest.mark.contract_smoke

SECRET = "argus-never-print-me"


def recorded_fault(calls: list[str], fail: tuple[str, ...] = (), scope: FaultScope = "client") -> Fault:
    """A fault whose hooks append to ``calls``; the hooks named in ``fail`` raise."""

    def hook(name: str) -> Callable[[], None]:
        def step() -> None:
            calls.append(name)
            if name in fail:
                raise RuntimeError(f"{name} failed with {SECRET}")

        return step

    return Fault(name="api-unavailable", scope=scope, inject=hook("inject"), restore=hook("restore"), verify_restored=hook("verify"))


@pytest.fixture
def stub() -> Iterator[StubServer]:
    with StubServer.start() as server:
        yield server


@pytest.fixture
def http(stub: StubServer) -> Iterator[httpx.Client]:
    # trust_env=False: a host proxy setting must never route loopback traffic elsewhere.
    with httpx.Client(base_url=stub.url, timeout=10.0, trust_env=False) as client:
        yield client


def test_fault_injector_restores_and_verifies_after_a_passing_body():
    calls: list[str] = []
    injector = FaultInjector()

    def body() -> str:
        calls.append("body")
        assert injector.active and fault_active()
        return "body-result"

    assert injector.run(recorded_fault(calls), body) == "body-result"
    assert calls == ["inject", "body", "restore", "verify"]
    assert not injector.active and not fault_active()


def test_fault_injector_restores_after_a_failing_body_and_reraises_the_body_error():
    calls: list[str] = []

    def body() -> None:
        calls.append("body")
        raise TypeError("assertion in the body")

    with pytest.raises(TypeError):
        run(recorded_fault(calls), body)
    assert calls == ["inject", "body", "restore", "verify"]
    assert not fault_active()


def test_reproduce_repeats_the_attempt_and_stops_at_the_first_violation():
    attempts: list[int] = []
    reproduce(3, lambda: attempts.append(1))
    assert len(attempts) == 3

    def attempt() -> None:
        attempts.append(1)
        assert len(attempts) < 5, "synthetic violation"

    with pytest.raises(AssertionError, match="synthetic violation"):
        reproduce(9, attempt)
    assert len(attempts) == 5
    for invalid in (0, 201, True, 2.0):
        with pytest.raises(ValueError, match="1..200"):
            reproduce(invalid, attempt)  # type: ignore[arg-type]


def test_fault_injector_restores_a_partial_injection():
    calls: list[str] = []
    with pytest.raises(RuntimeError, match="inject failed"):
        run(recorded_fault(calls, ("inject",)), lambda: calls.append("body"))
    assert calls == ["inject", "restore", "verify"]


def test_a_failed_restore_or_verification_is_argus_restore_error_and_outranks_the_body_error():
    for failing, skipped in (("restore", ["verify"]), ("verify", [])):
        calls: list[str] = []

        def body() -> None:
            raise TypeError("assertion in the body")

        with pytest.raises(ArgusRestoreError) as caught:
            run(recorded_fault(calls, (failing,)), body)
        assert calls == [call for call in ["inject", "restore", "verify"] if call not in skipped]
        assert SECRET not in str(caught.value)
        assert isinstance(caught.value.__cause__, RuntimeError)
        assert any("TypeError" in note for note in getattr(caught.value, "__notes__", []))
        assert not fault_active()


def test_a_server_fault_needs_argus_fault_injection_authorized_before_anything_is_injected(monkeypatch: pytest.MonkeyPatch):
    for value in (None, "", "yes"):
        if value is None:
            monkeypatch.delenv("ARGUS_FAULT_INJECTION", raising=False)
        else:
            monkeypatch.setenv("ARGUS_FAULT_INJECTION", value)
        calls: list[str] = []
        with pytest.raises(ArgusPrerequisiteError):
            run(recorded_fault(calls, scope="server"), lambda: None)
        assert calls == []
    monkeypatch.setenv("ARGUS_FAULT_INJECTION", "authorized")
    calls = []
    run(recorded_fault(calls, scope="server"), lambda: None)
    assert calls == ["inject", "restore", "verify"]


def test_settle_restores_a_fault_the_test_left_active_exactly_once():
    calls: list[str] = []
    injector = FaultInjector()
    injected, release = threading.Event(), threading.Event()
    errors: list[BaseException] = []

    def body() -> None:
        injected.set()
        release.wait(10)

    def abandoned() -> None:
        try:
            injector.run(recorded_fault(calls), body)
        except BaseException as error:  # noqa: BLE001 - reported through the assertion below
            errors.append(error)

    worker = threading.Thread(target=abandoned)
    worker.start()
    assert injected.wait(10)
    injector.settle()
    assert calls == ["inject", "restore", "verify"]
    assert not injector.active
    release.set()
    worker.join(10)
    assert not worker.is_alive() and errors == []
    assert calls == ["inject", "restore", "verify"]


def test_settle_raises_the_restore_failure_of_an_abandoned_fault():
    calls: list[str] = []
    injector = FaultInjector()
    injected, release = threading.Event(), threading.Event()
    errors: list[BaseException] = []

    def abandoned() -> None:
        try:
            injector.run(recorded_fault(calls, ("verify",)), lambda: (injected.set(), release.wait(10)))
        except BaseException as error:  # noqa: BLE001 - asserted below
            errors.append(error)

    worker = threading.Thread(target=abandoned)
    worker.start()
    assert injected.wait(10)
    with pytest.raises(ArgusRestoreError):
        injector.settle()
    release.set()
    worker.join(10)
    # run() sees the same restore outcome instead of restoring a second time.
    assert [type(error) for error in errors] == [ArgusRestoreError]
    assert calls == ["inject", "restore", "verify"]


def test_an_invalid_fault_is_refused_before_it_is_injected():
    calls: list[str] = []
    valid = recorded_fault(calls)
    with pytest.raises(ValueError):
        Fault(name="Not A Token", scope="client", inject=valid.inject, restore=valid.restore, verify_restored=valid.verify_restored)
    with pytest.raises(ValueError):
        Fault(name="api-unavailable", scope="global", inject=valid.inject, restore=valid.restore, verify_restored=valid.verify_restored)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        Fault(name="api-unavailable", scope="client", inject=valid.inject, restore=None, verify_restored=valid.verify_restored)  # type: ignore[arg-type]
    assert calls == []


def test_created_resources_cleanup_attempts_every_delete_newest_first_and_counts_failures(stub: StubServer, http: httpx.Client):
    stub.load([
        {"id": "already-gone", "request": {"method": "DELETE", "path": "/items/1"}, "response": {"status": 404}},
        {"id": "deleted", "request": {"method": "DELETE", "path": "/items/2"}, "response": {"status": 204}},
        {"id": "refused", "request": {"method": "DELETE", "path": "/items/3"}, "response": {"status": 409, "body": {"detail": SECRET}}},
        {"id": "accepted", "request": {"method": "DELETE", "path": "/items/4"}, "response": {"status": 202}},
        {"id": "ok", "request": {"method": "DELETE", "path": "/items/5"}, "response": {"status": 200}},
    ])
    closed = httpx.Client(base_url=stub.url, timeout=10.0, trust_env=False)
    closed.close()
    created = [
        (http, "/items/1"),
        (http, "/items/2"),
        (closed, "/items/6"),
        (http, "/items/3"),
        (http, "/items/4"),
        (http, "/items/5"),
    ]
    with pytest.raises(ArgusCleanupError) as caught:
        cleanup_created_resources(created)
    assert str(caught.value) == "cleanup failed for 2 resource(s)"
    assert [record["path"] for record in stub.requests()] == ["/items/5", "/items/4", "/items/3", "/items/2", "/items/1"]


def test_created_resources_cleanup_passes_when_every_delete_succeeds_or_finds_nothing(stub: StubServer, http: httpx.Client):
    stub.load([
        {"id": "deleted", "request": {"method": "DELETE", "path": "/items/1"}, "response": {"status": 204}},
        {"id": "already-gone", "request": {"method": "DELETE", "path": "/items/2"}, "response": {"status": 404}},
    ])
    cleanup_created_resources([(http, "/items/1"), (http, "/items/2")])
    assert len(stub.requests()) == 2
