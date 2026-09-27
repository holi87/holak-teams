"""Argus oracle library. Tests import every helper from here.

Each RED raises AssertionError (the outcome adapter reports a product failure); each misuse
raises TypeError or ValueError (automation), and a missing OpenAPI document raises
ArgusPrerequisiteError (infrastructure).
"""
from .boundary import (
    BoundaryPoint,
    BoundaryPoints,
    MoneyReconciliation,
    boundary3,
    money_reconciles,
    percentages_sum_to_100,
)
from .concurrency import (
    START_GATE_TIMEOUT_SECONDS,
    DoubleSubmitResult,
    RaceResult,
    concurrent_race,
    double_submit,
)
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
from .i18n import (
    I18N_VECTORS,
    I18nVector,
    i18n_charset,
)
from .identity import (
    DEFAULT_PASSWORD,
    IDENTITY_VECTORS,
    INVALID_EMAILS,
    CredentialCheck,
    CredentialReport,
    Credentials,
    IdentityVectors,
    InvalidEmail,
    UnicodeEdge,
    Whitespace,
    case_variants,
    credential_consistency,
    valid_email,
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
from .pagination import (
    PageRequest,
    PageResult,
    PaginationResult,
    assert_collection_conservation,
    paginate_all,
)
from .partitions import (
    MAX_GENERATED_LENGTH,
    PATTERN_MISMATCH_CANDIDATES,
    Partition,
    invalid_object_partitions,
    invalid_partitions,
)
from .replay import (
    IdempotencyReplay,
    ReplayResult,
    idempotent_replay,
    next_idempotency_key,
    replay_with_idempotency_key,
)
from .scaling import (
    ScalingAnalysis,
    ScalingPoint,
    ScalingSample,
    analyze_scaling,
    n1_scaling,
)
from .schema import (
    assert_schema,
    assert_schema_ref,
    assert_schema_strict,
    schema_violations,
)
from .state import (
    SoftDeleteResult,
    soft_delete_sweep,
)
from .visual import (
    BoundsMeasurement,
    BoundsRect,
    BoundsVerdict,
    Viewport,
    evaluate_bounds,
    visual_bounds,
)

__all__ = [
    # boundary
    "BoundaryPoint",
    "BoundaryPoints",
    "MoneyReconciliation",
    "boundary3",
    "money_reconciles",
    "percentages_sum_to_100",
    # concurrency
    "START_GATE_TIMEOUT_SECONDS",
    "DoubleSubmitResult",
    "RaceResult",
    "concurrent_race",
    "double_submit",
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
    # i18n
    "I18N_VECTORS",
    "I18nVector",
    "i18n_charset",
    # identity
    "DEFAULT_PASSWORD",
    "IDENTITY_VECTORS",
    "INVALID_EMAILS",
    "CredentialCheck",
    "CredentialReport",
    "Credentials",
    "IdentityVectors",
    "InvalidEmail",
    "UnicodeEdge",
    "Whitespace",
    "case_variants",
    "credential_consistency",
    "valid_email",
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
    # pagination
    "PageRequest",
    "PageResult",
    "PaginationResult",
    "assert_collection_conservation",
    "paginate_all",
    # partitions
    "MAX_GENERATED_LENGTH",
    "PATTERN_MISMATCH_CANDIDATES",
    "Partition",
    "invalid_object_partitions",
    "invalid_partitions",
    # replay
    "IdempotencyReplay",
    "ReplayResult",
    "idempotent_replay",
    "next_idempotency_key",
    "replay_with_idempotency_key",
    # scaling
    "ScalingAnalysis",
    "ScalingPoint",
    "ScalingSample",
    "analyze_scaling",
    "n1_scaling",
    # schema
    "assert_schema",
    "assert_schema_ref",
    "assert_schema_strict",
    "schema_violations",
    # state
    "SoftDeleteResult",
    "soft_delete_sweep",
    # visual
    "BoundsMeasurement",
    "BoundsRect",
    "BoundsVerdict",
    "Viewport",
    "evaluate_bounds",
    "visual_bounds",
]
