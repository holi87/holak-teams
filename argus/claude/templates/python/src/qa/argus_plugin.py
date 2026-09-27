"""Argus outcome adapter for pytest (template contract v2, RUNNER-CONTRACT.md SD-1 to SD-7).

Loaded by the root conftest (``pytest_plugins = ["qa.argus_plugin"]``). It is inert — no
files, no events — unless ``ARGUS_RUNNER_MODE`` names one of the four runner modes, which
only ``scripts/runner-lib.sh`` exports.

* ``ARGUS_INVENTORY_ONLY=1`` is a collect-only pass (forced to ``--collect-only``, so no test
  body runs). From the full collection, before any deselection, it writes
  ``reports/test-inventory.tsv`` (SD-3), ``reports/expected-bugs.txt`` (SD-4) and
  ``reports/counterfactual-plan.tsv`` (SD-10), and emits the ledger events.
* Otherwise every test that runs gets one primary event composed from its setup, call and
  teardown reports (SD-5, SD-6), plus a ``.cleanup`` event when teardown fails next to a
  non-pass primary. ``ARGUS_EVIDENCE_PASS`` selects ``live`` (default) or ``repeat`` and, in
  defect-evidence only, ``cf-correct`` or ``cf-tamper-<k>``. In those counterfactual passes
  the case suffix is ``.cf-correct`` or ``.cf-<tamperId>`` (recomputed from the bug's
  fixture), and a skip with a counterfactual sentinel reason reports nothing, or in
  cf-correct the ``.cf`` exemption event (qa.argus.counterfactual, imported lazily).

Events go only through ``bash <root>/scripts/outcome-event.sh`` (atomic, so safe under
pytest-xdist workers) and carry sanitized case ids and closed-vocabulary reasons — never
titles, messages, URLs or bodies. Emission failures are listed in
``reports/argus-adapter-errors/<pid>.txt``; the controller process writes
``reports/argus-adapter-status.txt`` (``ok <events>`` or ``error <failures>``) and turns a
green native run red when any failure occurred.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest

try:
    import httpx
except ImportError:  # pragma: no cover - httpx is a template dependency
    httpx = None  # type: ignore[assignment]

MODES = ("baseline", "defect-evidence", "candidate-regression", "full-suite")
PASSES = {"live": "", "repeat": ".repeat"}
# Counterfactual passes (SD-10) exist only in defect-evidence; their suffix depends on the fixture.
COUNTERFACTUAL_PASS = re.compile(r"cf-(correct|tamper-[1-9][0-9]*)")
LANE_MARKERS = {
    "api": "api", "ui": "ui", "perf": "perf", "security": "security", "db": "db",
    "resilience": "resilience", "contract_smoke": "contract-smoke",
}
LEDGER_SCHEMAS = {"argus/bug-ledger@1": 1, "argus/bug-ledger@2": 2}
UNSAFE_RUN = re.compile(r"[^A-Za-z0-9_.:-]+")
UNSAFE_SOURCE_RUN = re.compile(r"[^A-Za-z0-9_./:-]+")
PROVENANCE_TOKEN = re.compile(r"^(BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4})$")
CANONICAL_ID = re.compile(r"^BUG-[0-9]{4}$")
MAX_CASE_ID = 200
MAX_REPETITION = 200

# Outcome = (category, status, reason). PRODUCT and PASSED are resolved through SD-6.
PRODUCT = ("product", "fail", "assertion")
PASSED = ("product", "pass", "passed")
ARGUS_ERRORS = {
    "ArgusCleanupError": ("automation", "fail", "cleanup-failed"),
    "ArgusPrerequisiteError": ("infrastructure", "fail", "prerequisite-missing"),
    "ArgusRestoreError": ("infrastructure", "fail", "fault-restore-failed"),
    "ArgusCounterfactualError": ("automation", "fail", "counterfactual-unmatched-request"),
}
TARGET_UNREACHABLE = ("infrastructure", "fail", "target-unreachable")
TEST_TIMEOUT = ("automation", "fail", "test-timeout")
PLAYWRIGHT_FAILED = ("automation", "fail", "playwright-api-failed")
UNCAUGHT = ("automation", "fail", "uncaught-error")
FIXTURE_FAILED = ("automation", "fail", "fixture-failed")
CLEANUP_FAILED = ("automation", "fail", "cleanup-failed")
INTERRUPTED = ("infrastructure", "fail", "test-interrupted")
EXPECTED_FAILURE = ("policy", "denied", "expected-failure-forbidden")
REPETITION_INVALID = ("policy", "denied", "repetition-invalid")


@dataclass(frozen=True)
class Ledger:
    """The SD-4 view of solution/bug-ledger.json: status is ok, missing, or invalid."""

    status: str
    aliases: dict[str, str] = field(default_factory=dict)
    confirmed: tuple[str, ...] = ()
    rates: dict[str, float | None] = field(default_factory=dict)


@dataclass(frozen=True)
class CaseMeta:
    """Everything the inventory and the events need to know about one collected test."""

    case_id: str
    lane: str
    regression: bool
    quarantine: bool
    bug_ids: tuple[str, ...]
    unresolved: tuple[str, ...]
    disabled: str
    source: str
    repetition: int
    repetition_valid: bool

    @property
    def bug(self) -> str:
        """The single canonical bug of a regression test, or '-' when there is not exactly one."""
        return self.bug_ids[0] if self.regression and len(self.bug_ids) == 1 else "-"


@dataclass
class Phase:
    outcome: str
    error: BaseException | None
    expected_failure: bool


@dataclass
class AdapterState:
    root: Path
    mode: str
    evidence_pass: str
    inventory_only: bool
    worker: bool
    outcome_file: Path
    ledger: Ledger
    events: int = 0
    failures: int = 0
    collection_errors: int = 0
    workers: dict[str, dict[str, int] | None] = field(default_factory=dict)
    fixtures: dict[str, Any] = field(default_factory=dict)

    @property
    def reports(self) -> Path:
        return self.root / "reports"

    @property
    def counterfactual(self) -> bool:
        return COUNTERFACTUAL_PASS.fullmatch(self.evidence_pass) is not None

    @property
    def pass_supported(self) -> bool:
        """live and repeat; cf-correct and cf-tamper-<k> only in defect-evidence."""
        return self.evidence_pass in PASSES or (self.counterfactual and self.mode == "defect-evidence")

    def emit(self, case_id: str, outcome: tuple[str, str, str], expected: str, lifecycle: str, bug: str) -> None:
        category, status, reason = outcome
        fields = [case_id, category, status, expected, lifecycle, bug, reason]
        env = {**os.environ, "ARGUS_OUTCOME_FILE": str(self.outcome_file)}
        try:
            completed = subprocess.run(
                ["bash", str(self.root / "scripts" / "outcome-event.sh"), *fields],
                cwd=self.root, env=env, capture_output=True, timeout=60, check=False,
            )
            detail = f"exit-{completed.returncode}"
            ok = completed.returncode == 0
        except (OSError, subprocess.SubprocessError) as exc:
            detail, ok = type(exc).__name__, False
        if ok:
            self.events += 1
        else:
            self.record_failure(case_id, reason, detail)

    def record_failure(self, case_id: str, reason: str, detail: str) -> None:
        """Count one adapter failure and list it (safe tokens only) for the operator."""
        self.failures += 1
        try:
            errors = self.reports / "argus-adapter-errors"
            errors.mkdir(parents=True, exist_ok=True)
            with open(errors / f"{os.getpid()}.txt", "a", encoding="utf-8") as handle:
                handle.write(f"{case_id}\t{reason}\t{detail}\n")
        except OSError:
            pass  # the failure is still counted and reported through the status file


STATE_KEY = pytest.StashKey[AdapterState]()
META_KEY = pytest.StashKey[CaseMeta]()
PHASES_KEY = pytest.StashKey[dict]()
DONE_KEY = pytest.StashKey[bool]()


# ------------------------------------------------------------------------------ hooks


@pytest.hookimpl(tryfirst=True)
def pytest_configure(config: pytest.Config) -> None:
    mode = os.environ.get("ARGUS_RUNNER_MODE", "")
    if mode not in MODES:
        return  # inert: no state, no files, no events
    root = Path(config.rootpath)
    outcome_file = Path(os.environ.get("ARGUS_OUTCOME_FILE") or root / "reports" / "outcomes.raw.tsv")
    state = AdapterState(
        root=root,
        mode=mode,
        evidence_pass=os.environ.get("ARGUS_EVIDENCE_PASS") or "live",
        inventory_only=os.environ.get("ARGUS_INVENTORY_ONLY") == "1",
        worker=hasattr(config, "workerinput"),
        outcome_file=outcome_file if outcome_file.is_absolute() else root / outcome_file,
        ledger=load_ledger(root / "solution" / "bug-ledger.json"),
    )
    config.stash[STATE_KEY] = state
    if state.inventory_only:
        # SD-1: the inventory pass runs no test body. Forcing collect-only here also keeps
        # pytest-xdist (trylast configure) from starting workers.
        config.option.collectonly = True


@pytest.hookimpl(tryfirst=True)
def pytest_sessionstart(session: pytest.Session) -> None:
    state = session.config.stash.get(STATE_KEY, None)
    if state is None or state.worker:
        return
    # The controller starts every run from a clean slate so a stale status, error list, or
    # inventory can never describe this run. Workers start later (xdist's trylast sessionstart).
    stale_files = ["argus-adapter-status.txt"]
    if state.inventory_only:
        stale_files += ["test-inventory.tsv", "expected-bugs.txt", "counterfactual-plan.tsv"]
    try:
        for name in stale_files:
            (state.reports / name).unlink(missing_ok=True)
        errors = state.reports / "argus-adapter-errors"
        if errors.is_dir():
            for stale in errors.glob("*.txt"):
                stale.unlink(missing_ok=True)
    except OSError:
        state.record_failure("-", "adapter-reset-failed", "OSError")
    if not state.inventory_only and not state.pass_supported:
        state.record_failure("-", "unsupported-evidence-pass", "no-events")


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(session: pytest.Session, config: pytest.Config, items: list[pytest.Item]) -> None:
    state = config.stash.get(STATE_KEY, None)
    if state is None:
        return
    # tryfirst: this sees the full collection before -m/-k deselection, so case ids and
    # collision suffixes are identical in the inventory, a filtered run, and every xdist worker.
    # Failed collect reports are already counted in session.testsfailed at this point.
    state.collection_errors = session.testsfailed
    try:
        metas = describe_items(items, state.ledger)
    except Exception as exc:  # noqa: BLE001 - never turn an adapter defect into a collection crash
        state.record_failure("-", "adapter-describe-failed", type(exc).__name__)
        if state.inventory_only:
            (state.reports / "test-inventory.tsv").unlink(missing_ok=True)
            (state.reports / "counterfactual-plan.tsv").unlink(missing_ok=True)
        return
    for item, meta in zip(items, metas):
        item.stash[META_KEY] = meta
    if state.inventory_only:
        write_inventory(state, metas)


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_protocol(item: pytest.Item, nextitem: pytest.Item | None):
    state = item.config.stash.get(STATE_KEY, None)
    if state is None or state.inventory_only:
        return (yield)
    try:
        return (yield)
    except BaseException:
        # KeyboardInterrupt or pytest.exit() escaped mid-test: no teardown report follows.
        if not item.stash.get(DONE_KEY, False):
            try:
                emit_outcome(state, item, meta_for(item, state), INTERRUPTED)
            except Exception as exc:  # noqa: BLE001 - never mask the interruption itself
                state.record_failure(sanitize(item.nodeid) or "-", "adapter-compose-failed", type(exc).__name__)
        raise


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]):
    # tryfirst makes this the outermost wrapper, so the report already carries the
    # xfail/xpass rewrite of pytest's skipping plugin.
    report = yield
    state = item.config.stash.get(STATE_KEY, None)
    if state is None or state.inventory_only:
        return report
    try:
        phases = item.stash.setdefault(PHASES_KEY, {})
        phases[report.when] = Phase(
            outcome=report.outcome,
            error=call.excinfo.value if call.excinfo is not None else None,
            expected_failure=hasattr(report, "wasxfail") or strict_xpass(report),
        )
        if report.when == "teardown":
            item.stash[DONE_KEY] = True
            del item.stash[PHASES_KEY]
            compose(state, item, phases)
    except Exception as exc:  # noqa: BLE001 - the adapter must never break the native run
        state.record_failure(sanitize(item.nodeid) or "-", "adapter-compose-failed", type(exc).__name__)
    return report


@pytest.hookimpl(optionalhook=True)
def pytest_testnodedown(node: Any, error: object | None) -> None:
    """xdist controller: collect each worker's counters (a worker lost before reporting fails closed)."""
    state = node.config.stash.get(STATE_KEY, None)
    if state is None:
        return
    worker_id = str(getattr(node, "workerinput", {}).get("workerid", id(node)))
    totals = (getattr(node, "workeroutput", None) or {}).get("argus_adapter")
    if isinstance(totals, dict):
        state.workers[worker_id] = totals
    else:
        state.workers.setdefault(worker_id, None)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    state = session.config.stash.get(STATE_KEY, None)
    if state is None:
        return
    if state.worker:
        session.config.workeroutput["argus_adapter"] = {"events": state.events, "failures": state.failures}
        return
    for worker_id, totals in sorted(state.workers.items()):
        if totals is None:
            state.record_failure("-", "worker-lost", worker_id)
        else:
            state.events += int(totals.get("events", 0))
            state.failures += int(totals.get("failures", 0))
    line = f"error {state.failures}" if state.failures else f"ok {state.events}"
    try:
        atomic_write(state.reports / "argus-adapter-status.txt", f"{line}\n")
    except OSError:
        state.failures += 1
    if state.failures:
        sys.stderr.write(f"argus adapter: {state.failures} failure(s); see reports/argus-adapter-errors/\n")
        if session.exitstatus == pytest.ExitCode.OK:
            session.exitstatus = pytest.ExitCode.TESTS_FAILED


