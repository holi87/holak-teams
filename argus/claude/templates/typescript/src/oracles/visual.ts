import { expect, Locator } from '@playwright/test';

// Layout bounds oracle. An element that renders off-screen, overflows its own box, or sits
// under another element at a phone width is RED; these are the layout defects a screenshot
// diff misses when no baseline exists yet. evaluateBounds is the pure rule set, and
// visualBounds collects the measurements from a live page.

export type BoundsRect = { x: number; y: number; width: number; height: number };

export type BoundsMeasurement = {
  /** getBoundingClientRect() of the element, in CSS pixels. */
  rect: BoundsRect;
  /** The visible viewport (documentElement.clientWidth x window.innerHeight). */
  viewport: { width: number; height: number };
  /** The element's own scrollWidth and clientWidth: content wider than the box overflows. */
  scrollWidth: number;
  clientWidth: number;
  /** True when document.elementFromPoint at the element's center is the element or a descendant. */
  topElementIsSelf: boolean;
};

export type BoundsVerdict = { ok: boolean; violations: string[] };

/**
 * The layout rules, in this order: x < 0 (renders past the left edge), y < 0 (renders
 * above the top edge), x + width > viewport.width (renders past the right edge),
 * scrollWidth > clientWidth (the content overflows the element's box), and
 * topElementIsSelf false (another element covers the element's center). Pure: it returns
 * every violation and never asserts.
 */
export function evaluateBounds(measurement: BoundsMeasurement): BoundsVerdict {
  if (measurement === null || typeof measurement !== 'object') throw new TypeError('evaluateBounds: pass a bounds measurement');
  const { rect, viewport, scrollWidth, clientWidth, topElementIsSelf } = measurement;
  if (rect === null || typeof rect !== 'object') throw new TypeError('evaluateBounds: rect must be {x, y, width, height}');
  if (viewport === null || typeof viewport !== 'object') throw new TypeError('evaluateBounds: viewport must be {width, height}');
  for (const [label, value] of [['rect.x', rect.x], ['rect.y', rect.y], ['rect.width', rect.width], ['rect.height', rect.height], ['viewport.width', viewport.width], ['viewport.height', viewport.height], ['scrollWidth', scrollWidth], ['clientWidth', clientWidth]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`evaluateBounds: ${label} must be a finite number, got ${JSON.stringify(value)}`);
  }
  if (rect.width < 0 || rect.height < 0 || viewport.width <= 0 || viewport.height <= 0) throw new TypeError('evaluateBounds: sizes must be non-negative and the viewport non-empty');
  if (typeof topElementIsSelf !== 'boolean') throw new TypeError('evaluateBounds: topElementIsSelf must be a boolean');
  const right = rect.x + rect.width;
  const violations: string[] = [];
  if (rect.x < 0) violations.push(`renders past the left edge (x ${round(rect.x)})`);
  if (rect.y < 0) violations.push(`renders above the top edge (y ${round(rect.y)})`);
  if (right > viewport.width) violations.push(`renders past the right edge (right ${round(right)} > viewport width ${round(viewport.width)})`);
  if (scrollWidth > clientWidth) violations.push(`content overflows the box (scrollWidth ${scrollWidth} > clientWidth ${clientWidth})`);
  if (!topElementIsSelf) violations.push('another element covers its center (occluded)');
  return { ok: violations.length === 0, violations };
}

/**
 * Measure `locator` at `viewportWidth` CSS pixels (default 375, a phone) and require
 * evaluateBounds to pass. The page viewport is resized to that width (the height is kept),
 * the element is scrolled into view with the page's horizontal scroll kept at 0, and the
 * original viewport is restored afterwards (a context without a fixed viewport keeps the
 * new size). The locator must resolve to exactly one element.
 */
export async function visualBounds(locator: Locator, options: { viewportWidth?: number } = {}): Promise<BoundsMeasurement> {
  const viewportWidth = options.viewportWidth ?? 375;
  if (!Number.isSafeInteger(viewportWidth) || viewportWidth < 1) throw new TypeError(`visualBounds: viewportWidth must be a positive integer, got ${JSON.stringify(viewportWidth)}`);
  if (locator === null || typeof locator !== 'object' || typeof locator.evaluate !== 'function') throw new TypeError('visualBounds: pass a Playwright Locator');
  const page = locator.page();
  const original = page.viewportSize();
  let measurement: BoundsMeasurement;
  try {
    await page.setViewportSize({ width: viewportWidth, height: original?.height ?? 812 });
    measurement = await locator.evaluate((element): BoundsMeasurement => {
      // Scroll the element into view, then undo any sideways page scroll: a page that
      // overflows horizontally must not scroll the defect out of sight.
      element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        topElementIsSelf: top !== null && (top === element || element.contains(top)),
      };
    });
  } finally {
    if (original) await page.setViewportSize(original);
  }
  const verdict = evaluateBounds(measurement);
  expect(verdict.ok, `visualBounds at ${viewportWidth}px: ${locator.toString()} ${verdict.violations.join('; ')}`).toBe(true);
  return measurement;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
