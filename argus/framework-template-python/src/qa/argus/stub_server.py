"""In-process HTTP stub for oracle self-tests and counterfactual evidence passes.

TEMPLATE-CONTRACT.md SD-10: the stub binds 127.0.0.1 on an ephemeral port, serves from a
daemon thread, never proxies to a real target, and keeps everything it records in memory.
Unmatched requests get ``501 {"argusStub": "unmatched"}``; callers decide whether that is a
failure (a counterfactual pass raises ArgusCounterfactualError).

Usage::

    with StubServer.start() as stub:
        stub.load([{"id": "widget", "request": {"method": "GET", "path": "/widgets/1"},
                    "response": {"status": 200, "body": {"id": 1}}}])
        httpx.get(f"{stub.url}/widgets/1")
        assert stub.unmatched() == []

Exchanges, responses, and recorded requests are plain dicts:

* exchange ``{"id", "request": {"method", "path", "query"?}, "response"}``; method and path
  match exactly, plus every listed query parameter.
* response ``{"status", "headers"?, "body"?}``; header names are lowercase. A str body is
  text, a bytes body is binary, any other body (including None) is JSON; without a "body"
  key the response has no content.
* record ``{"method", "path", "query", "headers", "body", "matched"}``; ``matched`` is the
  exchange id, "handler", "handler-error", or None (unmatched).
"""
from __future__ import annotations

import copy
import json
import re
import threading
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qsl, urlsplit

StubResponse = dict[str, Any]
StubExchange = dict[str, Any]
StubRequest = dict[str, Any]
StubRecord = dict[str, Any]
#: Tried before the exchanges; returning None falls through to them.
StubHandler = Callable[[StubRequest], "StubResponse | None"]

MAX_BODY_BYTES = 10 * 1024 * 1024
_EXCHANGE_ID = re.compile(r"^[a-z0-9-]{1,40}$")
_METHOD = re.compile(r"^[A-Z]+$")
_HEADER_NAME = re.compile(r"^[a-z0-9!#$%&'*+.^_`|~-]+$")
_JSON_TYPE = re.compile(r"[/+]json\b", re.IGNORECASE)
_UNMATCHED: StubResponse = {"status": 501, "body": {"argusStub": "unmatched"}}