# ------------------------------------------------------------------- classification


def compose(state: AdapterState, item: pytest.Item, phases: dict[str, Phase]) -> None:
    """Turn the three phase reports of one test into its primary and optional cleanup event."""
    meta = meta_for(item, state)
    setup, call, teardown = phases.get("setup"), phases.get("call"), phases.get("teardown")
    cleanup = teardown is not None and teardown.outcome == "failed"
    if any(phase.expected_failure for phase in phases.values()):
        primary = EXPECTED_FAILURE
    elif setup is None:
        return
    elif setup.outcome == "failed":
        primary = classify_setup(setup.error)
    elif setup.outcome == "skipped":
        if state.counterfactual and counterfactual_skip(state, meta, setup.error):
            return
        primary = skip_outcome(meta)
    elif call is None:
        return  # --setup-only / --setup-plan: no test body ran
    elif state.counterfactual and cleanup and unmatched_request(teardown.error):
        # An undeclared request got the stub's 501, so the body observed neither the correct
        # response nor the tamper: its verdict proves nothing either way (SD-10). Only an
        # exception group (another finalizer failed as well) still adds the cleanup event.
        primary = ARGUS_ERRORS["ArgusCounterfactualError"]
        cleanup = isinstance(teardown.error, BaseExceptionGroup)
    elif call.outcome == "passed":
        primary = PASSED
    elif call.outcome == "skipped":
        if state.counterfactual and counterfactual_skip(state, meta, call.error):
            return
        primary = skip_outcome(meta)
    else:
        primary = classify_call(call.error)
    if cleanup and primary == PASSED:
        # The body passed but the test did not: the teardown failure is the outcome.
        primary, cleanup = classify_teardown(teardown.error), False
    if not meta.repetition_valid:
        primary = REPETITION_INVALID
    emit_outcome(state, item, meta, primary)
    if cleanup:
        emit_outcome(state, item, meta, classify_teardown(teardown.error), suffix=".cleanup")


