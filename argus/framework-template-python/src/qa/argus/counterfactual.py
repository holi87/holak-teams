"""Counterfactual fixtures (TEMPLATE-CONTRACT.md SD-10).

A fixture proves that a regression distinguishes correct from defective behaviour without
contacting the target: the ``cf-correct`` pass serves the subject exchange as specified, and
each ``cf-tamper-<k>`` pass replaces the subject response with ``tampers[k-1]``. The outcome
adapter (qa.argus_plugin) uses this module for the inventory plan and for cf-* passes; the
root conftest's ``_argus_counterfactual`` fixture uses it inside each test.

Only the standard library is imported at load time. ``load_fixture`` imports the strict
schema oracle (jsonschema) lazily, and only for a fixture that declares a ``contract``.
"""
from __future__ import annotations

import copy
import json
import re
import stat
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Union
from urllib.parse import urlsplit

from .stub_server import StubExchange, StubResponse, StubServer

FIXTURE_SCHEMA = "argus/counterfactual-fixture@1"
REQUIRED_TAMPER = "observed-defect"
EXEMPTION_REASONS = ("front-end-logic", "timing-or-load", "data-layer", "fault-injection", "non-http-protocol")
ORACLE_KINDS = ("requirement", "contract", "justified-invariant")
#: Skip reason for a test that has no applicable variant in this pass (SD-6: no event).
NOT_APPLICABLE = "argus-counterfactual-not-applicable"
#: Skip reason prefix for an exempt bug in cf-correct, followed by the exemption reason.
EXEMPT_PREFIX = "argus-counterfactual-exempt:"
#: variant_for's answer when the pass has no variant for the fixture.
NO_VARIANT: Literal["not-applicable"] = "not-applicable"

InvalidReason = Literal["schema-invalid", "missing-observed-defect", "correct-violates-contract"]

_PASS = re.compile(r"cf-(correct|tamper-([1-9][0-9]*))")
_CANONICAL_BUG = re.compile(r"BUG-[0-9]{4}")
_PROVENANCE_TOKEN = re.compile(r"BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4}")
_VARIANT_ID = re.compile(r"[a-z0-9-]{1,40}")
_METHOD = re.compile(r"[A-Z]+")
_HEADER_NAME = re.compile(r"[a-z0-9!#$%&'*+.^_`|~-]+")
_LEDGER_SCHEMAS = {"argus/bug-ledger@1": 1, "argus/bug-ledger@2": 2}
_COMMON_KEYS = ("$schema", "schemaVersion", "bugId")
_MAX_FIXTURE_BYTES = 1024 * 1024
_UNMATCHED: StubResponse = {"status": 501, "body": {"argusStub": "unmatched"}}


@dataclass(frozen=True)
class CounterfactualFixture:
    """A valid fixture: the exchanges the regression makes, its subject, and the tampers."""

    oracle: dict[str, Any]
    contract: dict[str, Any] | None
    exchanges: list[StubExchange]
    subject: str
    tampers: list[dict[str, Any]]
    kind: str = field(default="fixture", init=False)

    @property
    def tamper_ids(self) -> tuple[str, ...]:
        return tuple(tamper["id"] for tamper in self.tampers)

    def subject_response(self) -> StubResponse:
        return next(exchange["response"] for exchange in self.exchanges if exchange["id"] == self.subject)


@dataclass(frozen=True)
class Exempt:
    """The bug is exempt from counterfactual evidence for one of EXEMPTION_REASONS."""

    reason: str
    kind: str = field(default="exempt", init=False)


@dataclass(frozen=True)
class Invalid:
    """The file exists but is not a usable fixture."""

    reason: InvalidReason
    kind: str = field(default="invalid", init=False)


@dataclass(frozen=True)
class Missing:
    """No solution/counterfactual/<bug>.json."""

    kind: str = field(default="missing", init=False)


LoadedFixture = Union[CounterfactualFixture, Exempt, Invalid, Missing]


@dataclass(frozen=True)
class CounterfactualVariant:
    """The response served for the subject exchange; ``id`` is 'correct' or the tamper id."""

    id: str
    response: StubResponse


@dataclass(frozen=True)
class CounterfactualContext:
    """What ``_argus_counterfactual`` yields to a test whose variant is loaded into the stub."""

    bug_id: str
    variant: str
    stub: StubServer


