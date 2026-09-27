"""Growth-rate oracle for N+1 and over-fetch defects.

It needs no latency budget: it compares the product with itself at several collection sizes
and requires the cost of one read to grow sub-linearly. The size is how many records the
collection (or the parent's child collection) holds, never the page size: a read of one
fixed-size page, or of an aggregate, should stay nearly flat in payload and grow slowly in
time. A per-item query fan-out shows up as a time exponent near 1, a server that returns
everything as a bytes exponent near 1. A RED raises AssertionError (product); every misuse
raises TypeError (automation).
"""
from __future__ import annotations

import math
import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .boundary import _show


@dataclass(frozen=True)
class ScalingSample:
    """One measured read: the collection size, the time in ms, and the payload in bytes."""

    size: int | float
    ms: int | float
    bytes: int | float


@dataclass(frozen=True)
class ScalingPoint:
    """The median ms and bytes of one size, and how many samples it took them from."""

    size: int | float
    ms: int | float
    bytes: int | float
    runs: int


@dataclass(frozen=True)
class ScalingAnalysis:
    #: The median ms and bytes per size, in ascending size order.
    points: list[ScalingPoint]
    time_exponent: float
    bytes_exponent: float
    ok: bool
    violations: list[str]


def analyze_scaling(
    samples: Sequence[ScalingSample | Mapping[str, Any]],
    *,
    max_time_exponent: float = 0.5,
    max_bytes_exponent: float = 0.1,
) -> ScalingAnalysis:
    """Median per size, then a growth exponent from the smallest to the largest size.

    Each sample is a ScalingSample or a ``{"size", "ms", "bytes"}`` mapping. The median of an
    even count is the mean of the two middle values. Each exponent is
    log(m_last / m_first) / log(s_last / s_first): 1 is linear growth, 0 is flat. Equal
    medians give 0, and a median that grows from 0 gives infinity. The analysis is ok when
    time_exponent <= max_time_exponent (default 0.5) and bytes_exponent <= max_bytes_exponent
    (default 0.1). Pure: it returns every violation and never asserts.
    """
    time_limit, bytes_limit = _thresholds(max_time_exponent, max_bytes_exponent, "analyze_scaling")
    if not isinstance(samples, (list, tuple)) or len(samples) == 0:
        raise TypeError("analyze_scaling: samples must be a non-empty list of ScalingSample or {size, ms, bytes}")
    by_size: dict[int | float, list[ScalingSample]] = {}
    for index, raw in enumerate(samples):
        sample = _read_sample(raw, index)
        by_size.setdefault(sample.size, []).append(sample)
    if len(by_size) < 2:
        raise TypeError("analyze_scaling: samples must cover at least two distinct sizes")
    points = [
        ScalingPoint(
            size=size,
            ms=statistics.median(sample.ms for sample in group),
            bytes=statistics.median(sample.bytes for sample in group),
            runs=len(group),
        )
        for size, group in sorted(by_size.items())
    ]
    first, last = points[0], points[-1]
    time_exponent = _exponent(first.ms, last.ms, first.size, last.size)
    bytes_exponent = _exponent(first.bytes, last.bytes, first.size, last.size)
    violations: list[str] = []
    if time_exponent > time_limit:
        violations.append(
            f"time exponent {_format(time_exponent)} > {_format(time_limit)} "
            f"(median {_format(first.ms)} ms at size {_format(first.size)} -> {_format(last.ms)} ms at size {_format(last.size)})"
        )
    if bytes_exponent > bytes_limit:
        violations.append(
            f"bytes exponent {_format(bytes_exponent)} > {_format(bytes_limit)} "
            f"(median {_format(first.bytes)} bytes at size {_format(first.size)} -> {_format(last.bytes)} bytes at size {_format(last.size)})"
        )
    return ScalingAnalysis(points=points, time_exponent=time_exponent, bytes_exponent=bytes_exponent, ok=not violations, violations=violations)


