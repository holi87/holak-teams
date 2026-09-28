"""Invalid equivalence partitions generated from a field schema.

One invalid value per declared constraint, each isolated as far as the schema allows, with
fixed labels in a fixed order that every runtime port keeps. A partition generator asserts
nothing itself; a test sends every value and expects the documented rejection (one exact
status code).

Input is a raw OpenAPI 3.0 or 3.1 field schema as a dict: ``nullable: true``, a type list
such as ``["string", "null"]``, and the boolean exclusiveMinimum/exclusiveMaximum form are
read as written. Resolve $ref and allOf/oneOf/anyOf into one field schema first. Numbers are
computed exactly (decimal.Decimal) and returned as JSON-ready ints and floats. Every misuse
raises TypeError (automation).
"""
from __future__ import annotations

import copy
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Any, Literal, TypeVar

from .boundary import _EXACT, _decimal, _json_number, _plain, _show
from .identity import INVALID_EMAILS

T = TypeVar("T")


@dataclass(frozen=True)
class Partition:
    """One invalid value and the fixed label of the constraint it breaks."""

    label: str
    value: Any


#: The candidates string.pattern-mismatch tries, in order; the first one the pattern rejects wins.
PATTERN_MISMATCH_CANDIDATES: tuple[str, ...] = ("", " ", "!", "0", "a", "\x00")

#: string.above-max-length is omitted above this many characters: that probe is a load test, not a partition.
MAX_GENERATED_LENGTH = 1_048_576

_TYPES = ("string", "integer", "number", "boolean", "object", "array")
_UNSAFE_INTEGER = 2**53
_HALF = Decimal("0.5")
_GridDirection = Literal["below", "above", "at-or-above", "at-or-below"]


@dataclass
class _Bounds:
    minimum: Decimal | None = None
    maximum: Decimal | None = None
    exclusive_minimum: Decimal | None = None
    exclusive_maximum: Decimal | None = None

    def any(self) -> bool:
        return any(value is not None for value in (self.minimum, self.maximum, self.exclusive_minimum, self.exclusive_maximum))


def invalid_partitions(field_schema: Mapping[str, Any], *, number_step: int | float | Decimal | None = None) -> list[Partition]:
    """One invalid value per declared constraint, in this order:

    * format email: email.missing-at, email.missing-domain, email.missing-local-part,
      email.double-at, email.embedded-whitespace;
    * string: string.below-min-length ('a' repeated minLength - 1), string.above-max-length,
      string.pattern-mismatch (the first PATTERN_MISMATCH_CANDIDATES entry the pattern
      rejects; omitted when it accepts all), string.empty (minLength >= 1),
      type.number-for-string;
    * integer and number: number.below-minimum, number.above-maximum,
      number.exclusive-minimum-equal, number.exclusive-maximum-equal,
      number.fractional-for-integer, number.unsafe-integer (2**53, an integer without a
      maximum), number.multiple-of-violation, type.string-for-number (a valid value as a
      string);
    * enum: enum.out-of-enum; boolean: type.string-for-boolean;
    * type.null-for-non-nullable, last, whenever the schema constrains the type and null is
      not allowed.

    ``number_step`` is the smallest unit of a bounded ``number`` field without multipleOf
    (money 0.01, a percentage 1) and is required for such a field; an integer's step is 1
    (or its integer multipleOf) and a multipleOf is its own step.
    """
    return _in_context("invalid_partitions", lambda: _field_partitions(field_schema, number_step))