@dataclass(frozen=True)
class PlanRow:
    """One reports/counterfactual-plan.tsv row."""

    bug_id: str
    status: Literal["fixture", "exempt", "missing", "invalid"]
    tamper_ids: tuple[str, ...] = ()
    reason: str = "-"


def is_counterfactual_pass(evidence_pass: str | None) -> bool:
    """True for cf-correct and cf-tamper-<k> (k >= 1)."""
    return _PASS.fullmatch(evidence_pass or "") is not None


def read_fixture(root: str | Path, bug_id: str) -> LoadedFixture:
    """Read and validate solution/counterfactual/<bug_id>.json against SD-10, without the contract check.

    A structurally valid fixture that lacks the observed-defect tamper is invalid with
    ``missing-observed-defect``; any other deviation is ``schema-invalid``.
    """
    if not isinstance(bug_id, str) or not _CANONICAL_BUG.fullmatch(bug_id):
        raise TypeError(f"counterfactual fixtures are keyed by a canonical BUG-NNNN id, got {bug_id!r}")
    path = Path(root) / "solution" / "counterfactual" / f"{bug_id}.json"
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return Missing()
    except OSError:
        return Invalid("schema-invalid")
    if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_FIXTURE_BYTES:
        return Invalid("schema-invalid")
    try:
        document = json.loads(path.read_text(encoding="utf-8"), parse_constant=_reject_constant)
    except (OSError, UnicodeDecodeError, ValueError):
        return Invalid("schema-invalid")
    return _validate_fixture(document, bug_id)


def load_fixture(root: str | Path, bug_id: str) -> LoadedFixture:
    """read_fixture plus the contract check.

    With ``contract``, the subject response must have exactly contract.status and satisfy
    assert_schema for contract.operationId, otherwise the fixture is invalid with
    ``correct-violates-contract`` (an operationId the OpenAPI document does not define
    included). A missing OpenAPI document is ArgusPrerequisiteError and propagates.
    """
    fixture = read_fixture(root, bug_id)
    if not isinstance(fixture, CounterfactualFixture) or fixture.contract is None:
        return fixture
    correct = fixture.subject_response()
    if correct["status"] != fixture.contract["status"]:
        return Invalid("correct-violates-contract")
    from qa.oracles.schema import assert_schema  # noqa: PLC0415 - jsonschema only when a contract is declared

    record = {"status": correct["status"], "headers": correct.get("headers") or {}, "body": correct.get("body")}
    try:
        assert_schema(record, fixture.contract["operationId"])
    except Exception as exc:  # noqa: BLE001 - every other failure means the correct response breaks the contract
        if any(cls.__name__ == "ArgusPrerequisiteError" for cls in type(exc).__mro__):
            raise
        return Invalid("correct-violates-contract")
    return fixture


def variant_for(fixture: CounterfactualFixture, evidence_pass: str) -> CounterfactualVariant | Literal["not-applicable"]:
    """cf-correct serves the subject response; cf-tamper-<k> serves tampers[k-1] or has NO_VARIANT."""
    match = _PASS.fullmatch(evidence_pass or "")
    if match is None:
        raise TypeError(f"not a counterfactual pass: {evidence_pass!r}")
    if match.group(1) == "correct":
        return CounterfactualVariant("correct", copy.deepcopy(fixture.subject_response()))
    index = int(match.group(2)) - 1
    if index >= len(fixture.tampers):
        return NO_VARIANT
    tamper = fixture.tampers[index]
    return CounterfactualVariant(tamper["id"], copy.deepcopy(tamper["response"]))


def variant_exchanges(fixture: CounterfactualFixture, variant: CounterfactualVariant) -> list[StubExchange]:
    """The fixture's exchanges with the subject response replaced entirely by the variant."""
    return [
        {**copy.deepcopy(exchange), "response": copy.deepcopy(variant.response)} if exchange["id"] == fixture.subject else copy.deepcopy(exchange)
        for exchange in fixture.exchanges
    ]