def emit_outcome(state: AdapterState, item: pytest.Item, meta: CaseMeta, outcome: tuple[str, str, str], suffix: str = "") -> None:
    if not state.pass_supported:
        return  # counted once at session start; emitting live-pass semantics would lie
    case_id = meta.case_id + pass_suffix(state, meta) + suffix
    if outcome in (PRODUCT, PASSED):
        category, status, expected, lifecycle, bug, reason = product_event(state, meta, outcome == PASSED)
        state.emit(case_id, (category, status, reason), expected, lifecycle, bug)
    else:
        state.emit(case_id, outcome, "false", "n/a", meta.bug)


def product_event(state: AdapterState, meta: CaseMeta, passed: bool) -> tuple[str, str, str, str, str, str]:
    """SD-6: (category, status, expected, lifecycle, bug, reason) for a product pass or fail."""
    bug = meta.bug
    if bug == "-":
        # Not a regression, or its provenance does not join exactly one ledger entry (the
        # inventory gate reports that): no defect lifecycle can be claimed.
        return ("product", "pass", "false", "n/a", "-", "passed") if passed else ("product", "fail", "false", "n/a", "-", "assertion-failed")
    if state.counterfactual:
        # The stub is deterministic, so the declared repetition plays no part here.
        if state.evidence_pass == "cf-correct":
            if passed:
                return ("product", "pass", "false", "reproduced", bug, "counterfactual-correct-pass")
            return ("automation", "fail", "false", "n/a", bug, "counterfactual-correct-red")
        if passed:
            return ("automation", "fail", "false", "n/a", bug, "counterfactual-tamper-survived")
        return ("product", "fail", "true", "reproduced", bug, "counterfactual-tamper-red")
    if state.mode == "defect-evidence":
        repeat = state.evidence_pass == "repeat"
        if not passed:
            return ("product", "fail", "true", "reproduced", bug, "expected-red-repeat" if repeat else "expected-red")
        if meta.repetition > 1:
            return ("product", "pass", "false", "n/a", bug, "intermittent-unreproduced")
        if repeat:
            return ("automation", "fail", "false", "n/a", bug, "flaky-red")
        return ("product", "pass", "true", "automated", bug, "expected-red-passed")
    # candidate-regression and full-suite are strict. baseline never selects regressions;
    # one that runs anyway is judged strictly as well.
    if passed:
        return ("product", "pass", "false", "fixed", bug, "regression-green")
    return ("product", "fail", "false", "automated", bug, "regression-red")


