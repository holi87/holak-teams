"""Strict OpenAPI schema oracles (JSON Schema 2020-12 through jsonschema + referencing).

Contract testing mechanised: validate live responses against the OpenAPI schema instead of
hand-rolled per-field assertions. The spec IS the oracle; every mismatch is a contract-drift
bug candidate. Strict mode is the default: an undocumented field is RED. Opting out needs a
written reason, which stays visible in the test source.

Usage::

    assert_schema(res, "getOrder")                       # by operationId and status
    assert_schema_ref(res.json(), "#/components/schemas/Order")

A violation raises AssertionError listing the violations plus a redacted body excerpt of at
most 500 characters. Misuse (an unknown operationId or schema, strict=False without a reason)
raises ValueError or TypeError; a missing document raises ArgusPrerequisiteError.

ADAPT-ME: OPENAPI_PATH (default ./openapi.json) names the JSON spec; see openapi.py.
"""
from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from .http import SECRET_KEY, describe_result, mask_text, read_result, redact, redacted_excerpt
from .openapi import (
    Direction,
    declares_open_object,
    default_openapi_path,
    find_operation,
    load_openapi,
    normalize,
    ref_segments,
    resolve_ref,
    to_pointer,
)

# Internal base URI the normalized document is registered under, so that
# "#/components/schemas/X" inside it resolves to a node of the same document.
DOC_ID = "urn:argus-openapi"
MAX_LISTED_ERRORS = 20
_MAX_MESSAGE = 300
_JSON_MEDIA = re.compile(r"^application/([\w.+-]+\+)?json\s*(;.*)?$", re.IGNORECASE)
_UNEVALUATED = re.compile(r"^Unevaluated properties are not allowed \((.*) (?:was|were) unexpected\)$", re.DOTALL)


@dataclass
class _Variant:
    doc: dict[str, Any]
    registry: Registry
    validators: dict[str, Draft202012Validator] = field(default_factory=dict)


# Per resolved document path: the file stamp it was loaded at and its (direction, strict) views.
_loaded: dict[Path, tuple[str, dict[tuple[str, bool], _Variant]]] = {}


def assert_schema(
    response: Any,
    operation_id: str,
    strict: bool = True,
    reason: str | None = None,
    *,
    openapi_path: str | os.PathLike[str] | None = None,
) -> None:
    """Validate a response against ``responses[key].content['application/json'].schema``.

    The key is the exact status, else its ``NXX`` range, else ``default`` (OpenAPI 3.x);
    failure messages name a range or default key. A status none of them covers is RED; a
    status documented without content requires an empty body. Accepts an httpx or
    Playwright response or a plain ``{status, body}`` record.
    """
    is_strict = _strictness(strict, reason)
    variant = _variant("response", is_strict, openapi_path)
    operation = find_operation(variant.doc, operation_id)
    snapshot = read_result(response)
    responses = operation.operation.get("responses")
    responses = responses if isinstance(responses, dict) else {}
    key = _response_key(responses, snapshot.status)
    if key is None:
        documented = ", ".join(responses) or "none"
        raise AssertionError(f"{operation_id}: HTTP {snapshot.status} is not documented (documented: {documented}): {describe_result(snapshot)}")
    where = f"HTTP {snapshot.status}" if key == str(snapshot.status) else f"HTTP {snapshot.status} via {key}"
    if operation.path.startswith("webhooks:"):
        pointer = ["webhooks", operation.path[len("webhooks:"):], operation.method, "responses", key]
    else:
        pointer = ["paths", operation.path, operation.method, "responses", key]
    documented_response = responses[key]
    # A documented response may be a reference to components.responses (possibly chained).
    hops = 0
    while isinstance(documented_response, dict) and isinstance(documented_response.get("$ref"), str):
        segments = ref_segments(documented_response["$ref"])
        if segments is None or hops > 10:
            raise ValueError(f"{operation_id}: {where} response reference {documented_response['$ref']} cannot be resolved")
        pointer = segments
        documented_response = resolve_ref(variant.doc, documented_response["$ref"])
        hops += 1
    if not isinstance(documented_response, dict):
        raise ValueError(f"{operation_id}: {where} response is not a response object")
    content = documented_response.get("content")
    content = content if isinstance(content, dict) else {}
    if not content:
        if not snapshot.empty:
            raise AssertionError(f"{operation_id}: {where} documents no content, but the body is not empty: {describe_result(snapshot)}")
        return
    media_type = "application/json" if "application/json" in content else next((name for name in content if _JSON_MEDIA.match(name)), None)
    if media_type is None:
        raise ValueError(f"{operation_id}: {where} documents no JSON media type ({', '.join(content)}); assert_schema validates JSON bodies only")
    media = content[media_type]
    if not isinstance(media, dict) or "schema" not in media:
        return
    ref = to_pointer([*pointer, "content", media_type, "schema"])
    validator = _compile(variant, f"op:{ref}", {"$ref": f"{DOC_ID}{ref}"})
    _raise_on_violations(_violations(validator, snapshot.body, variant.doc), snapshot.body, f"{operation_id} {where} ({media_type})", is_strict, reason)


