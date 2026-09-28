"""Contract testing mechanised: validate live responses against the OpenAPI schema.

The spec IS the oracle — instead of hand-rolled per-field asserts, point a response
at a schema (`#/components/schemas/X`) and let the strict oracle find every mismatch.
Each mismatch is a contract-drift bug candidate.

ADAPT-ME: set OPENAPI_PATH to the spec Kalchas found. If it is YAML, convert first
(``python -c "import json,yaml,sys; json.dump(yaml.safe_load(open('openapi.yaml')), open('openapi.json','w'))"``)
or fetch it from the live ``/openapi.json`` endpoint at setup and save it locally.

``SchemaOracle`` keeps the historical API on top of ``qa.oracles``: ``assert_matches``
delegates to the strict ``assert_schema_ref`` (JSON Schema 2020-12 with format checking,
OpenAPI 3.0 ``nullable`` and boolean exclusive bounds normalized, writeOnly properties absent
from responses, and every undocumented field RED). Prefer ``qa.oracles.assert_schema(res,
operation_id)`` when the response status is part of the contract.
"""
from __future__ import annotations

import os
from typing import Any

from qa.oracles.schema import assert_schema_ref, schema_violations


class SchemaOracle:
    """Validate response bodies against named schemas in an OpenAPI document (strict)."""

    def __init__(self, openapi_path: str | None = None) -> None:
        self._path = openapi_path or os.environ.get("OPENAPI_PATH") or "./openapi.json"

    @staticmethod
    def _normalise(ref: str) -> str:
        """Accept either a full JSON pointer ('#/components/schemas/X') or a bare name ('X')."""
        return ref if ref.startswith("#") else f"#/components/schemas/{ref}"

    def errors(self, instance: Any, ref: str) -> list[str]:
        """Return human-readable strict schema violations (empty list == valid)."""
        return schema_violations(instance, self._normalise(ref), strict=True, openapi_path=self._path)

    def assert_matches(self, instance: Any, ref: str) -> None:
        """Assert `instance` strictly conforms to the named schema; raise with all violations."""
        assert_schema_ref(instance, self._normalise(ref), strict=True, openapi_path=self._path)