def skip_outcome(meta: CaseMeta) -> tuple[str, str, str]:
    return ("policy", "denied", "regression-skipped") if meta.regression else ("skip", "skipped", "test-skipped")


def classify_setup(error: BaseException | None) -> tuple[str, str, str]:
    if error is not None:
        if (argus := argus_outcome(error)) is not None:
            return argus
        if connection_failure(error):
            return TARGET_UNREACHABLE
    return FIXTURE_FAILED


def classify_call(error: BaseException | None) -> tuple[str, str, str]:
    if error is None:
        return UNCAUGHT
    if (argus := argus_outcome(error)) is not None:
        return argus
    # pytest.fail() and a failed pytest.raises() raise pytest's own Failed outcome: the
    # test's verdict, like an assert (Java counts opentest4j the same way).
    if isinstance(error, (AssertionError, pytest.fail.Exception)):
        return PRODUCT
    if connection_failure(error):
        return TARGET_UNREACHABLE
    if timeout_failure(error):
        return TEST_TIMEOUT
    if playwright_kind(error) == "Error":
        return PLAYWRIGHT_FAILED
    return UNCAUGHT


def classify_teardown(error: BaseException | None) -> tuple[str, str, str]:
    argus = argus_outcome(error) if error is not None else None
    return argus if argus is not None else CLEANUP_FAILED