def assert_schema_ref(
    body: Any,
    ref: str,
    strict: bool = True,
    reason: str | None = None,
    *,
    direction: Direction = "response",
    openapi_path: str | os.PathLike[str] | None = None,
) -> None:
    """Validate a body against a schema by reference, for example ``#/components/schemas/Order``."""
    problems = schema_violations(body, ref, strict, reason, direction=direction, openapi_path=openapi_path)
    _raise_on_violations(problems, body, ref, _strictness(strict, reason), reason)


def assert_schema_strict(
    body: Any,
    ref: str,
    *,
    direction: Direction = "response",
    openapi_path: str | os.PathLike[str] | None = None,
) -> None:
    """``assert_schema_ref`` with strict mode forced."""
    assert_schema_ref(body, ref, strict=True, direction=direction, openapi_path=openapi_path)


def schema_violations(
    body: Any,
    ref: str,
    strict: bool = True,
    reason: str | None = None,
    *,
    direction: Direction = "response",
    openapi_path: str | os.PathLike[str] | None = None,
) -> list[str]:
    """The violations ``assert_schema_ref`` would report, as ``<location>: <message>`` lines."""
    is_strict = _strictness(strict, reason)
    if not isinstance(ref, str) or not ref.startswith("#/"):
        raise TypeError(f"schema reference must be a local JSON pointer such as '#/components/schemas/X', got {ref!r}")
    variant = _variant(direction, is_strict, openapi_path)
    if resolve_ref(variant.doc, ref) is None:
        raise ValueError(f"schema {ref} is not defined in the OpenAPI document")
    inner = {"$ref": f"{DOC_ID}{ref}"}
    # The validated body is a use site, so strict mode closes it like any other.
    closed = is_strict and not declares_open_object({"$ref": ref}, variant.doc)
    root = {"allOf": [inner], "unevaluatedProperties": False} if closed else inner
    return _violations(_compile(variant, f"ref:{ref}", root), body, variant.doc)


def _response_key(responses: dict[str, Any], status: int) -> str | None:
    """The ``responses`` key documenting ``status``: exact, else ``1XX``..``5XX``, else ``default``."""
    candidates = [str(status), f"{status // 100}XX" if 100 <= status <= 599 else None, "default"]
    return next((key for key in candidates if key is not None and key in responses), None)


def _strictness(strict: Any, reason: str | None) -> bool:
    if strict is None or strict:
        return True
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("strict=False needs a non-empty reason naming why undocumented fields are acceptable here")
    return False


def _variant(direction: Direction, strict: bool, openapi_path: str | os.PathLike[str] | None) -> _Variant:
    path = Path(openapi_path).resolve() if openapi_path is not None else default_openapi_path()
    try:
        stat = path.stat()
        stamp = f"{stat.st_mtime_ns}:{stat.st_size}"
    except OSError:
        stamp = "missing"  # load_openapi reports the missing prerequisite below.
    cached = _loaded.get(path)
    if cached is None or cached[0] != stamp:
        cached = (stamp, {})
        _loaded[path] = cached
    variant = cached[1].get((direction, strict))
    if variant is None:
        doc = normalize(load_openapi(path), direction, strict)
        resource = Resource.from_contents(doc, default_specification=DRAFT202012)
        variant = _Variant(doc=doc, registry=Registry().with_resource(uri=DOC_ID, resource=resource))
        cached[1][(direction, strict)] = variant
    return variant


