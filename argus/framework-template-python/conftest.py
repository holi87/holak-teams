"""Root fixtures — the framework's dependency injection.

Specs declare what they need; setup/teardown lives here, never inline in tests.
Layers: tests -> (these fixtures) -> qa.api_client / qa.pages -> qa.config.

What this provides:
  * api_as(role)        authenticated httpx.Client factory (token cached per API and role)
  * anon_client         unauthenticated httpx.Client (negative / public-route tests)
  * created_resources   teardown list — POST-created entities get DELETEd after the test;
                        any failed DELETE fails the test as ArgusCleanupError
  * fault_injector      runs a resilience fault around one body and always restores it
                        (qa.argus.fault_injector); its teardown settles abandoned faults
  * storage_state       session-scoped UI auth (once per run) -> .auth/user.json
  * browser_context_args overridden so UI contexts use UI_URL + the saved auth state
  * console_guard        fails a UI test on console errors / 5xx responses (UI lane only)
  * _argus_stub, _argus_counterfactual  autouse, inert unless ARGUS_EVIDENCE_PASS is cf-*:
                         then every client reaches a 127.0.0.1 stub serving the bug's
                         counterfactual fixture instead of the target (SD-10)

Determinism: NO retries, NO rerun plugin. Flakiness is fixed at the source.
"""
from __future__ import annotations

import sys
import os
from pathlib import Path
from typing import Callable, Iterator

import httpx
import pytest

_ROOT = Path(__file__).parent
# Make the `qa` package importable regardless of pytest's pythonpath timing.
sys.path.insert(0, str(_ROOT / "src"))

from qa.api_client import login, make_client  # noqa: E402
from qa.argus import counterfactual  # noqa: E402
from qa.argus.cleanup import cleanup_created_resources  # noqa: E402
from qa.argus.errors import ArgusCounterfactualError  # noqa: E402
from qa.argus.fault_injector import FaultInjector, fault_active  # noqa: E402
from qa.argus.stub_server import StubServer  # noqa: E402
from qa.config import ENV  # noqa: E402

# Argus outcome adapter: inert unless scripts/runner-lib.sh exports ARGUS_RUNNER_MODE.
pytest_plugins = ["qa.argus_plugin"]

AUTH_DIR = Path(os.environ.get("ARGUS_AUTH_DIRECTORY", _ROOT / ".auth"))
USER_STATE = AUTH_DIR / "user.json"


def pytest_configure(config: pytest.Config) -> None:
    # Ensure the aggregated-report destinations exist even on a direct `pytest` run.
    (_ROOT / "reports" / "html").mkdir(parents=True, exist_ok=True)


# ------------------------------------------------------------------ counterfactual
# Counterfactual evidence (TEMPLATE-CONTRACT.md SD-10). Inert unless ARGUS_EVIDENCE_PASS
# starts with cf-. Then each session (each xdist worker) runs one 127.0.0.1 stub, and each
# test bound to a bug with a fixture runs against the pass's variant of
# solution/counterfactual/<bug>.json: current_api_url(), and with it make_client, login,
# api_as and anon_client, points at the stub, and tests/ui/conftest.py routes the browser's
# API requests to it. No request reaches the target API; an undeclared one fails the test
# with ArgusCounterfactualError. Every other test skips with a sentinel reason the outcome
# adapter recognises.


def _counterfactual_pass() -> str | None:
    evidence_pass = os.environ.get("ARGUS_EVIDENCE_PASS", "")
    return evidence_pass if evidence_pass.startswith("cf-") else None


@pytest.fixture(scope="session", autouse=True)
def _argus_stub() -> Iterator[StubServer | None]:
    """One loopback counterfactual stub per session in a cf-* pass; None otherwise."""
    if _counterfactual_pass() is None:
        yield None
        return
    stub = StubServer.start()
    try:
        yield stub
    finally:
        stub.stop()


@pytest.fixture(autouse=True)
def _argus_counterfactual(
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
    _argus_stub: StubServer | None,
) -> Iterator[counterfactual.CounterfactualContext | None]:
    """Load this test's counterfactual variant into the stub, or skip with a sentinel reason."""
    evidence_pass = _counterfactual_pass()
    if _argus_stub is None or evidence_pass is None:
        yield None
        return
    # The stub outlives the test: drop the previous test's exchanges and request log.
    _argus_stub.load([])
    root = Path(request.config.rootpath)
    bug_id = counterfactual.bound_bug(root, request.node)
    # The same validation as the inventory plan, contract check included, so a fixture the
    # plan lists as invalid never runs.
    fixture = counterfactual.load_fixture(root, bug_id) if bug_id else None
    if isinstance(fixture, counterfactual.Exempt) and evidence_pass == "cf-correct":
        pytest.skip(f"{counterfactual.EXEMPT_PREFIX}{fixture.reason}")
    # Unbound tests, missing or invalid fixtures, exempt bugs in tamper passes, tamper passes
    # beyond the fixture's tampers, and malformed pass names have no variant; the evidence
    # gate reports missing and invalid fixtures.
    variant = counterfactual.NO_VARIANT
    if isinstance(fixture, counterfactual.CounterfactualFixture) and counterfactual.is_counterfactual_pass(evidence_pass):
        variant = counterfactual.variant_for(fixture, evidence_pass)
    if bug_id is None or not isinstance(fixture, counterfactual.CounterfactualFixture) or not isinstance(variant, counterfactual.CounterfactualVariant):
        pytest.skip(counterfactual.NOT_APPLICABLE)
    _argus_stub.load(counterfactual.variant_exchanges(fixture, variant))
    monkeypatch.setenv("ARGUS_COUNTERFACTUAL_API_URL", _argus_stub.url)
    yield counterfactual.CounterfactualContext(bug_id=bug_id, variant=variant.id, stub=_argus_stub)
    unmatched = _argus_stub.unmatched()
    _argus_stub.load([])
    if unmatched:
        listed = ", ".join(f"{record['method']} {record['path']}" for record in unmatched[:5])
        raise ArgusCounterfactualError(
            f"the counterfactual stub received {len(unmatched)} request(s) the fixture does not declare: {listed}"
        )


