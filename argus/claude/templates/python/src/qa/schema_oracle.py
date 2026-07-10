"""Contract testing mechanised: validate live responses against the OpenAPI schema.

The spec IS the oracle — instead of hand-rolled per-field asserts, point a response
at a schema (`#/components/schemas/X`) and let jsonschema find every mismatch. Each
mismatch is a contract-drift bug candidate.

ADAPT-ME: set OPENAPI_PATH to the spec Kalchas found. If it is YAML, convert first
(``python -c "import json,yaml,sys; json.dump(yaml.safe_load(open('openapi.yaml')), open('openapi.json','w'))"``)
or fetch it from the live ``/openapi.json`` endpoint at setup and save it locally.

Uses the modern ``referencing`` registry (jsonschema >= 4.18) so internal
``$ref`` pointers resolve against the whole document. OpenAPI 3.1 schemas are
JSON Schema 2020-12; 3.0 schemas validate too (unknown keywords like ``nullable``
are ignored).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

# Arbitrary internal base URI the whole OpenAPI doc is registered under, so that
# "#/components/schemas/X" resolves to a node inside it.
_BASE_URI = "urn:oas"


class SchemaOracle:
    """Validate response bodies against named schemas in an OpenAPI document."""

    def __init__(self, openapi_path: str | None = None) -> None:
        self._path = openapi_path or os.environ.get("OPENAPI_PATH", "./openapi.json")
        self._registry: Registry | None = None

    def _ensure_registry(self) -> Registry:
        if self._registry is None:
            doc = json.loads(Path(self._path).read_text(encoding="utf-8"))
            # default_specification handles OpenAPI docs that omit "$schema".
            resource = Resource.from_contents(doc, default_specification=DRAFT202012)
            self._registry = Registry().with_resource(uri=_BASE_URI, resource=resource)
        return self._registry

    @staticmethod
    def _normalise(ref: str) -> str:
        """Accept either a full JSON pointer ('#/components/schemas/X') or a bare name ('X')."""
        return ref if ref.startswith("#") else f"#/components/schemas/{ref}"

    def errors(self, instance: Any, ref: str) -> list[str]:
        """Return human-readable schema violations (empty list == valid)."""
        registry = self._ensure_registry()
        pointer = self._normalise(ref)
        validator = Draft202012Validator(
            {"$ref": f"{_BASE_URI}{pointer}"},
            registry=registry,
        )
        return [
            f"{'/'.join(str(p) for p in err.path) or '<root>'}: {err.message}"
            for err in sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
        ]

    def assert_matches(self, instance: Any, ref: str) -> None:
        """Assert `instance` conforms to the named schema; raise with all violations."""
        problems = self.errors(instance, ref)
        if problems:
            body = json.dumps(instance)[:500]
            raise AssertionError(
                f"response does not match {ref}:\n" + "\n".join(problems) + f"\nbody: {body}"
            )