def argus_outcome(error: BaseException) -> tuple[str, str, str] | None:
    # Matched by class name (SD-5), so a second import path of qa.argus still classifies.
    for cls in type(error).__mro__:
        if cls.__name__ in ARGUS_ERRORS:
            return ARGUS_ERRORS[cls.__name__]
    return None


def connection_failure(error: BaseException) -> bool:
    """Refused, unknown-host or reset connection, including through an explicit ``raise ... from`` chain."""
    connect_errors: tuple[type[BaseException], ...] = (ConnectionError, socket.gaierror)
    if httpx is not None:
        connect_errors += (httpx.ConnectError, httpx.ConnectTimeout)
    current: BaseException | None = error
    for _ in range(8):
        if current is None:
            return False
        if isinstance(current, connect_errors):
            return True
        if playwright_kind(current) is not None and "net::ERR_" in str(current):
            return True
        current = current.__cause__
    return False


def timeout_failure(error: BaseException) -> bool:
    if httpx is not None and isinstance(error, httpx.TimeoutException):
        return True
    return isinstance(error, TimeoutError) or playwright_kind(error) == "TimeoutError"


def playwright_kind(error: BaseException) -> str | None:
    """'TimeoutError' or 'Error' for Playwright's exception classes, without importing Playwright."""
    names = {cls.__name__ for cls in type(error).__mro__ if cls.__module__.split(".")[0] == "playwright"}
    if "TimeoutError" in names:
        return "TimeoutError"
    return "Error" if "Error" in names else None


