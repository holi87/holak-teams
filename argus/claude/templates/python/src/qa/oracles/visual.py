"""Layout bounds oracle.

An element that renders off-screen, overflows its own box, or sits under another element at a
phone width is RED; these are the layout defects a screenshot diff misses when no baseline
exists yet. ``evaluate_bounds`` is the pure rule set, and ``visual_bounds`` collects the
measurements from a live page through a Playwright (sync API) Locator. A RED raises
AssertionError (product); every misuse raises TypeError (automation).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .boundary import _show

#: Runs in the page: scroll the element into view, undo any sideways page scroll (a page that
#: overflows horizontally must not scroll the defect out of sight), then measure it.
_MEASURE_SCRIPT = """(element) => {
  element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return {
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
    scroll_width: element.scrollWidth,
    client_width: element.clientWidth,
    top_element_is_self: top !== null && (top === element || element.contains(top)),
  };
}"""


@dataclass(frozen=True)
class BoundsRect:
    """getBoundingClientRect() of the element, in CSS pixels."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class Viewport:
    """The visible viewport (documentElement.clientWidth x window.innerHeight)."""

    width: float
    height: float


@dataclass(frozen=True)
class BoundsMeasurement:
    rect: BoundsRect
    viewport: Viewport
    #: The element's own scrollWidth and clientWidth: content wider than the box overflows.
    scroll_width: float
    client_width: float
    #: True when document.elementFromPoint at the element's center is the element or a descendant.
    top_element_is_self: bool


@dataclass(frozen=True)
class BoundsVerdict:
    ok: bool
    violations: list[str]


def evaluate_bounds(measurement: BoundsMeasurement) -> BoundsVerdict:
    """The layout rules, in this order.

    x < 0 (renders past the left edge), y < 0 (renders above the top edge),
    x + width > viewport.width (renders past the right edge), scroll_width > client_width (the
    content overflows the element's box), and top_element_is_self False (another element
    covers the element's center). Pure: it returns every violation and never asserts.
    """
    if not isinstance(measurement, BoundsMeasurement):
        raise TypeError("evaluate_bounds: pass a BoundsMeasurement")
    rect, viewport = measurement.rect, measurement.viewport
    if not isinstance(rect, BoundsRect):
        raise TypeError("evaluate_bounds: rect must be a BoundsRect(x, y, width, height)")
    if not isinstance(viewport, Viewport):
        raise TypeError("evaluate_bounds: viewport must be a Viewport(width, height)")
    for label, value in (
        ("rect.x", rect.x),
        ("rect.y", rect.y),
        ("rect.width", rect.width),
        ("rect.height", rect.height),
        ("viewport.width", viewport.width),
        ("viewport.height", viewport.height),
        ("scroll_width", measurement.scroll_width),
        ("client_width", measurement.client_width),
    ):
        if not _is_finite(value):
            raise TypeError(f"evaluate_bounds: {label} must be a finite number, got {_show(value)}")
    if rect.width < 0 or rect.height < 0 or viewport.width <= 0 or viewport.height <= 0:
        raise TypeError("evaluate_bounds: sizes must be non-negative and the viewport non-empty")
    if not isinstance(measurement.top_element_is_self, bool):
        raise TypeError("evaluate_bounds: top_element_is_self must be a bool")
    right = rect.x + rect.width
    violations: list[str] = []
    if rect.x < 0:
        violations.append(f"renders past the left edge (x {_px(rect.x)})")
    if rect.y < 0:
        violations.append(f"renders above the top edge (y {_px(rect.y)})")
    if right > viewport.width:
        violations.append(f"renders past the right edge (right {_px(right)} > viewport width {_px(viewport.width)})")
    if measurement.scroll_width > measurement.client_width:
        violations.append(
            f"content overflows the box (scroll_width {_px(measurement.scroll_width)} > client_width {_px(measurement.client_width)})"
        )
    if not measurement.top_element_is_self:
        violations.append("another element covers its center (occluded)")
    return BoundsVerdict(ok=not violations, violations=violations)


def visual_bounds(locator: Any, *, viewport_width: int = 375) -> BoundsMeasurement:
    """Measure ``locator`` at ``viewport_width`` CSS pixels (default 375, a phone) and require evaluate_bounds to pass.

    The page viewport is resized to that width (the height is kept), the element is scrolled
    into view with the page's horizontal scroll kept at 0, and the original viewport is
    restored afterwards (a context without a fixed viewport keeps the new size). The locator
    must resolve to exactly one element.
    """
    if isinstance(viewport_width, bool) or not isinstance(viewport_width, int) or viewport_width < 1:
        raise TypeError(f"visual_bounds: viewport_width must be a positive integer, got {_show(viewport_width)}")
    if not callable(getattr(locator, "evaluate", None)) or getattr(locator, "page", None) is None:
        raise TypeError("visual_bounds: pass a Playwright Locator")
    page = locator.page
    original = page.viewport_size
    try:
        page.set_viewport_size({"width": viewport_width, "height": original["height"] if original else 812})
        raw = locator.evaluate(_MEASURE_SCRIPT)
    finally:
        if original:
            page.set_viewport_size(original)
    measurement = _read_measurement(raw)
    verdict = evaluate_bounds(measurement)
    if not verdict.ok:
        raise AssertionError(f"visual_bounds at {viewport_width}px: {locator} {'; '.join(verdict.violations)}")
    return measurement


def _read_measurement(raw: Any) -> BoundsMeasurement:
    """The page's plain measurement as a BoundsMeasurement; evaluate_bounds validates the numbers."""
    try:
        rect, viewport = raw["rect"], raw["viewport"]
        return BoundsMeasurement(
            rect=BoundsRect(x=rect["x"], y=rect["y"], width=rect["width"], height=rect["height"]),
            viewport=Viewport(width=viewport["width"], height=viewport["height"]),
            scroll_width=raw["scroll_width"],
            client_width=raw["client_width"],
            top_element_is_self=raw["top_element_is_self"],
        )
    except (KeyError, TypeError):
        raise TypeError("visual_bounds: the locator did not return a bounds measurement") from None


def _is_finite(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _px(value: float) -> str:
    """Two decimals at most, and no trailing .0: -4, -0.5, 376."""
    rounded = round(value, 2)
    return str(int(rounded)) if rounded == int(rounded) else repr(rounded)