def _compile(variant: _Variant, key: str, schema: dict[str, Any]) -> Draft202012Validator:
    validator = variant.validators.get(key)
    if validator is None:
        validator = Draft202012Validator(schema, registry=variant.registry, format_checker=Draft202012Validator.FORMAT_CHECKER)
        variant.validators[key] = validator
    return validator


def _violations(validator: Draft202012Validator, body: Any, doc: dict[str, Any]) -> list[str]:
    errors = list(validator.iter_errors(body))
    described: list[tuple[ValidationError, str]] = []
    for error in errors:
        message = _unevaluated_message(error, doc) if error.validator == "unevaluatedProperties" else error.message
        if message is not None:
            described.append((error, message))
    if not described and errors:
        described = [(error, error.message) for error in errors]  # never turn a RED into silence
    # Specific violations first, then the undocumented properties; identical lines once.
    described.sort(key=lambda item: (item[0].validator == "unevaluatedProperties", [str(part) for part in item[0].absolute_path]))
    return list(dict.fromkeys(_describe(error, message) for error, message in described))


def _unevaluated_message(error: ValidationError, doc: dict[str, Any]) -> str | None:
    """The unevaluatedProperties message without the keys an allOf member declares.

    jsonschema counts a key as evaluated only when the allOf member declaring it is valid,
    so one invalid member makes every key it declares look undocumented. Those keys already
    have their own violation; only genuinely undocumented keys are listed here.
    """
    if error.validator_value is not False or not isinstance(error.instance, dict):
        return error.message
    match = _UNEVALUATED.match(error.message)
    if not match:
        return error.message
    try:
        flagged = ast.literal_eval(f"[{match.group(1)}]")
    except (SyntaxError, ValueError):
        return error.message
    names, patterns = _declared_properties(error.schema, doc, set())
    kept = [key for key in flagged if key not in names and not any(_search(pattern, key) for pattern in patterns)]
    if not kept:
        return None
    return f"Unevaluated properties are not allowed ({', '.join(repr(key) for key in kept)} {'was' if len(kept) == 1 else 'were'} unexpected)"


def _declared_properties(schema: Any, doc: dict[str, Any], seen: set[str]) -> tuple[set[str], list[str]]:
    """Property names and patterns S declares through properties, $ref, and allOf."""
    names: set[str] = set()
    patterns: list[str] = []
    if not isinstance(schema, dict):
        return names, patterns
    if isinstance(schema.get("properties"), dict):
        names.update(schema["properties"])
    if isinstance(schema.get("patternProperties"), dict):
        patterns.extend(schema["patternProperties"])
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref not in seen:
        seen.add(ref)
        local = ref[len(DOC_ID):] if ref.startswith(DOC_ID) else ref
        nested = _declared_properties(resolve_ref(doc, local), doc, seen)
        names.update(nested[0])
        patterns.extend(nested[1])
    for member in schema.get("allOf") or []:
        nested = _declared_properties(member, doc, seen)
        names.update(nested[0])
        patterns.extend(nested[1])
    return names, patterns


def _search(pattern: str, key: str) -> bool:
    try:
        return re.search(pattern, key) is not None
    except re.error:
        return False


def _describe(error: ValidationError, message: str) -> str:
    path = list(error.absolute_path)
    where = "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in path) if path else "(root)"
    if any(isinstance(part, str) and SECRET_KEY.search(part) for part in path):
        # jsonschema messages embed the value; below a secret-looking key only the keyword is shown.
        message = f"{error.validator} constraint failed (value redacted)"
    else:
        if isinstance(error.instance, (dict, list)):
            message = message.replace(repr(error.instance), repr(redact(error.instance)))
        message = mask_text(message)
    if len(message) > _MAX_MESSAGE:
        message = f"{message[:_MAX_MESSAGE - 1]}…"
    return f"{where}: {message}"


def _raise_on_violations(problems: list[str], body: Any, label: str, strict: bool, reason: str | None) -> None:
    if not problems:
        return
    mode = "strict" if strict else f"lenient: {reason}"
    lines = [f"- {problem}" for problem in problems[:MAX_LISTED_ERRORS]]
    if len(problems) > MAX_LISTED_ERRORS:
        lines.append(f"- … {len(problems) - MAX_LISTED_ERRORS} more")
    listing = "\n".join(lines)
    raise AssertionError(f"{label}: body does not match the schema ({mode})\n{listing}\nbody: {redacted_excerpt(body)}")
