"""OpenAPI loading and normalization for the strict schema oracle.

ADAPT-ME: point OPENAPI_PATH at the JSON spec Kalchas found (convert YAML first:
``python -c "import json,yaml; json.dump(yaml.safe_load(open('openapi.yaml')), open('openapi.json','w'))"``),
or save the live Swagger document at setup.

``normalize()`` turns an OpenAPI 3.x document into one JSON Schema 2020-12 view per
direction. OpenAPI 3.0 keywords are converted (nullable, boolean exclusiveMinimum/
exclusiveMaximum; example, xml, externalDocs, and deprecated are dropped). A response never
documents writeOnly properties and a request never documents readOnly ones. Strict mode
closes every use site with ``unevaluatedProperties: false``, which, unlike
``additionalProperties: false``, still accepts properties that allOf siblings declare.
"""
from __future__ import annotations

import copy
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import quote, unquote

from qa.argus.errors import ArgusPrerequisiteError

Direction = Literal["response", "request"]
OpenApiDocument = dict[str, Any]
Json = dict[str, Any]
RootKind = Literal["component", "use-site", "other"]
RootMapper = Callable[[Any, RootKind], Any]

HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace", "query")

_SINGLE_SUBSCHEMAS = (
    "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems",
    "unevaluatedProperties", "additionalItems", "additionalProperties", "items",
)
_LIST_SUBSCHEMAS = ("allOf", "anyOf", "oneOf", "prefixItems", "items")
_MAP_SUBSCHEMAS = ("properties", "patternProperties", "$defs", "definitions", "dependentSchemas")
_LEGACY_DROPPED = ("example", "xml", "externalDocs", "deprecated")
_OPEN_OBJECT_KEYWORDS = ("additionalProperties", "unevaluatedProperties", "patternProperties")
_INNER_SINGLE = (
    "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems",
    "unevaluatedProperties", "additionalItems",
)
_INNER_MAPS = ("patternProperties", "$defs", "definitions", "dependentSchemas")
_ARRAY_INDEX = re.compile(r"^(0|[1-9][0-9]*)$")


@dataclass(frozen=True)
class OperationRef:
    """One operation of the document: its path key, lowercase method, and operation object."""

    path: str
    method: str
    operation: Json


def default_openapi_path() -> Path:
    """The configured document: OPENAPI_PATH, read at call time, else ./openapi.json."""
    return Path(os.environ.get("OPENAPI_PATH") or "./openapi.json").resolve()