def strict_xpass(report: pytest.TestReport) -> bool:
    return report.when == "call" and report.failed and isinstance(report.longrepr, str) and report.longrepr.startswith("[XPASS(strict)]")


# ------------------------------------------------------------------- counterfactual


def counterfactual_module() -> Any:
    """qa.argus.counterfactual, imported on first use: only cf-* passes and inventories with
    expected bugs need it. An import failure propagates and is recorded as an adapter failure."""
    from qa.argus import counterfactual  # noqa: PLC0415

    return counterfactual


def pass_suffix(state: AdapterState, meta: CaseMeta) -> str:
    """SD-2 pass suffix. A tamper pass names the tamper, recomputed from the bug's fixture; a
    case without an applicable tamper keeps the pass name."""
    if state.evidence_pass in PASSES:
        return PASSES[state.evidence_pass]
    if state.evidence_pass != "cf-correct":
        cf = counterfactual_module()
        fixture = fixture_for(state, meta.bug)
        if isinstance(fixture, cf.CounterfactualFixture):
            variant = cf.variant_for(fixture, state.evidence_pass)
            if isinstance(variant, cf.CounterfactualVariant):
                return f".cf-{variant.id}"
    return f".{state.evidence_pass}"


def fixture_for(state: AdapterState, bug: str) -> Any:
    """The structural read of the bug's fixture (tamper ids and exemption reason), cached; None
    for '-'. The conftest fixture already skipped a fixture whose contract check fails."""
    if bug == "-":
        return None
    if bug not in state.fixtures:
        state.fixtures[bug] = counterfactual_module().read_fixture(state.root, bug)
    return state.fixtures[bug]


def counterfactual_skip(state: AdapterState, meta: CaseMeta, error: BaseException | None) -> bool:
    """SD-6 sentinel skips of the counterfactual fixture; True when handled here.

    The not-applicable sentinel reports nothing, and so does an exemption claim in a tamper
    pass. In cf-correct an exemption claim reports ``<case>.cf policy pass ...
    counterfactual-exempt.<reason>`` when the bug's fixture declares exactly that exemption;
    otherwise it is an ordinary skip (False).
    """
    cf = counterfactual_module()
    reason = getattr(error, "msg", None)
    if not isinstance(reason, str):
        return False
    if reason == cf.NOT_APPLICABLE:
        return True
    if not reason.startswith(cf.EXEMPT_PREFIX):
        return False
    if state.evidence_pass != "cf-correct":
        return True
    claimed = reason[len(cf.EXEMPT_PREFIX):]
    fixture = fixture_for(state, meta.bug)
    if not isinstance(fixture, cf.Exempt) or fixture.reason != claimed or claimed not in cf.EXEMPTION_REASONS:
        return False
    state.emit(f"{meta.case_id}.cf", ("policy", "pass", f"counterfactual-exempt.{claimed}"), "false", "n/a", meta.bug)
    return True


def unmatched_request(error: BaseException | None) -> bool:
    """An ArgusCounterfactualError, alone or inside the group pytest raises for several failing finalizers."""
    if error is None:
        return False
    if argus_outcome(error) == ARGUS_ERRORS["ArgusCounterfactualError"]:
        return True
    return isinstance(error, BaseExceptionGroup) and any(unmatched_request(member) for member in error.exceptions)


# -------------------------------------------------------------- inventory and ledger


def describe_items(items: list[pytest.Item], ledger: Ledger) -> list[CaseMeta]:
    """SD-2 case ids with collision suffixes in declaration order, plus the SD-3 fields."""
    bases = [case_id_for(item.nodeid) for item in items]
    order = sorted(range(len(items)), key=lambda index: declaration_key(items[index], index))
    seen: dict[str, int] = {}
    case_ids = [""] * len(items)
    for index in order:
        count = seen.get(bases[index], 0) + 1
        seen[bases[index]] = count
        case_ids[index] = bases[index] if count == 1 else f"{bases[index]}.{count}"
    return [describe(item, case_id, ledger) for item, case_id in zip(items, case_ids)]