class StubServer:
    """A loopback HTTP stub; create it with ``StubServer.start()``."""

    def __init__(self, handler: StubHandler | None = None) -> None:
        self._handler = handler
        self._lock = threading.Lock()
        self._exchanges: list[StubExchange] = []
        self._log: list[StubRecord] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._origin = ""

    @classmethod
    def start(cls, handler: StubHandler | None = None) -> StubServer:
        """Start a stub on 127.0.0.1:0, served by a daemon thread."""
        stub = cls(handler)
        server = ThreadingHTTPServer(("127.0.0.1", 0), _request_handler(stub))
        server.daemon_threads = True
        port = server.server_address[1]
        stub._server = server
        stub._origin = f"http://127.0.0.1:{port}"
        stub._thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.05},
            name=f"argus-stub-{port}",
            daemon=True,
        )
        stub._thread.start()
        return stub

    @property
    def url(self) -> str:
        """The stub origin, for example http://127.0.0.1:53121."""
        return self._origin

    def load(self, exchanges: list[StubExchange]) -> None:
        """Replace the exchange set and clear the request log. Invalid exchanges raise TypeError."""
        if not isinstance(exchanges, (list, tuple)):
            raise TypeError("stub exchanges must be a list")
        ids: set[str] = set()
        for exchange in exchanges:
            _validate_exchange(exchange)
            if exchange["id"] in ids:
                raise TypeError(f"duplicate stub exchange id: {exchange['id']}")
            ids.add(exchange["id"])
        loaded = copy.deepcopy(list(exchanges))
        with self._lock:
            self._exchanges = loaded
            self._log = []

    def resolve(self, method: str, path: str, query: Mapping[str, Any] | None = None) -> StubResponse | None:
        """Resolve a request against the loaded exchanges without the network (for page.route).

        The request is recorded like a served one; None means unmatched (answer it with 501).
        """
        target_path, target_query = _split_target(path)
        for name, value in (query or {}).items():
            target_query[name] = [_query_text(item) for item in value] if isinstance(value, (list, tuple)) else _query_text(value)
        request: StubRequest = {"method": method.upper(), "path": target_path, "query": target_query, "headers": {}, "body": None}
        with self._lock:
            exchange = self._match(request)
            self._log.append({**request, "matched": exchange["id"] if exchange else None})
            return copy.deepcopy(exchange["response"]) if exchange else None

    def requests(self) -> list[StubRecord]:
        """Every request received or resolved since the last load, in order."""
        with self._lock:
            return copy.deepcopy(self._log)

    def unmatched(self) -> list[StubRecord]:
        """The requests that got the 501 unmatched response."""
        return [record for record in self.requests() if record["matched"] is None]

    def stop(self) -> None:
        """Stop serving and close the listener. Safe to call more than once."""
        server, thread = self._server, self._thread
        self._server = self._thread = None
        if server is None:
            return
        server.shutdown()
        server.server_close()
        if thread is not None:
            thread.join(timeout=5)

    def __enter__(self) -> StubServer:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.stop()

    # --- Serving ----------------------------------------------------------------------

    def _match(self, request: StubRequest) -> StubExchange | None:
        for exchange in self._exchanges:
            expected = exchange["request"]
            if expected["method"] != request["method"] or expected["path"] != request["path"]:
                continue
            listed = expected.get("query") or {}
            if all(request["query"].get(name) == _query_text(value) for name, value in listed.items()):
                return exchange
        return None

    def _mark(self, record: StubRecord, matched: str | None) -> None:
        with self._lock:
            record["matched"] = matched

    def _serve(self, http: BaseHTTPRequestHandler) -> None:
        record: StubRecord | None = None
        try:
            raw = _read_body(http)
            if raw is None:
                _write(http, {"status": 413, "body": {"argusStub": "body-too-large"}})
                return
            path, query = _split_target(http.path)
            headers = _lowercase_headers(http.headers.items())
            request: StubRequest = {
                "method": http.command.upper(),
                "path": path,
                "query": query,
                "headers": headers,
                "body": _parse_body(raw, headers.get("content-type")),
            }
            record = {**copy.deepcopy(request), "matched": None}
            with self._lock:
                self._log.append(record)
            if self._handler is not None:
                try:
                    handled = self._handler(copy.deepcopy(request))
                except Exception:  # noqa: BLE001 - a failing handler answers 500, never kills the stub
                    self._mark(record, "handler-error")
                    _write(http, {"status": 500, "body": {"argusStub": "handler-error"}})
                    return
                if handled is not None:
                    self._mark(record, "handler")
                    _write(http, handled)
                    return
            with self._lock:
                exchange = self._match(request)
                record["matched"] = exchange["id"] if exchange else None
                response = copy.deepcopy(exchange["response"]) if exchange else _UNMATCHED
            _write(http, response)
        except Exception:  # noqa: BLE001 - report stub faults as 500 instead of a dropped socket
            if record is not None:
                self._mark(record, "handler-error")
            if not getattr(http, "_argus_started", False):
                try:
                    _write(http, {"status": 500, "body": {"argusStub": "stub-error"}})
                except Exception:  # noqa: BLE001 - the client is gone
                    pass
            http.close_connection = True


def _request_handler(stub: StubServer) -> type[BaseHTTPRequestHandler]:
    class ArgusStubRequestHandler(BaseHTTPRequestHandler):
        # HTTP/1.0: every response closes its connection, so stop() never waits on keep-alive.
        protocol_version = "HTTP/1.0"
        server_version = "ArgusStub"
        sys_version = ""

        def __getattr__(self, name: str) -> Any:
            # BaseHTTPRequestHandler dispatches to do_<METHOD>; serve every method token.
            if name.startswith("do_"):
                return lambda: stub._serve(self)
            raise AttributeError(name)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - base class signature
            """Keep test output clean; the stub's own log is requests()."""

    return ArgusStubRequestHandler


def _validate_exchange(exchange: Any) -> None:
    exchange_id = exchange.get("id") if isinstance(exchange, Mapping) else None
    if not isinstance(exchange_id, str) or not _EXCHANGE_ID.match(exchange_id):
        raise TypeError(f"invalid stub exchange id: {exchange_id!r}")
    request = exchange.get("request")
    if not isinstance(request, Mapping) or not isinstance(request.get("method"), str) or not _METHOD.match(request["method"]):
        raise TypeError(f"stub exchange {exchange_id}: request.method must be an uppercase HTTP method")
    path = request.get("path")
    if not isinstance(path, str) or not path.startswith("/") or "?" in path:
        raise TypeError(f'stub exchange {exchange_id}: request.path must start with "/" and carry no query string')
    if request.get("query") is not None and not isinstance(request["query"], Mapping):
        raise TypeError(f"stub exchange {exchange_id}: request.query must be a map")
    _validate_response(exchange.get("response"), f"stub exchange {exchange_id}")