def load_openapi(path: str | os.PathLike[str] | None = None) -> OpenApiDocument:
    """Read and parse the OpenAPI document (JSON). A missing file is a missing prerequisite."""
    absolute = Path(path).resolve() if path is not None else default_openapi_path()
    if not absolute.is_file():
        raise ArgusPrerequisiteError(f"OpenAPI document not found; set OPENAPI_PATH (resolved to {absolute})")
    try:
        doc = json.loads(absolute.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ValueError(
            f"OpenAPI document {absolute} is not JSON; convert YAML first (see qa.oracles.openapi)"
        ) from None
    if not _is_object(doc) or not isinstance(doc.get("openapi"), str) or not re.match(r"^3\.\d+", doc["openapi"]):
        raise ValueError(f"OpenAPI document {absolute} is not an OpenAPI 3.x document")
    return doc


def normalize(doc: OpenApiDocument, direction: Direction, strict: bool = True) -> OpenApiDocument:
    """A normalized deep copy; the input document is never mutated. Strict mode defaults on."""
    if direction not in ("response", "request"):
        raise ValueError("normalize: direction must be 'response' or 'request'")
    legacy = isinstance(doc.get("openapi"), str) and doc["openapi"].startswith("3.0")
    hidden = "writeOnly" if direction == "response" else "readOnly"
    converted = copy.deepcopy(doc)
    _map_schema_roots(converted, lambda schema, _kind: _convert(schema, doc, legacy, hidden))
    if not strict:
        return converted
    closed = copy.deepcopy(converted)

    def close(schema: Any, kind: RootKind) -> Any:
        if kind == "component":
            return _close_use_sites(schema, converted)
        if kind == "use-site":
            return strict_use_site(schema, converted)
        return schema

    _map_schema_roots(closed, close)
    return closed


def strict_use_site(schema: Any, doc: OpenApiDocument) -> Any:
    """Strict use site: ``{allOf: [S], unevaluatedProperties: false}``, S's own use sites closed.

    S stays open when, after shallow $ref/allOf resolution, it explicitly declares
    additionalProperties, unevaluatedProperties, or patternProperties.
    """
    if not _is_object(schema):
        return schema
    inner = _close_use_sites(schema, doc)
    return inner if declares_open_object(schema, doc) else {"allOf": [inner], "unevaluatedProperties": False}


def declares_open_object(schema: Any, doc: OpenApiDocument, seen: set[str] | None = None) -> bool:
    """True when S, after shallow $ref/allOf resolution, declares how extra properties behave."""
    if not _is_object(schema):
        return False
    seen = set() if seen is None else seen
    if any(keyword in schema for keyword in _OPEN_OBJECT_KEYWORDS):
        return True
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref not in seen:
        seen.add(ref)
        if declares_open_object(resolve_ref(doc, ref), doc, seen):
            return True
    members = schema.get("allOf")
    return isinstance(members, list) and any(declares_open_object(member, doc, seen) for member in members)


def resolve_ref(doc: OpenApiDocument, ref: str) -> Any:
    """Resolve a local reference such as ``#/components/schemas/Order``; None when absent."""
    segments = ref_segments(ref)
    if segments is None:
        return None
    current: Any = doc
    for segment in segments:
        if isinstance(current, list) and _ARRAY_INDEX.match(segment) and int(segment) < len(current):
            current = current[int(segment)]
        elif _is_object(current) and segment in current:
            current = current[segment]
        else:
            return None
    return current


def ref_segments(ref: str) -> list[str] | None:
    """Segments of a local reference ('#' or '#/a/b'); percent-decoded, then ~1 and ~0."""
    if ref == "#":
        return []
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    try:
        return [unquote(segment, errors="strict").replace("~1", "/").replace("~0", "~") for segment in ref[2:].split("/")]
    except UnicodeDecodeError:
        return None


def to_pointer(segments: list[str]) -> str:
    """A URI fragment JSON pointer, for example ['paths', '/a/{id}'] -> #/paths/~1a~1%7Bid%7D."""
    return "#/" + "/".join(quote(segment.replace("~", "~0").replace("/", "~1"), safe="-_.!~*'()") for segment in segments)


def list_operations(doc: OpenApiDocument) -> list[OperationRef]:
    """Every operation in paths (and webhooks), in document order."""
    found: list[OperationRef] = []
    for container in ("paths", "webhooks"):
        items = doc.get(container)
        if not _is_object(items):
            continue
        for path, item in items.items():
            if not _is_object(item):
                continue
            for method in HTTP_METHODS:
                operation = item.get(method)
                if _is_object(operation):
                    key = path if container == "paths" else f"webhooks:{path}"
                    found.append(OperationRef(path=key, method=method, operation=operation))
    return found


def find_operation(doc: OpenApiDocument, operation_id: str) -> OperationRef:
    """The single operation with this operationId; unknown or duplicate ids raise ValueError."""
    matches = [entry for entry in list_operations(doc) if entry.operation.get("operationId") == operation_id]
    if not matches:
        raise ValueError(f"operationId {json.dumps(operation_id)} is not defined in the OpenAPI document")
    if len(matches) > 1:
        raise ValueError(f"operationId {json.dumps(operation_id)} is defined more than once in the OpenAPI document")
    return matches[0]


# --- Conversion -------------------------------------------------------------------------


def _convert(node: Any, doc: OpenApiDocument, legacy: bool, hidden: str) -> Any:
    if not _is_object(node):
        return node
    schema: Json = dict(node)
    _for_each_subschema(schema, lambda child: _convert(child, doc, legacy, hidden))
    source_properties = node.get("properties")
    if _is_object(source_properties) and _is_object(schema.get("properties")):
        removed = [name for name, value in source_properties.items() if _is_hidden(value, doc, hidden)]
        if removed:
            schema["properties"] = {name: value for name, value in schema["properties"].items() if name not in removed}
            if isinstance(schema.get("required"), list):
                required = [name for name in schema["required"] if name not in removed]
                if required:
                    schema["required"] = required
                else:
                    del schema["required"]
    if not legacy:
        return schema
    for keyword in _LEGACY_DROPPED:
        schema.pop(keyword, None)
    _convert_exclusive(schema, "exclusiveMinimum", "minimum")
    _convert_exclusive(schema, "exclusiveMaximum", "maximum")
    if "nullable" in schema:
        nullable = schema.pop("nullable") is True
        if nullable:
            schema = _add_null(schema)
    return schema


def _is_hidden(prop: Any, doc: OpenApiDocument, hidden: str) -> bool:
    seen: set[str] = set()
    current = prop
    while _is_object(current):
        if current.get(hidden) is True:
            return True
        ref = current.get("$ref")
        if not isinstance(ref, str) or ref in seen:
            return False
        seen.add(ref)
        current = resolve_ref(doc, ref)
    return False


def _convert_exclusive(schema: Json, exclusive: str, inclusive: str) -> None:
    if not isinstance(schema.get(exclusive), bool):
        return
    bound = schema.get(inclusive)
    if schema[exclusive] is True and isinstance(bound, (int, float)) and not isinstance(bound, bool):
        schema[exclusive] = bound
        del schema[inclusive]
    else:
        del schema[exclusive]


def _add_null(schema: Json) -> Json:
    kind = schema.get("type")
    typed = isinstance(kind, (str, list))
    if typed or isinstance(schema.get("enum"), list):
        result = dict(schema)
        if isinstance(kind, str):
            result["type"] = "null" if kind == "null" else [kind, "null"]
        elif isinstance(kind, list) and "null" not in kind:
            result["type"] = [*kind, "null"]
        enum = schema.get("enum")
        if isinstance(enum, list) and None not in enum:
            result["enum"] = [*enum, None]
        return result
    if isinstance(schema.get("$ref"), str) and "anyOf" not in schema:
        siblings = {key: value for key, value in schema.items() if key != "$ref"}
        return {**siblings, "anyOf": [{"$ref": schema["$ref"]}, {"type": "null"}]}
    return {"anyOf": [schema, {"type": "null"}]}


# --- Strict rewriting -------------------------------------------------------------------


def _close_use_sites(node: Any, doc: OpenApiDocument) -> Any:
    """Close the use sites inside S without wrapping S itself (component roots, allOf members)."""
    if not _is_object(node):
        return node
    schema: Json = dict(node)

    def use_site(child: Any) -> Any:
        return strict_use_site(child, doc)

    def inner(child: Any) -> Any:
        return _close_use_sites(child, doc)

    if _is_object(schema.get("properties")):
        schema["properties"] = _map_values(schema["properties"], use_site)
    if _is_object(schema.get("items")):
        schema["items"] = use_site(schema["items"])
    elif isinstance(schema.get("items"), list):
        schema["items"] = [use_site(item) for item in schema["items"]]
    if isinstance(schema.get("prefixItems"), list):
        schema["prefixItems"] = [use_site(item) for item in schema["prefixItems"]]
    if _is_object(schema.get("additionalProperties")):
        schema["additionalProperties"] = use_site(schema["additionalProperties"])
    for keyword in ("oneOf", "anyOf"):
        if isinstance(schema.get(keyword), list):
            schema[keyword] = [use_site(member) for member in schema[keyword]]
    if isinstance(schema.get("allOf"), list):
        schema["allOf"] = [inner(member) for member in schema["allOf"]]
    for keyword in _INNER_SINGLE:
        if _is_object(schema.get(keyword)):
            schema[keyword] = inner(schema[keyword])
    for keyword in _INNER_MAPS:
        if _is_object(schema.get(keyword)):
            schema[keyword] = _map_values(schema[keyword], inner)
    return schema


# --- Document traversal -----------------------------------------------------------------


def _for_each_subschema(schema: Json, fn: Callable[[Any], Any]) -> None:
    for keyword in _SINGLE_SUBSCHEMAS:
        if _is_object(schema.get(keyword)):
            schema[keyword] = fn(schema[keyword])
    for keyword in _LIST_SUBSCHEMAS:
        if isinstance(schema.get(keyword), list):
            schema[keyword] = [fn(child) for child in schema[keyword]]
    for keyword in _MAP_SUBSCHEMAS:
        if _is_object(schema.get(keyword)):
            schema[keyword] = _map_values(schema[keyword], fn)


def _map_schema_roots(doc: Json, fn: RootMapper) -> None:
    """Apply ``fn`` to every schema root.

    Roots are component schemas; request and response body schemas (use sites); parameter
    and header schemas. Reference objects are skipped, because their targets are visited
    where they are defined.
    """
    components = doc.get("components")
    if _is_object(components):
        if _is_object(components.get("schemas")):
            components["schemas"] = _map_values(components["schemas"], lambda schema: fn(schema, "component"))
        for response in _object_values(components.get("responses")):
            _map_response(response, fn)
        for body in _object_values(components.get("requestBodies")):
            _map_content(body.get("content"), fn, "use-site")
        for parameter in _object_values(components.get("parameters")):
            _map_parameter(parameter, fn)
        for header in _object_values(components.get("headers")):
            _map_parameter(header, fn)
        for item in _object_values(components.get("pathItems")):
            _map_path_item(item, fn)
        for callback in _object_values(components.get("callbacks")):
            for item in _object_values(callback):
                _map_path_item(item, fn)
    for item in _object_values(doc.get("paths")):
        _map_path_item(item, fn)
    for item in _object_values(doc.get("webhooks")):
        _map_path_item(item, fn)


def _map_path_item(item: Json, fn: RootMapper) -> None:
    for parameter in _array_objects(item.get("parameters")):
        _map_parameter(parameter, fn)
    for method in HTTP_METHODS:
        operation = item.get(method)
        if not _is_object(operation):
            continue
        for parameter in _array_objects(operation.get("parameters")):
            _map_parameter(parameter, fn)
        if _is_object(operation.get("requestBody")):
            _map_content(operation["requestBody"].get("content"), fn, "use-site")
        for response in _object_values(operation.get("responses")):
            _map_response(response, fn)
        for callback in _object_values(operation.get("callbacks")):
            for nested in _object_values(callback):
                _map_path_item(nested, fn)


def _map_response(response: Json, fn: RootMapper) -> None:
    _map_content(response.get("content"), fn, "use-site")
    for header in _object_values(response.get("headers")):
        _map_parameter(header, fn)


def _map_parameter(parameter: Json, fn: RootMapper) -> None:
    if "schema" in parameter:
        parameter["schema"] = fn(parameter["schema"], "other")
    _map_content(parameter.get("content"), fn, "other")


def _map_content(content: Any, fn: RootMapper, kind: RootKind) -> None:
    for media in _object_values(content):
        if "schema" in media:
            media["schema"] = fn(media["schema"], kind)


# --- Helpers ----------------------------------------------------------------------------


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _object_values(value: Any) -> list[Json]:
    return [item for item in value.values() if _is_object(item)] if _is_object(value) else []


def _array_objects(value: Any) -> list[Json]:
    return [item for item in value if _is_object(item)] if isinstance(value, list) else []


def _map_values(mapping: Json, fn: Callable[[Any], Any]) -> Json:
    return {key: fn(value) for key, value in mapping.items()}