def invalid_object_partitions(
    object_schema: Mapping[str, Any],
    valid_example: Mapping[str, Any],
    *,
    number_step: int | float | Decimal | None = None,
    number_steps: Mapping[str, int | float | Decimal] | None = None,
) -> list[Partition]:
    """Invalid request bodies for an object schema, built from a valid example.

    object.missing-required.<field> for each required field (in ``required`` order),
    object.extra-field (unless additionalProperties or patternProperties allow extra fields),
    object.null-body, object.wrong-type-body, then field.<name>.<label> for every property in
    schema order with that one property replaced by an invalid_partitions value. readOnly
    properties are skipped: they are not part of a request. ``number_steps`` overrides
    ``number_step`` per property. Every value is a fresh deep copy.
    """
    schema = _in_context("invalid_object_partitions", lambda: _require_schema(object_schema))
    declared = schema.get("type")
    if declared is not None and declared != "object" and not (isinstance(declared, list) and "object" in declared):
        raise TypeError(f"invalid_object_partitions: the schema must describe an object, got type {_show(declared)}")
    properties = schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    if not isinstance(valid_example, Mapping):
        raise TypeError("invalid_object_partitions: valid_example must be a dict")
    if number_steps is not None and not isinstance(number_steps, Mapping):
        raise TypeError("invalid_object_partitions: number_steps must map property names to steps")
    for name in required:
        if not isinstance(name, str):
            raise TypeError("invalid_object_partitions: required must list property names")
        if name not in valid_example:
            raise TypeError(f"invalid_object_partitions: valid_example lacks the required field {name}")

    def fresh() -> dict[str, Any]:
        return copy.deepcopy(dict(valid_example))

    partitions: list[Partition] = []
    for name in required:
        body = fresh()
        del body[name]
        partitions.append(Partition(f"object.missing-required.{name}", body))
    additional = schema.get("additionalProperties")
    open_object = additional is True or isinstance(additional, Mapping) or isinstance(schema.get("patternProperties"), Mapping)
    if not open_object:
        extra = "argusUndocumentedField"
        while extra in properties or extra in valid_example:
            extra += "X"
        partitions.append(Partition("object.extra-field", {**fresh(), extra: "argus"}))
    partitions.append(Partition("object.null-body", None))
    partitions.append(Partition("object.wrong-type-body", [fresh()]))
    for name, prop in properties.items():
        if isinstance(prop, Mapping) and prop.get("readOnly") is True:
            continue
        own = number_steps.get(name) if number_steps is not None else None
        step = number_step if own is None else own
        field =_in_context(f"invalid_object_partitions: property {name}", lambda: _field_partitions(prop, step))
        for partition in field:
            partitions.append(Partition(f"field.{name}.{partition.label}", {**fresh(), name: partition.value}))
    return partitions


def _field_partitions(field_schema: Any, number_step: Any) -> list[Partition]:
    schema = _require_schema(field_schema)
    field_type, nullable = _field_type(schema)
    partitions: list[Partition] = []

    def add(label: str, value: Any) -> None:
        partitions.append(Partition(label, value))

    if field_type == "string":
        _string_partitions(schema, add)
    if field_type in ("integer", "number"):
        _number_partitions(schema, field_type == "integer", number_step, add)
    enum = schema.get("enum")
    enumerated = isinstance(enum, list)
    if enumerated:
        outside = _out_of_enum(enum, field_type)
        if outside is not None:
            add("enum.out-of-enum", outside)
    if field_type == "boolean":
        add("type.string-for-boolean", "true")
    if (field_type is not None or enumerated) and not nullable:
        add("type.null-for-non-nullable", None)
    return partitions


def _string_partitions(schema: Mapping[str, Any], add: Callable[[str, Any], None]) -> None:
    min_length = _optional_count(schema.get("minLength"), "minLength")
    max_length = _optional_count(schema.get("maxLength"), "maxLength")
    if schema.get("format") == "email":
        for email in INVALID_EMAILS:
            add(email.label, email.value)
    if min_length is not None and min_length >= 1:
        add("string.below-min-length", "a" * (min_length - 1))
    if max_length is not None and max_length < MAX_GENERATED_LENGTH:
        add("string.above-max-length", "a" * (max_length + 1))
    if "pattern" in schema:
        pattern = _compile_pattern(schema["pattern"])
        mismatch = next((candidate for candidate in PATTERN_MISMATCH_CANDIDATES if not pattern.search(candidate)), None)
        if mismatch is not None:
            add("string.pattern-mismatch", mismatch)
    if min_length is not None and min_length >= 1:
        add("string.empty", "")
    add("type.number-for-string", 1)