def describe(item: pytest.Item, case_id: str, ledger: Ledger) -> CaseMeta:
    names = {marker.name for marker in item.iter_markers()}
    lanes = sorted({LANE_MARKERS[name] for name in names if name in LANE_MARKERS})
    resolved: list[str] = []
    unresolved: list[str] = []
    for marker in item.iter_markers("bug"):
        token = marker.args[0] if marker.args else marker.kwargs.get("id")
        canonical = ledger.aliases.get(token) if isinstance(token, str) and PROVENANCE_TOKEN.match(token) else None
        if canonical is not None:
            resolved.append(canonical)
        elif token is None:
            unresolved.append("missing-token")
        else:
            unresolved.append(sanitize(str(token)) or "invalid-token")
    regression = "regression" in names
    bug_ids = tuple(sorted(set(resolved)))
    repetition, declared = declared_repetition(item)
    if "skip" in names:
        disabled = "skip"
    elif "xfail" in names:
        disabled = "expected-failure"
    elif "skipif" in names:
        disabled = "conditional"
    else:
        disabled = "-"
    meta = CaseMeta(
        case_id=case_id,
        lane=lanes[0] if len(lanes) == 1 else ("ambiguous" if lanes else "-"),
        regression=regression,
        quarantine="quarantine" in names,
        bug_ids=bug_ids,
        unresolved=tuple(dict.fromkeys(unresolved)),
        disabled=disabled,
        source=source_of(item),
        repetition=repetition,
        repetition_valid=declared,
    )
    if declared and not repetition_allowed(meta, ledger):
        meta = replace(meta, repetition_valid=False)
    return meta


def declared_repetition(item: pytest.Item) -> tuple[int, bool]:
    """SD-11: at most one ``repetition(n)`` marker with a single integer 1..200; absent means 1."""
    markers = list(item.iter_markers("repetition"))
    if not markers:
        return 1, True
    marker = markers[0]
    value = marker.args[0] if len(marker.args) == 1 and not marker.kwargs else None
    if len(markers) > 1 or type(value) is not int or not 1 <= value <= MAX_REPETITION:
        return 1, False
    return value, True


def repetition_allowed(meta: CaseMeta, ledger: Ledger) -> bool:
    """SD-6: n > 1 only for an intermittent defect, and never below its 95% bound."""
    if meta.bug == "-":
        return meta.repetition == 1
    rate = ledger.rates.get(meta.bug)
    if rate is None or rate >= 1:
        return meta.repetition == 1
    bound = MAX_REPETITION if rate <= 0 else min(MAX_REPETITION, math.ceil(math.log(0.05) / math.log(1 - rate)))
    return bound <= meta.repetition <= MAX_REPETITION


def write_inventory(state: AdapterState, metas: list[CaseMeta]) -> None:
    inventory = state.reports / "test-inventory.tsv"
    expected_bugs = state.reports / "expected-bugs.txt"
    plan = state.reports / "counterfactual-plan.tsv"
    try:
        # SD-10: the plan is judged before anything is written, so a fixture that cannot be
        # judged (a declared contract without its OpenAPI document) publishes nothing at all.
        plan_rows = None if state.collection_errors else counterfactual_plan(state)
    except Exception as exc:  # noqa: BLE001 - a plan with a guessed status is never published
        state.record_failure("-", "counterfactual-plan-failed", type(exc).__name__)
        try:
            for path in (inventory, expected_bugs, plan):
                path.unlink(missing_ok=True)
        except OSError:
            pass  # the failure is already counted; the status file reports it
    else:
        try:
            atomic_write(expected_bugs, "".join(f"{bug}\n" for bug in state.ledger.confirmed))
            if plan_rows is None:
                # A partial collection must never pass for the full one (SD-3).
                inventory.unlink(missing_ok=True)
                plan.unlink(missing_ok=True)
                state.record_failure("-", "collection-error", f"errors-{state.collection_errors}")
            else:
                atomic_write(inventory, "".join(inventory_row(meta) for meta in metas))
                atomic_write(plan, plan_rows)
        except OSError as exc:
            state.record_failure("-", "inventory-write-failed", type(exc).__name__)
    if state.ledger.status == "invalid":
        state.emit("bug-ledger", ("policy", "denied", "bug-ledger-invalid"), "false", "n/a", "-")
    elif state.ledger.status == "missing" and state.mode != "baseline":
        state.emit("bug-ledger", ("policy", "denied", "bug-ledger-missing"), "false", "n/a", "-")