def _validate_response(response: Any, label: str) -> None:
    status = response.get("status") if isinstance(response, Mapping) else None
    if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
        raise TypeError(f"{label}: response.status must be an integer HTTP status")
    headers = response.get("headers")
    if headers is not None and not isinstance(headers, Mapping):
        raise TypeError(f"{label}: response.headers must be a map")
    for name in headers or {}:
        if not isinstance(name, str) or not _HEADER_NAME.match(name):
            raise TypeError(f"{label}: header names must be lowercase tokens: {name}")


def _write(http: BaseHTTPRequestHandler, response: StubResponse) -> None:
    _validate_response(response, "stub response")
    status = response["status"]
    headers = {name: str(value) for name, value in (response.get("headers") or {}).items()}
    payload: bytes | None = None
    if "body" in response:
        body = response["body"]
        if isinstance(body, str):
            payload = body.encode("utf-8")
            headers.setdefault("content-type", "text/plain; charset=utf-8")
        elif isinstance(body, (bytes, bytearray, memoryview)):
            payload = bytes(body)
            headers.setdefault("content-type", "application/octet-stream")
        else:
            payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers.setdefault("content-type", "application/json")
    # 204 and 304 carry no content by definition.
    bodyless = status in (204, 304)
    if payload is not None and not bodyless:
        headers["content-length"] = str(len(payload))
    http._argus_started = True  # type: ignore[attr-defined]
    http.send_response(status)
    for name, value in headers.items():
        http.send_header(name, value)
    http.end_headers()
    if payload and not bodyless and http.command != "HEAD":
        http.wfile.write(payload)


def _read_body(http: BaseHTTPRequestHandler) -> bytes | None:
    """The request body, or None when it exceeds MAX_BODY_BYTES."""
    if "chunked" in (http.headers.get("transfer-encoding") or "").lower():
        return _read_chunked(http)
    length = int(http.headers.get("content-length") or 0)
    if length < 0:
        raise ValueError("negative content-length")
    if length > MAX_BODY_BYTES:
        http.close_connection = True
        return None
    return http.rfile.read(length) if length else b""


def _read_chunked(http: BaseHTTPRequestHandler) -> bytes | None:
    chunks: list[bytes] = []
    size = 0
    while True:
        line = http.rfile.readline(65537)
        chunk = int(line.split(b";", 1)[0].strip() or b"0", 16)
        if chunk == 0:
            while http.rfile.readline(65537) not in (b"\r\n", b"\n", b""):
                pass  # trailer fields are ignored
            return b"".join(chunks)
        size += chunk
        if size > MAX_BODY_BYTES:
            http.close_connection = True
            return None
        chunks.append(http.rfile.read(chunk))
        http.rfile.readline(65537)


def _parse_body(raw: bytes, content_type: str | None) -> Any:
    """Parsed JSON for a JSON content type, the text otherwise, None when empty."""
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    if not content_type or not _JSON_TYPE.search(content_type):
        return text
    try:
        return json.loads(text)
    except ValueError:
        return text


def _lowercase_headers(items: Any) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in items:
        key = name.lower()
        headers[key] = f"{headers[key]}, {value}" if key in headers else value
    return headers


def _split_target(target: str) -> tuple[str, dict[str, Any]]:
    """Path and query of a request target.

    An origin-form target ('/a?b') is split as written, so '//x/y' stays a path instead of
    becoming a host; an absolute-form target keeps only its path and query.
    """
    if target.startswith("/"):
        path, _, rest = target.partition("?")
        return path.partition("#")[0], _to_query(rest.partition("#")[0])
    parts = urlsplit(target)
    return parts.path or "/", _to_query(parts.query)


def _to_query(query_string: str) -> dict[str, Any]:
    grouped: dict[str, list[str]] = {}
    for name, value in parse_qsl(query_string, keep_blank_values=True):
        grouped.setdefault(name, []).append(value)
    return {name: values[0] if len(values) == 1 else values for name, values in grouped.items()}


def _query_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
