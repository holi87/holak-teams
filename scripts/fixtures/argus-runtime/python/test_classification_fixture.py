"""Classification fixture for the Python outcome adapter (scripts/smoke-argus-runtime-python.sh).

Each test pins one SD-5/SD-6 rule of qa.argus_plugin. Everything is target-independent:
network cases use a closed loopback port or a local listener that never answers.
"""
import os
import socket

import httpx
import pytest
from playwright.sync_api import Error as PlaywrightError

from qa.argus import (
    ArgusCleanupError,
    ArgusCounterfactualError,
    ArgusRestoreError,
    require_env,
)

pytestmark = pytest.mark.contract_smoke


@pytest.fixture
def broken_setup():
    raise RuntimeError("fixture setup failed")


@pytest.fixture
def unreachable_browser_setup():
    raise PlaywrightError("page.goto: net::ERR_CONNECTION_REFUSED")


@pytest.fixture
def failing_cleanup():
    yield
    raise ArgusCleanupError("created resource could not be deleted")


@pytest.fixture
def silent_port():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    yield listener.getsockname()[1]
    listener.close()


# Regression provenance and the SD-6 defect lifecycle.


@pytest.mark.regression
@pytest.mark.bug("ATA-001")
def test_regression_assertion_reproduces():
    assert 1 + 1 == 3, "spec-correct value"


@pytest.mark.regression
@pytest.mark.bug("BUG-0001")
def test_regression_passing_body():
    assert True


@pytest.mark.regression
@pytest.mark.bug("ATA-001")
def test_regression_runtime_skip():
    pytest.skip("a regression test must never skip")


@pytest.mark.regression
@pytest.mark.bug("XYZ-999")
def test_regression_unknown_provenance():
    assert False


# Intermittent defect BUG-0003: p = 2/4, so the 95% bound is 5 repetitions.


@pytest.mark.regression
@pytest.mark.bug("ATA-003")
@pytest.mark.repetition(5)
def test_intermittent_unreproduced():
    for _ in range(5):
        assert True


@pytest.mark.regression
@pytest.mark.bug("BUG-0003")
@pytest.mark.repetition(7)
def test_intermittent_reproduces():
    for attempt in range(7):
        assert attempt < 3, "violation observed on a later repetition"


@pytest.mark.regression
@pytest.mark.bug("ATA-003")
@pytest.mark.repetition(2)
def test_intermittent_below_bound():
    assert True


# SD-5 primary classification.


def test_plain_pass():
    assert True


def test_pytest_raises_not_raised():
    with pytest.raises(ValueError):
        int("7")


def test_uncaught_type_error():
    None + 1  # noqa: B018 - the TypeError is the point


def test_fixture_setup_failure(broken_setup):
    assert True


def test_unreachable_in_setup(unreachable_browser_setup):
    assert True


def test_cleanup_failure_after_passing_body(failing_cleanup):
    assert True


def test_cleanup_failure_after_assertion(failing_cleanup):
    assert False


def test_runtime_skip():
    pytest.skip("runtime skip")


@pytest.mark.skip(reason="declared skip")
def test_declared_skip():
    assert True


@pytest.mark.skipif(os.environ.get("ARGUS_FIXTURE_UNSET_FLAG") is None, reason="declared conditional")
def test_declared_conditional():
    assert True


@pytest.mark.xfail(reason="expected failures are forbidden")
def test_declared_expected_failure():
    assert False


@pytest.mark.xfail(reason="an unexpected pass is still an expected-failure declaration")
def test_unexpected_pass():
    assert True


@pytest.mark.xfail(strict=True, reason="strict xpass fails natively")
def test_strict_unexpected_pass():
    assert True


def test_connection_refused():
    httpx.get("http://127.0.0.1:9/", timeout=5)


def test_read_timeout(silent_port):
    httpx.get(f"http://127.0.0.1:{silent_port}/", timeout=0.5)


def test_missing_prerequisite():
    require_env("ARGUS_FIXTURE_MISSING_PREREQUISITE")


def test_fault_restore_failure():
    raise ArgusRestoreError("injected fault is still active")


def test_counterfactual_unmatched_request():
    raise ArgusCounterfactualError("no stub exchange matched the request")


def test_playwright_api_failure():
    raise PlaywrightError("locator.click: element is not attached")


# SD-2 case ids: sanitization, collision suffixes, and the long-id digest.


@pytest.mark.parametrize("label", ["alpha beta", "alpha-beta", "zażółć", "x" * 240])
def test_parametrized_ids(label):
    assert label


def test_zażółć_title():
    assert True