def plan(root: str | Path, expected_bugs: Sequence[str]) -> list[PlanRow]:
    """One SD-10 plan row per expected bug, in the given order."""
    rows: list[PlanRow] = []
    for bug_id in expected_bugs:
        fixture = load_fixture(root, bug_id)
        if isinstance(fixture, CounterfactualFixture):
            rows.append(PlanRow(bug_id, "fixture", fixture.tamper_ids))
        elif isinstance(fixture, Missing):
            rows.append(PlanRow(bug_id, "missing"))
        else:
            rows.append(PlanRow(bug_id, fixture.kind, (), fixture.reason))  # type: ignore[arg-type]
    return rows


def plan_line(row: PlanRow) -> str:
    """reports/counterfactual-plan.tsv line: bug_id, status, tamper_ids, reason."""
    return "\t".join([row.bug_id, row.status, ",".join(row.tamper_ids) or "-", row.reason])


def bound_bug(root: str | Path, item: Any) -> str | None:
    """The canonical bug a pytest item's regression is bound to (SD-4, SD-11), or None.

    Mirrors the outcome adapter's join: the item carries the ``regression`` marker, and its
    ``bug`` marker tokens resolve through the id or origin[] of a valid
    solution/bug-ledger.json to exactly one canonical id.
    """
    if not any(marker.name == "regression" for marker in item.iter_markers()):
        return None
    aliases = _ledger_aliases(Path(root) / "solution" / "bug-ledger.json")
    if aliases is None:
        return None
    resolved: set[str] = set()
    for marker in item.iter_markers("bug"):
        token = marker.args[0] if marker.args else marker.kwargs.get("id")
        if isinstance(token, str) and _PROVENANCE_TOKEN.fullmatch(token) and token in aliases:
            resolved.add(aliases[token])
    return next(iter(resolved)) if len(resolved) == 1 else None


def fulfill_from_stub(route: Any, stub: StubServer) -> None:
    """A Playwright route handler that answers from the stub; an unmatched request gets 501.

    Install it on the ui-lane browser context in a cf-* pass, for example
    ``page.context.route(pattern, lambda route: fulfill_from_stub(route, stub))``.
    """
    request = route.request
    parts = urlsplit(request.url)
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    response = stub.resolve(request.method, target) or copy.deepcopy(_UNMATCHED)
    headers = {name: str(value) for name, value in (response.get("headers") or {}).items()}
    body: str | bytes | None = None
    if "body" in response:
        value = response["body"]
        if isinstance(value, str):
            body = value
            headers.setdefault("content-type", "text/plain; charset=utf-8")
        elif isinstance(value, (bytes, bytearray, memoryview)):
            body = bytes(value)
            headers.setdefault("content-type", "application/octet-stream")
        else:
            body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            headers.setdefault("content-type", "application/json")
    route.fulfill(status=response["status"], headers=headers, body=body)


# ------------------------------------------------------------------------- validation


def _validate_fixture(document: Any, bug_id: str) -> LoadedFixture:
    schema_invalid = Invalid("schema-invalid")
    if (
        not isinstance(document, dict)
        or document.get("$schema") != FIXTURE_SCHEMA
        or type(document.get("schemaVersion")) is not int
        or document["schemaVersion"] != 1
        or document.get("bugId") != bug_id
    ):
        return schema_invalid
    if "exemption" in document:
        exemption = document["exemption"]
        if not _has_exact_keys(document, [*_COMMON_KEYS, "exemption"]) or not isinstance(exemption, dict) or not _has_exact_keys(exemption, ["reason", "justification"]):
            return schema_invalid
        reason, justification = exemption["reason"], exemption["justification"]
        justified = isinstance(justification, str) and justification.strip() != "" and len(justification) <= 500
        if reason not in EXEMPTION_REASONS or not justified:
            return schema_invalid
        return Exempt(reason)
    if not _has_exact_keys(document, [*_COMMON_KEYS, "oracle", "exchanges", "subject", "tampers"], ["contract"]):
        return schema_invalid
    oracle, contract = document["oracle"], document.get("contract")
    exchanges, subject, tampers = document["exchanges"], document["subject"], document["tampers"]
    if not isinstance(oracle, dict) or not _has_exact_keys(oracle, ["kind", "sourceRef"]) or oracle["kind"] not in ORACLE_KINDS or not _is_text(oracle["sourceRef"]):
        return schema_invalid
    if "contract" in document and (
        not isinstance(contract, dict)
        or not _has_exact_keys(contract, ["operationId", "status"])
        or not _is_text(contract["operationId"])
        or not _is_status(contract["status"])
    ):
        return schema_invalid
    if not isinstance(exchanges, list) or not exchanges or not all(_is_exchange(exchange) for exchange in exchanges) or not _unique_ids(exchanges):
        return schema_invalid
    if not isinstance(subject, str) or not any(exchange["id"] == subject for exchange in exchanges):
        return schema_invalid
    # 'correct' is reserved: the cf-correct pass already uses the case suffix '.cf-correct'.
    if not isinstance(tampers, list) or not tampers or not all(_is_tamper(tamper) for tamper in tampers) or not _unique_ids(tampers):
        return schema_invalid
    if not any(tamper["id"] == REQUIRED_TAMPER for tamper in tampers):
        return Invalid("missing-observed-defect")
    return CounterfactualFixture(
        oracle=copy.deepcopy(oracle),
        contract=copy.deepcopy(contract) if "contract" in document else None,
        exchanges=copy.deepcopy(exchanges),
        subject=subject,
        tampers=copy.deepcopy(tampers),
    )


