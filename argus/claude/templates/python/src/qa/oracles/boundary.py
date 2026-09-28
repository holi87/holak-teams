"""Boundary value and exact-sum oracles.

The step is the domain's smallest unit (money 0.01, a count 1), never a blind integer +-1,
and all arithmetic is exact: probe values are computed with decimal.Decimal and every sum is
compared in scaled integers, because floating-point money drifts by a penny exactly where
these oracles look. A RED raises AssertionError (product); every misuse raises TypeError
(automation).
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Context, Decimal, localcontext
from typing import Literal, Union

Number = Union[int, float, Decimal]
Amount = Union[str, int, float, Decimal]
Verdict = Literal["accepted", "rejected"]

# Wide enough that no sum or difference of real-world amounts is ever rounded.
_EXACT = Context(prec=1000)
_PLAIN_DECIMAL = re.compile(r"([+-]?)([0-9]+)(?:\.([0-9]+))?")
_MAX_PLACES = 18


@dataclass(frozen=True)
class BoundaryPoint:
    """One probed value with its documented and observed outcome."""

    value: Number
    expected: Verdict
    actual: Verdict


@dataclass(frozen=True)
class BoundaryPoints:
    below: BoundaryPoint
    at: BoundaryPoint
    above: BoundaryPoint


@dataclass(frozen=True)
class MoneyReconciliation:
    """The parts' sum and the total, both formatted at the minor-unit precision."""

    sum: str
    total: str


def boundary3(
    *,
    boundary: Number,
    step: Number,
    probe: Callable[[Number], bool],
    accept_below: bool,
    accept_at: bool,
    accept_above: bool,
) -> BoundaryPoints:
    """Three-point boundary value analysis: probe B - step, B, and B + step, in that order.

    Each documented outcome is required; ``probe(value)`` returns True when the product
    accepted the value. The probe values are exact decimals in the inputs' type: Decimal
    when either input is a Decimal, int when both are ints, otherwise the float nearest the
    exact decimal. So boundary 0.07 with step 0.01 probes exactly 0.06, 0.07, and 0.08,
    never 0.060000000000000005. Call it once per edge of a range.
    """
    exact_boundary = _decimal(boundary, "boundary3: boundary")
    exact_step = _decimal(step, "boundary3: step")
    if exact_step <= 0:
        raise TypeError(f"boundary3: step must be a finite number > 0 (the domain's smallest unit), got {step!r}")
    if not callable(probe):
        raise TypeError("boundary3: probe must be a callable")
    for name, flag in (("accept_below", accept_below), ("accept_at", accept_at), ("accept_above", accept_above)):
        if not isinstance(flag, bool):
            raise TypeError(f"boundary3: {name} must be a bool")
    with localcontext(_EXACT):
        plan = (
            ("below", exact_boundary - exact_step, accept_below),
            ("at", exact_boundary, accept_at),
            ("above", exact_boundary + exact_step, accept_above),
        )
    points: dict[str, BoundaryPoint] = {}
    wrong: list[str] = []
    for name, exact, expected in plan:
        result = probe(_like(exact, boundary, step))
        if not isinstance(result, bool):
            raise TypeError("boundary3: probe must return True (accepted) or False (rejected)")
        point = BoundaryPoint(value=_like(exact, boundary, step), expected=_verdict(expected), actual=_verdict(result))
        points[name] = point
        if point.expected != point.actual:
            wrong.append(f"value {_plain(exact)} expected {point.expected}, got {point.actual}")
    if wrong:
        raise AssertionError(f"boundary3 at {_plain(exact_boundary)} (step {_plain(exact_step)}): {'; '.join(wrong)}")
    return BoundaryPoints(below=points["below"], at=points["at"], above=points["above"])


def money_reconciles(parts: Sequence[Amount], total: Amount, *, minor_units: int = 2) -> MoneyReconciliation:
    """Money reconciles to the minor unit.

    The parts, parsed as decimal strings into integer minor units, must sum exactly to the
    total. An amount is a decimal string, an int, a Decimal, or a float (read through its
    shortest round-trip form, repr). An amount with more fractional digits than
    ``minor_units`` (default 2) is RED, which is how floating-point money such as
    0.30000000000000004 surfaces.
    """
    _require_places(minor_units, "money_reconciles: minor_units")
    if not isinstance(parts, (list, tuple)):
        raise TypeError("money_reconciles: parts must be a list or tuple of amounts")
    problems: list[str] = []
    minor = [_scaled(part, minor_units, f"part {index}", problems) for index, part in enumerate(parts)]
    expected = _scaled(total, minor_units, "total", problems)
    if problems:
        raise AssertionError(f"money_reconciles: unusable amounts: {'; '.join(problems)}")
    parts_sum = sum(value or 0 for value in minor)
    target = expected or 0
    if parts_sum != target:
        raise AssertionError(
            f"money_reconciles: the parts sum to {_format_scaled(parts_sum, minor_units)}, the total is "
            f"{_format_scaled(target, minor_units)} (difference {_format_scaled(parts_sum - target, minor_units)})"
        )
    return MoneyReconciliation(sum=_format_scaled(parts_sum, minor_units), total=_format_scaled(target, minor_units))