# --------------------------------------------------------------------------- API


@pytest.fixture
def api_as() -> Iterator[Callable[[str], httpx.Client]]:
    """Factory: ``client = api_as("user")`` -> bearer-authed httpx.Client.

    Every client handed out is closed in teardown. Login is cached per API and
    role (one auth per run), so calling this repeatedly is cheap.
    """
    clients: list[httpx.Client] = []

    def factory(role: str) -> httpx.Client:
        client = make_client(token=login(role))
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.close()


@pytest.fixture
def anon_client() -> Iterator[httpx.Client]:
    """Unauthenticated client against the API base URL (public / negative routes)."""
    client = make_client()
    yield client
    client.close()


@pytest.fixture
def created_resources(
    api_as: Callable[[str], httpx.Client],
    anon_client: httpx.Client,
) -> Iterator[list[tuple[httpx.Client, str]]]:
    """Register (client, path) of POST-created entities; teardown DELETEs every one, newest first.

    Use when the app ships no reset command — never rely on accumulating unique data alone.
    Every DELETE is attempted; a status outside 200/202/204/404 (404: already gone) or an
    exception fails the test as ArgusCleanupError (``cleanup-failed``), never a warning. It
    depends on api_as and anon_client so every client they hand out outlives this teardown.
    """
    created: list[tuple[httpx.Client, str]] = []
    yield created
    cleanup_created_resources(created)


@pytest.fixture
def fault_injector() -> Iterator[FaultInjector]:
    """Runs a fault around one body and always restores it: ``fault_injector.run(Fault(...), body)``.

    A failed or unverifiable restore is ArgusRestoreError (``fault-restore-failed``); a server
    fault needs ARGUS_FAULT_INJECTION=authorized. Teardown restores any fault still recorded.
    """
    injector = FaultInjector()
    yield injector
    injector.settle()


# ---------------------------------------------------------------------------- UI
# These fixtures only activate when a test requests `page`/`context` (UI lane),
# so API-only runs never launch a browser or attempt a login.


@pytest.fixture(scope="session")
def storage_state(browser) -> str:  # noqa: ANN001 - `browser` is pytest-playwright's fixture
    """UI auth once PER RUN: re-authenticate a single time each session and overwrite the
    saved storage_state, then reuse it for every UI test in that run.

    Matches the TS reference's `setup` project, which re-runs auth on every invocation and
    overwrites .auth/user.json — so a fresh run never silently reuses a stale/expired
    session cached by an earlier run. (`authenticate` overwrites the file in place.)
    """
    # Lazy import keeps tests/setup off the path for non-UI runs.
    sys.path.insert(0, str(_ROOT / "tests" / "setup"))
    from auth_setup import authenticate  # noqa: E402,PLC0415

    authenticate(browser, "user", str(USER_STATE))
    return str(USER_STATE)


@pytest.fixture
def browser_context_args(browser_context_args, storage_state):  # noqa: ANN001
    """Every UI context starts at UI_URL and already authenticated (saved storage_state)."""
    return {
        **browser_context_args,
        "base_url": ENV.ui_url,
        "storage_state": storage_state,
    }


@pytest.fixture
def console_guard(page) -> Iterator[None]:  # noqa: ANN001 - pytest-playwright `page`
    """Fail a UI test on console errors or 5xx responses — cheap, high-yield web signal.

    Wired in as autouse for the UI lane via tests/ui/conftest.py; the resilience example
    requests it explicitly. Errors and 5xx responses observed while a fault_injector fault is
    active (qa.argus.fault_injector.fault_active) are the fault's intended effect.
    ADAPT-ME: add known-noise patterns to `allow` (3rd-party scripts, expected probes).
    """
    import re

    allow: list[re.Pattern[str]] = [
        # re.compile(r"favicon\.ico"),
    ]
    violations: list[str] = []

    def on_console(msg) -> None:  # noqa: ANN001
        if msg.type == "error" and not fault_active() and not any(p.search(msg.text) for p in allow):
            violations.append(f"console.error: {msg.text}")

    def on_response(response) -> None:  # noqa: ANN001
        if response.status >= 500 and not fault_active() and not any(p.search(response.url) for p in allow):
            violations.append(
                f"HTTP {response.status}: {response.request.method} {response.url}"
            )

    page.on("console", on_console)
    page.on("response", on_response)
    yield
    page.remove_listener("console", on_console)
    page.remove_listener("response", on_response)
    if violations:
        raise AssertionError("console_guard caught silent failures:\n" + "\n".join(violations))
