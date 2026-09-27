"""Argus oracle library. Tests import every helper from here.

Each RED raises AssertionError (the outcome adapter reports a product failure); each misuse
raises TypeError or ValueError (automation), and a missing OpenAPI document raises
ArgusPrerequisiteError (infrastructure).
"""
from .http import (
    REDACTED,
    REST_STATUS,
    HttpSnapshot,
    RestState,
    assert_rest_status,
    describe_result,
    expect_status,
    mask_text,
    read_result,
    redact,
    redacted_excerpt,
    status_of,
)
from .openapi import (
    HTTP_METHODS,
    Direction,
    OpenApiDocument,
    OperationRef,
    declares_open_object,
    default_openapi_path,
    find_operation,
    list_operations,
    load_openapi,
    normalize,
    ref_segments,
    resolve_ref,
    strict_use_site,
    to_pointer,
)
from .replay import (
    IdempotencyReplay,
    ReplayResult,
    idempotent_replay,
    next_idempotency_key,
    replay_with_idempotency_key,
)
from .schema import (
    assert_schema,
    assert_schema_ref,
    assert_schema_strict,
    schema_violations,
)

__all__ = [
    # http
    "REDACTED",
    "REST_STATUS",
    "HttpSnapshot",
    "RestState",
    "assert_rest_status",
    "describe_result",
    "expect_status",
    "mask_text",
    "read_result",
    "redact",
    "redacted_excerpt",
    "status_of",
    # openapi
    "HTTP_METHODS",
    "Direction",
    "OpenApiDocument",
    "OperationRef",
    "declares_open_object",
    "default_openapi_path",
    "find_operation",
    "list_operations",
    "load_openapi",
    "normalize",
    "ref_segments",
    "resolve_ref",
    "strict_use_site",
    "to_pointer",
    # replay
    "IdempotencyReplay",
    "ReplayResult",
    "idempotent_replay",
    "next_idempotency_key",
    "replay_with_idempotency_key",
    # schema
    "assert_schema",
    "assert_schema_ref",
    "assert_schema_strict",
    "schema_violations",
]