def counterfactual_plan(state: AdapterState) -> str:
    """reports/counterfactual-plan.tsv content: one SD-10 row per expected bug; empty without any."""
    if not state.ledger.confirmed:
        return ""
    cf = counterfactual_module()
    return "".join(f"{cf.plan_line(row)}\n" for row in cf.plan(state.root, state.ledger.confirmed))


def inventory_row(meta: CaseMeta) -> str:
    fields = [
        meta.case_id, meta.lane, str(meta.regression).lower(), str(meta.quarantine).lower(),
        ",".join(meta.bug_ids) or "-", ",".join(meta.unresolved) or "-", meta.disabled, meta.source,
    ]
    return "\t".join(fields) + "\n"


def load_ledger(path: Path) -> Ledger:
    """SD-4 join over ``bugs[].id`` and ``bugs[].origin[]`` for bug-ledger@1 and @2."""
    if not path.exists():
        return Ledger("missing")
    invalid = Ledger("invalid")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return invalid
    if not isinstance(document, dict):
        return invalid
    version = LEDGER_SCHEMAS.get(document.get("$schema"))
    bugs = document.get("bugs")
    if version is None or type(document.get("schemaVersion")) is not int or document["schemaVersion"] != version or not isinstance(bugs, list):
        return invalid
    targets: dict[str, set[str]] = {}
    ids: set[str] = set()
    for entry in bugs:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not CANONICAL_ID.match(entry["id"]):
            return invalid
        origin = entry.get("origin", [])
        if entry["id"] in ids or not isinstance(origin, list) or not all(isinstance(token, str) for token in origin):
            return invalid
        ids.add(entry["id"])
        for token in (entry["id"], *origin):
            targets.setdefault(token, set()).add(entry["id"])
    if any(len(owners) > 1 for owners in targets.values()):
        return invalid  # an alias that resolves to two ids
    return Ledger(
        status="ok",
        aliases={token: next(iter(owners)) for token, owners in targets.items()},
        confirmed=tuple(sorted({entry["id"] for entry in bugs if entry.get("status") == "confirmed"})),
        rates={entry["id"]: reproduction_rate(entry) for entry in bugs},
    )


def reproduction_rate(entry: dict[str, Any]) -> float | None:
    """p = occurrences / attempts from verification.reproduction, or None without a usable record."""
    verification = entry.get("verification")
    record = verification.get("reproduction") if isinstance(verification, dict) else None
    if not isinstance(record, dict):
        return None
    attempts, occurrences = record.get("attempts"), record.get("occurrences")
    if type(attempts) is not int or type(occurrences) is not int or attempts < 1 or not 0 <= occurrences <= attempts:
        return None
    return occurrences / attempts


# ------------------------------------------------------------------------- helpers


def case_id_for(nodeid: str) -> str:
    """SD-2 S(x) with x = nodeid, '/' replaced by '.'."""
    raw = nodeid.replace("/", ".")
    safe = sanitize(raw)
    if len(safe) > MAX_CASE_ID or not safe:
        safe = f"{safe[:187]}.{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12]}".lstrip(".")
    return safe


def sanitize(value: str) -> str:
    return UNSAFE_RUN.sub("-", value).strip("-")


def location(item: pytest.Item) -> tuple[str, int | None]:
    """(posix path relative to the rootdir, 0-based line) as pytest reports it."""
    try:
        path, line, _ = item.location
    except Exception:  # noqa: BLE001 - a plugin item without a location still gets a row
        return "", None
    return str(path).replace(os.sep, "/"), line


def declaration_key(item: pytest.Item, index: int) -> tuple[str, int, int]:
    path, line = location(item)
    return path, -1 if line is None else line, index


def source_of(item: pytest.Item) -> str:
    """SD-3 source field: posix-path:line (1-based) restricted to [A-Za-z0-9_./:-], or '-'."""
    path, line = location(item)
    if not path:
        return "-"
    return UNSAFE_SOURCE_RUN.sub("-", path if line is None else f"{path}:{line + 1}")


def meta_for(item: pytest.Item, state: AdapterState) -> CaseMeta:
    meta = item.stash.get(META_KEY, None)
    if meta is None:  # an item added after collection: no collision context, but a valid id
        meta = describe(item, case_id_for(item.nodeid), state.ledger)
        item.stash[META_KEY] = meta
    return meta


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