def _is_exchange(value: Any) -> bool:
    if not isinstance(value, dict) or not _has_exact_keys(value, ["id", "request", "response"]):
        return False
    if not isinstance(value["id"], str) or not _VARIANT_ID.fullmatch(value["id"]):
        return False
    request = value["request"]
    if not isinstance(request, dict) or not _has_exact_keys(request, ["method", "path"], ["query"]):
        return False
    if not isinstance(request["method"], str) or not _METHOD.fullmatch(request["method"]):
        return False
    path = request["path"]
    if not isinstance(path, str) or not path.startswith("/") or "?" in path or "#" in path:
        return False
    query = request.get("query")
    if "query" in request and (not isinstance(query, dict) or not all(isinstance(item, str) for item in query.values())):
        return False
    return _is_response(value["response"])


def _is_tamper(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _has_exact_keys(value, ["id", "response"])
        and isinstance(value["id"], str)
        and _VARIANT_ID.fullmatch(value["id"]) is not None
        and value["id"] != "correct"
        and _is_response(value["response"])
    )


def _is_response(value: Any) -> bool:
    if not isinstance(value, dict) or not _has_exact_keys(value, ["status"], ["headers", "body"]) or not _is_status(value["status"]):
        return False
    if "headers" not in value:
        return True
    headers = value["headers"]
    return isinstance(headers, dict) and all(isinstance(name, str) and _HEADER_NAME.fullmatch(name) and isinstance(item, str) for name, item in headers.items())


def _ledger_aliases(path: Path) -> dict[str, str] | None:
    """token -> canonical id over bugs[].id and bugs[].origin[] of bug-ledger@1 or @2; None when unusable."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(document, dict) or not isinstance(document.get("bugs"), list):
        return None
    schema = document.get("$schema")
    version = _LEDGER_SCHEMAS.get(schema) if isinstance(schema, str) else None
    if version is None or type(document.get("schemaVersion")) is not int or document["schemaVersion"] != version:
        return None
    owners: dict[str, set[str]] = {}
    ids: set[str] = set()
    for bug in document["bugs"]:
        if not isinstance(bug, dict) or not isinstance(bug.get("id"), str) or not _CANONICAL_BUG.fullmatch(bug["id"]) or bug["id"] in ids:
            return None
        origin = bug.get("origin", [])
        if not isinstance(origin, list) or not all(isinstance(alias, str) for alias in origin):
            return None
        ids.add(bug["id"])
        for token in (bug["id"], *origin):
            owners.setdefault(token, set()).add(bug["id"])
    if any(len(bugs) != 1 for bugs in owners.values()):
        return None  # an alias that resolves to two ids
    return {token: next(iter(bugs)) for token, bugs in owners.items()}


def _has_exact_keys(value: dict[str, Any], required: Sequence[str], optional: Sequence[str] = ()) -> bool:
    return all(key in value for key in required) and all(key in required or key in optional for key in value)


def _unique_ids(values: list[dict[str, Any]]) -> bool:
    return len({value["id"] for value in values}) == len(values)


def _is_status(value: Any) -> bool:
    return type(value) is int and 100 <= value <= 599


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")