def n1_scaling(
    *,
    measure: Callable[[int | float], Mapping[str, Any]],
    sizes: Sequence[int | float],
    runs: int = 5,
    warmup: int = 1,
    max_time_exponent: float = 0.5,
    max_bytes_exponent: float = 0.1,
) -> ScalingAnalysis:
    """Measure one read at every size and require sub-linear growth.

    ``measure(size)`` arranges a collection of ``size`` records (idempotently: it is called
    several times per size) and returns ``{"ms": ..., "bytes": ...}`` for one read. ``sizes``
    holds at least three ascending sizes; for a paged read the smallest one fills the page, so
    a correct payload stays flat. Per size, the first ``warmup`` measurements (default 1) are
    discarded and the next ``runs`` (default 5) are kept; analyze_scaling judges the kept
    samples against the thresholds.
    """
    if not callable(measure):
        raise TypeError("n1_scaling: measure must be a callable")
    if not isinstance(sizes, (list, tuple)) or len(sizes) < 3:
        raise TypeError("n1_scaling: sizes must list at least three collection sizes")
    for index, size in enumerate(sizes):
        if not _is_finite(size) or size <= 0:
            raise TypeError(f"n1_scaling: sizes[{index}] must be a finite number > 0, got {_show(size)}")
        if index > 0 and size <= sizes[index - 1]:
            raise TypeError("n1_scaling: sizes must be strictly ascending")
    if isinstance(runs, bool) or not isinstance(runs, int) or runs < 1:
        raise TypeError(f"n1_scaling: runs must be a positive integer, got {_show(runs)}")
    if isinstance(warmup, bool) or not isinstance(warmup, int) or warmup < 0:
        raise TypeError(f"n1_scaling: warmup must be a non-negative integer, got {_show(warmup)}")
    time_limit, bytes_limit = _thresholds(max_time_exponent, max_bytes_exponent, "n1_scaling")
    samples: list[ScalingSample] = []
    for size in sizes:
        for call in range(warmup + runs):
            measured = measure(size)
            if not isinstance(measured, Mapping):
                raise TypeError(f"n1_scaling: measure({_format(size)}) must return {{ms, bytes}}")
            if call >= warmup:
                samples.append(ScalingSample(size=size, ms=measured.get("ms"), bytes=measured.get("bytes")))
    analysis = analyze_scaling(samples, max_time_exponent=time_limit, max_bytes_exponent=bytes_limit)
    if not analysis.ok:
        table = "; ".join(f"size {_format(point.size)}: {_format(point.ms)} ms, {_format(point.bytes)} bytes" for point in analysis.points)
        raise AssertionError(f"n1_scaling: the read does not scale sub-linearly: {'; '.join(analysis.violations)}\nmedians: {table}")
    return analysis


def _read_sample(raw: Any, index: int) -> ScalingSample:
    if isinstance(raw, ScalingSample):
        size, ms, payload = raw.size, raw.ms, raw.bytes
    elif isinstance(raw, Mapping):
        size, ms, payload = raw.get("size"), raw.get("ms"), raw.get("bytes")
    else:
        raise TypeError(f"analyze_scaling: sample {index} must be a ScalingSample or {{size, ms, bytes}}")
    if not _is_finite(size) or size <= 0:
        raise TypeError(f"analyze_scaling: sample {index} size must be a finite number > 0, got {_show(size)}")
    for label, value in (("ms", ms), ("bytes", payload)):
        if not _is_finite(value) or value < 0:
            raise TypeError(f"analyze_scaling: sample {index} {label} must be a finite number >= 0, got {_show(value)}")
    return ScalingSample(size=size, ms=ms, bytes=payload)


def _thresholds(max_time_exponent: Any, max_bytes_exponent: Any, label: str) -> tuple[float, float]:
    for name, value in (("max_time_exponent", max_time_exponent), ("max_bytes_exponent", max_bytes_exponent)):
        if not _is_finite(value):
            raise TypeError(f"{label}: {name} must be a finite number, got {_show(value)}")
    return max_time_exponent, max_bytes_exponent


def _exponent(first_value: float, last_value: float, first_size: float, last_size: float) -> float:
    if first_value == last_value:
        return 0.0
    if first_value == 0:
        return math.inf
    if last_value == 0:
        return -math.inf
    return math.log(last_value / first_value) / math.log(last_size / first_size)


def _is_finite(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _format(value: float) -> str:
    """Three decimals at most, and no trailing .0: 1, 0.301, 200; inf stays inf."""
    if not math.isfinite(value):
        return str(value)
    rounded = round(value, 3)
    return str(int(rounded)) if rounded == int(rounded) else repr(rounded)
