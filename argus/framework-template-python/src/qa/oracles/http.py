"""Exact HTTP status oracles.

A status is one documented integer, never a class: "any 2xx" or ``in (401, 403)`` hides the
defects Argus hunts. Every RED raises AssertionError, so the outcome adapter classifies it as
a product failure; usage errors raise TypeError or ValueError (automation).

Every helper accepts an httpx.Response, a Playwright APIResponse or Response, or a plain
record ``{"status": 201, "body": {...}, "headers": {...}, "url": "...", "method": "POST"}``.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

RestState = Literal[
    "created",
    "deleted",
    "missing",
    "method-not-allowed",
    "unsupported-media-type",
    "malformed",
    "unauthenticated",
    "forbidden",
    "conflict",
    "ok",
]

#: The one status code each REST state maps to.
REST_STATUS: Mapping[str, int] = MappingProxyType({
    "created": 201,
    "deleted": 204,
    "missing": 404,
    "method-not-allowed": 405,
    "unsupported-media-type": 415,
    "malformed": 400,
    "unauthenticated": 401,
    "forbidden": 403,
    "conflict": 409,
    "ok": 200,
})

SECRET_KEY = re.compile(r"authorization|token|password|secret|cookie", re.IGNORECASE)
REDACTED = "[REDACTED]"
_BEARER = re.compile(r"\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_SECRET_ASSIGNMENT = re.compile(
    r"([A-Za-z0-9_-]*(?:authorization|token|password|secret|cookie)[A-Za-z0-9_-]*[\"']?\s*[:=]\s*[\"']?)[^\"'&\s,;}]+",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class HttpSnapshot:
    """One read of a response: lowercase header names; body parsed as JSON when it is JSON."""

    status: int
    method: str
    url: str
    headers: dict[str, str]
    #: Parsed JSON when the body is JSON, the raw text otherwise, None when empty.
    body: Any
    empty: bool


def read_result(res: Any, method: str | None = None) -> HttpSnapshot:
    """Read status, headers, and body once; the method comes from the result or ``method``."""
    if isinstance(res, Mapping):
        status = res.get("status")
        _require_int_status(status, "record status")
        body = res.get("body")
        return HttpSnapshot(
            status=status,
            method=method or _text(res.get("method")) or "-",
            url=_text(res.get("url")) or "-",
            headers=_lower_keys(res.get("headers") or {}),
            body=body,
            empty="body" not in res or (isinstance(body, (str, bytes)) and len(body) == 0),
        )
    if hasattr(res, "status_code"):  # httpx.Response (and requests-like responses)
        text = _response_text(res)
        request = _safe(lambda: res.request, None)
        return HttpSnapshot(
            status=int(res.status_code),
            method=method or _text(_safe(lambda: request.method, None)) or "-",
            url=_text(_safe(lambda: res.url, None)) or "-",
            headers=_lower_keys(_safe(lambda: res.headers, {})),
            body=_parse_text(text),
            empty=text == "",
        )
    if hasattr(res, "status") and callable(getattr(res, "text", None)):  # Playwright (sync API)
        text = _safe(res.text, "")
        request = _safe(lambda: res.request, None)
        return HttpSnapshot(
            status=int(res.status),
            method=method or _text(_safe(lambda: request.method, None)) or "-",
            url=_text(_safe(lambda: res.url, None)) or "-",
            headers=_lower_keys(_safe(lambda: res.headers, {})),
            body=_parse_text(text),
            empty=text == "",
        )
    raise TypeError(f"unsupported response type {type(res).__name__}; pass an httpx or Playwright response or a {{status, body}} record")


def status_of(res: Any) -> int:
    """The status code without reading the body."""
    if isinstance(res, Mapping):
        _require_int_status(res.get("status"), "record status")
        return res["status"]
    if hasattr(res, "status_code"):
        return int(res.status_code)
    if hasattr(res, "status"):
        return int(res.status)
    raise TypeError(f"unsupported response type {type(res).__name__}")


def redacted_excerpt(body: Any, limit: int = 500) -> str:
    """A body excerpt of at most ``limit`` characters with secret-looking keys and values masked."""
    value = body
    if isinstance(body, (bytes, bytearray)):
        value = body = bytes(body).decode("utf-8", errors="replace")
    if isinstance(body, str):
        try:
            value = json.loads(body)
        except ValueError:
            return _clip(mask_text(body), limit)
    try:
        text = json.dumps(redact(value), ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        text = "(unserializable body)"
    return _clip(text, limit)


def redact(value: Any, _seen: set[int] | None = None) -> Any:
    """A copy of a JSON-like value with every secret-looking key's value replaced."""
    if not isinstance(value, (dict, list, tuple)):
        return value
    seen = set() if _seen is None else _seen
    if id(value) in seen:
        return "[Circular]"
    seen = seen | {id(value)}
    if isinstance(value, (list, tuple)):
        return [redact(item, seen) for item in value]
    return {key: REDACTED if SECRET_KEY.search(str(key)) else redact(item, seen) for key, item in value.items()}