def _number_partitions(schema: Mapping[str, Any], integer: bool, number_step: Any, add: Callable[[str, Any], None]) -> None:
    bounds = _read_bounds(schema)
    multiple_of = _optional_number(schema.get("multipleOf"), "multipleOf")
    if multiple_of is not None and multiple_of <= 0:
        raise TypeError("multipleOf must be greater than 0")
    step_value = None if number_step is None else _decimal(number_step, "number_step")
    if step_value is not None and step_value <= 0:
        raise TypeError(f"number_step must be a finite number > 0, got {number_step!r}")
    # The grid every valid value sits on: multipleOf, 1 for a plain integer, none otherwise.
    if integer:
        grid: Decimal | None = multiple_of if multiple_of is not None and _integral(multiple_of) else Decimal(1)
    else:
        grid = multiple_of
    if grid is None and bounds.any() and step_value is None:
        raise TypeError(
            "a bounded number field without multipleOf needs number_step, the domain's smallest unit "
            "(money 0.01, a percentage 1); never a blind +-1"
        )
    with localcontext(_EXACT):
        step = grid if grid is not None else step_value
        anchor = _valid_anchor(bounds, grid, step)

        def upper(value: Decimal) -> bool:
            return (bounds.maximum is None or value <= bounds.maximum) and (
                bounds.exclusive_maximum is None or value < bounds.exclusive_maximum
            )

        if bounds.minimum is not None:
            below = _on_grid(bounds.minimum, grid, "below") if grid is not None else bounds.minimum - step
            add("number.below-minimum", _json_number(below))
        if bounds.maximum is not None:
            above = _on_grid(bounds.maximum, grid, "above") if grid is not None else bounds.maximum + step
            add("number.above-maximum", _json_number(above))
        if bounds.exclusive_minimum is not None:
            add("number.exclusive-minimum-equal", _json_number(bounds.exclusive_minimum))
        if bounds.exclusive_maximum is not None:
            add("number.exclusive-maximum-equal", _json_number(bounds.exclusive_maximum))
        if integer:
            fractional = anchor + _HALF if upper(anchor + _HALF) else anchor - _HALF
            add("number.fractional-for-integer", _json_number(fractional))
        if integer and bounds.maximum is None and bounds.exclusive_maximum is None:
            add("number.unsafe-integer", _UNSAFE_INTEGER)
        if multiple_of is not None:
            delta = Decimal(1) if integer else multiple_of / 2
            candidate = anchor + delta if upper(anchor + delta) else anchor - delta
            if candidate % multiple_of != 0:
                add("number.multiple-of-violation", _json_number(candidate))
        add("type.string-for-number", _plain(anchor))


def _read_bounds(schema: Mapping[str, Any]) -> _Bounds:
    bounds = _Bounds(
        minimum=_optional_number(schema.get("minimum"), "minimum"),
        maximum=_optional_number(schema.get("maximum"), "maximum"),
    )
    # OpenAPI 3.0 writes an exclusive bound as `minimum` plus `exclusiveMinimum: true`; read it
    # as the 3.1 numeric form so both produce the same partitions.
    lower = schema.get("exclusiveMinimum")
    if lower is True:
        if bounds.minimum is None:
            raise TypeError("exclusiveMinimum: true needs minimum")
        bounds.exclusive_minimum, bounds.minimum = bounds.minimum, None
    elif lower is not None and lower is not False:
        bounds.exclusive_minimum = _optional_number(lower, "exclusiveMinimum")
    higher = schema.get("exclusiveMaximum")
    if higher is True:
        if bounds.maximum is None:
            raise TypeError("exclusiveMaximum: true needs maximum")
        bounds.exclusive_maximum, bounds.maximum = bounds.maximum, None
    elif higher is not None and higher is not False:
        bounds.exclusive_maximum = _optional_number(higher, "exclusiveMaximum")
    return bounds


def _valid_anchor(bounds: _Bounds, grid: Decimal | None, step: Decimal | None) -> Decimal:
    """The smallest valid value at or above the lower bound (on the grid); 0 when unbounded."""
    if bounds.minimum is not None:
        return _on_grid(bounds.minimum, grid, "at-or-above") if grid is not None else bounds.minimum
    if bounds.exclusive_minimum is not None:
        return _on_grid(bounds.exclusive_minimum, grid, "above") if grid is not None else bounds.exclusive_minimum + step
    if bounds.maximum is not None:
        return _on_grid(bounds.maximum, grid, "at-or-below") if grid is not None else bounds.maximum
    if bounds.exclusive_maximum is not None:
        return _on_grid(bounds.exclusive_maximum, grid, "below") if grid is not None else bounds.exclusive_maximum - step
    return Decimal(0)