def percentages_sum_to_100(values: Sequence[Amount], *, decimals: int = 0) -> str:
    """A percentage breakdown sums to exactly 100; returns the sum at ``decimals`` places.

    Each value is scaled to an integer at ``decimals`` places (default 0) and the sum must
    equal 100 * 10**decimals. A value with more fractional digits than ``decimals`` is RED.
    """
    _require_places(decimals, "percentages_sum_to_100: decimals")
    if not isinstance(values, (list, tuple)) or len(values) == 0:
        raise TypeError("percentages_sum_to_100: values must be a non-empty list or tuple")
    problems: list[str] = []
    scaled = [_scaled(value, decimals, f"value {index}", problems) for index, value in enumerate(values)]
    if problems:
        raise AssertionError(f"percentages_sum_to_100: unusable values: {'; '.join(problems)}")
    total = sum(value or 0 for value in scaled)
    if total != 100 * 10**decimals:
        raise AssertionError(f"percentages_sum_to_100: the values sum to {_format_scaled(total, decimals)}, not exactly 100")
    return _format_scaled(total, decimals)


# --- Exact decimals, shared with partitions.py --------------------------------------------


def _decimal(value: object, label: str) -> Decimal:
    """An int, float, or Decimal as an exact Decimal; a float through its shortest round-trip form."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise TypeError(f"{label} must be a finite number, got {_show(value)}")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError(f"{label} must be a finite number, got {value!r}")
        return Decimal(repr(value))
    if not value.is_finite():
        raise TypeError(f"{label} must be a finite number, got {value}")
    return value


def _json_number(value: Decimal) -> int | float:
    """A JSON-ready number: an int when the decimal is integral, else the nearest float."""
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _plain(value: Decimal) -> str:
    """Plain decimal notation without trailing zeros: 100 for 1E+2, 0.5 for 0.50, 0 for -0."""
    if value == 0:
        return "0"
    return format(value.normalize(_EXACT), "f")


def _show(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return repr(value)


# --- Helpers ----------------------------------------------------------------------------


def _like(value: Decimal, *inputs: object) -> Number:
    if any(isinstance(item, Decimal) for item in inputs):
        return value
    if all(isinstance(item, int) for item in inputs):
        return int(value)
    return float(value)


def _require_places(value: object, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _MAX_PLACES:
        raise TypeError(f"{label} must be an integer from 0 to {_MAX_PLACES}, got {value!r}")


def _amount_text(value: Amount, label: str) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise TypeError(f"{label} must be a decimal string or a number, got {type(value).__name__}")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return format(Decimal(repr(value)), "f") if math.isfinite(value) else repr(value)
    return format(value, "f") if value.is_finite() else str(value)


def _scaled(value: Amount, places: int, label: str, problems: list[str]) -> int | None:
    """Parse a decimal amount into an integer at ``places``; a problem is recorded instead of raised."""
    text = _amount_text(value, label)
    match = _PLAIN_DECIMAL.fullmatch(text)
    if not match:
        problems.append(f"{label} {_show(text)} is not a plain decimal")
        return None
    sign, whole, fraction = match.group(1), match.group(2), match.group(3) or ""
    if len(fraction) > places and fraction[places:].strip("0"):
        problems.append(f"{label} {text} has more than {places} decimal places")
        return None
    scaled = int(whole) * 10**places + int(fraction[:places].ljust(places, "0") or "0")
    return -scaled if sign == "-" else scaled


def _format_scaled(value: int, places: int) -> str:
    digits = str(abs(value)).rjust(places + 1, "0")
    whole = digits[: len(digits) - places]
    fraction = f".{digits[len(digits) - places:]}" if places > 0 else ""
    return f"{'-' if value < 0 else ''}{whole}{fraction}"


def _verdict(value: bool) -> Verdict:
    return "accepted" if value else "rejected"