def mask_text(text: str) -> str:
    """Mask bearer/basic credentials and ``secret=value`` style assignments in free text."""
    return _SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + REDACTED, _BEARER.sub(lambda m: f"{m.group(1)} {REDACTED}", text))


def describe_result(snapshot: HttpSnapshot, include_body: bool = True) -> str:
    """``method=GET url=http://... body: {...}`` with secrets masked; used in every oracle message."""
    where = f"method={snapshot.method} url={_redact_url(snapshot.url)}"
    body = "(empty)" if snapshot.empty else redacted_excerpt(snapshot.body)
    return f"{where}\nbody: {body}" if include_body else where


def expect_status(res: Any, exact: int, *, method: str | None = None) -> None:
    """Assert the exact status code; the failure names method, URL, and a redacted body excerpt."""
    _require_status_code(exact, "expect_status: exact")
    status = status_of(res)
    if status != exact:
        raise AssertionError(f"expected HTTP {exact}, got {status}: {describe_result(read_result(res, method))}")


def assert_rest_status(
    res: Any,
    state: RestState,
    *,
    documented_status: int | None = None,
    method: str | None = None,
    require_location: bool = False,
) -> None:
    """Assert a REST state with its exact code.

    created=201, deleted=204 with an empty body,
    method-not-allowed=405 with Allow, missing=404, unsupported-media-type=415, malformed=400,
    unauthenticated=401, forbidden=403, conflict=409, ok=200. ``documented_status`` replaces
    the code with the one the API documents (one exact integer, never a class). HTTP 201 may
    identify the resource by the request target URI; set ``require_location`` only when the
    API contract requires that header. Empty-body and Allow requirements apply to their
    standard status codes.
    """
    if not isinstance(state, str) or state not in REST_STATUS:
        raise ValueError(f"assert_rest_status: unknown state {state!r}")
    standard = REST_STATUS[state]
    if documented_status is not None:
        _require_status_code(documented_status, "assert_rest_status: documented_status (one exact code, never a class)")
    expected = standard if documented_status is None else documented_status
    snapshot = read_result(res, method)
    if snapshot.status != expected:
        raise AssertionError(f"{state}: expected HTTP {expected}, got {snapshot.status}: {describe_result(snapshot)}")
    if state == "created" and require_location and not snapshot.headers.get("location", "").strip():
        raise AssertionError(f"created: the API contract requires a non-empty Location header: {describe_result(snapshot)}")
    if expected != standard:
        return
    if state == "deleted" and not snapshot.empty:
        raise AssertionError(f"deleted: HTTP 204 with a non-empty body: {describe_result(snapshot)}")
    if state == "method-not-allowed" and not snapshot.headers.get("allow", "").strip():
        raise AssertionError(f"method-not-allowed: HTTP 405 without an Allow header: {describe_result(snapshot)}")


def _require_status_code(value: Any, label: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{label} must be one integer HTTP status code (100-599), got {value!r}")
    if not 100 <= value <= 599:
        raise ValueError(f"{label} must be one integer HTTP status code (100-599), got {value!r}")


def _require_int_status(value: Any, label: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{label} must be an integer, got {value!r}")


def _safe(read: Any, fallback: Any) -> Any:
    try:
        return read()
    except Exception:  # noqa: BLE001 - an unreadable part of a response never masks the verdict
        return fallback


def _response_text(res: Any) -> str:
    try:
        return res.text
    except Exception:  # noqa: BLE001 - httpx raises ResponseNotRead for an unread streamed body
        read = getattr(res, "read", None)
        if not callable(read):
            return ""
        return _safe(lambda: (read(), res.text)[1], "")


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _parse_text(text: str) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _lower_keys(headers: Any) -> dict[str, str]:
    items = headers.items() if hasattr(headers, "items") else headers
    result: dict[str, str] = {}
    for name, value in items:
        key = str(name).lower()
        result[key] = f"{result[key]}, {value}" if key in result else str(value)
    return result


def _redact_url(url: str) -> str:
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return mask_text(url)
    netloc = parts.netloc.rpartition("@")[2]
    query = urlencode([
        (name, REDACTED if SECRET_KEY.search(name) else value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
    ])
    return urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))


def _clip(text: str, limit: int) -> str:
    return f"{text[:max(0, limit - 1)]}…" if len(text) > limit else text