def _on_grid(value: Decimal, grid: Decimal, direction: _GridDirection) -> Decimal:
    """The nearest multiple of ``grid`` relative to ``value``, computed in scaled integers."""
    places = max(0, -_exponent(value), -_exponent(grid))
    scaled_value = int(value.scaleb(places, _EXACT))
    scaled_grid = int(grid.scaleb(places, _EXACT))
    floor = scaled_value // scaled_grid
    ceiling = -(-scaled_value // scaled_grid)
    k = {"below": ceiling - 1, "above": floor + 1, "at-or-above": ceiling, "at-or-below": floor}[direction]
    return Decimal(k * scaled_grid).scaleb(-places, _EXACT)


def _exponent(value: Decimal) -> int:
    exponent = value.as_tuple().exponent
    return exponent if isinstance(exponent, int) else 0


def _integral(value: Decimal) -> bool:
    return value == value.to_integral_value()


def _out_of_enum(values: list[Any], field_type: str | None) -> Any:
    members = [value for value in values if value is not None]
    if not members:
        return None

    def has(candidate: Any) -> bool:
        return any(_strictly_equal(member, candidate) for member in members)

    if field_type == "boolean" or all(isinstance(member, bool) for member in members):
        return next((candidate for candidate in (False, True) if not has(candidate)), None)
    if field_type in ("integer", "number") or all(_is_number(member) for member in members):
        numbers = [member for member in members if _is_number(member)]
        candidate = math.floor(max([*numbers, 0])) + 1
        while has(candidate):
            candidate += 1
        return candidate
    candidate_text = "argus-out-of-enum"
    while has(candidate_text):
        candidate_text += "-x"
    return candidate_text


def _strictly_equal(left: Any, right: Any) -> bool:
    """JSON scalar equality as JavaScript ===: True never equals 1 (bool is no number here), 1 equals 1.0."""
    if _is_number(left) and _is_number(right):
        return left == right
    return type(left) is type(right) and left == right


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float, Decimal)) and not isinstance(value, bool)


def _field_type(schema: Mapping[str, Any]) -> tuple[str | None, bool]:
    declared = schema.get("type")
    listed = [] if declared is None else list(declared) if isinstance(declared, (list, tuple)) else [declared]
    if not all(isinstance(entry, str) for entry in listed):
        raise TypeError("type must be a string or a list of strings")
    types = [entry for entry in listed if entry != "null"]
    if len(types) > 1:
        raise TypeError(f"one field type is required, got {_show(declared)}")
    field_type = types[0] if types else None
    if field_type is not None and field_type not in _TYPES:
        raise TypeError(f"unsupported type {_show(field_type)}")
    enum = schema.get("enum")
    nullable = schema.get("nullable") is True or "null" in listed or (isinstance(enum, list) and any(value is None for value in enum))
    return field_type, nullable


def _require_schema(schema: Any) -> Mapping[str, Any]:
    if not isinstance(schema, Mapping):
        raise TypeError("the schema must be a schema object")
    for keyword in ("$ref", "allOf", "oneOf", "anyOf"):
        if keyword in schema:
            raise TypeError(f"resolve {keyword} into one schema first")
    return schema


def _in_context(context: str, body: Callable[[], T]) -> T:
    """Run ``body``, prefixing a TypeError (a usage error) with ``context``."""
    try:
        return body()
    except TypeError as error:
        raise TypeError(f"{context}: {error}") from error


def _compile_pattern(pattern: Any) -> re.Pattern[str]:
    if not isinstance(pattern, str):
        raise TypeError("pattern must be a string")
    # JSON Schema patterns are not implicitly anchored; search() matches like ECMA-262 test().
    try:
        return re.compile(pattern)
    except re.error:
        raise TypeError(f"pattern {_show(pattern)} is not a valid regular expression") from None


def _optional_number(value: Any, label: str) -> Decimal | None:
    return None if value is None else _decimal(value, label)


def _optional_count(value: Any, label: str) -> int | None:
    """A non-negative integer; an integral float such as 2.0 reads as 2, as JSON numbers do."""
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TypeError(f"{label} must be a non-negative integer, got {_show(value)}")
    return value
