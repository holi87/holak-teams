package qa.support.oracles;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.options.ViewportSize;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Layout-bounds oracles, the Java port of visual.ts. An element that renders off the page,
 * pushes the page into horizontal scrolling, or sits under another element is a visual
 * defect a screenshot diff often misses at narrow widths. {@link #evaluateBounds} is a pure
 * function over measured values; {@link #visualBounds} measures one element in the browser
 * (default width 375px) and evaluates it. A RED throws {@link AssertionError}; misuse throws
 * {@link IllegalArgumentException}.
 */
public final class Visual {

    /** An element box in page (document) coordinates, in CSS pixels. */
    public record Rect(double x, double y, double width, double height) {
        public double right() {
            return x + width;
        }
    }

    public record Viewport(double width, double height) {}

    /**
     * What one measurement observed: the element box, the viewport, the root element's
     * scrollWidth and clientWidth, and whether the element (or one of its descendants) is the
     * topmost element at the centre of its box.
     */
    public record Bounds(Rect rect, Viewport viewport, double scrollWidth, double clientWidth, boolean topElementIsSelf) {}

    public static final int DEFAULT_VIEWPORT_WIDTH = 375;

    /** The height used when the page has no fixed viewport to keep. */
    public static final int DEFAULT_VIEWPORT_HEIGHT = 667;

    /**
     * Measures the element passed by {@link Locator#evaluate(String)}: it is scrolled to the
     * vertical centre first, its box is reported in page coordinates, and the occlusion probe
     * hit-tests the centre of the box in the element's own document or shadow root.
     */
    static final String MEASURE = """
            (element) => {
              element.scrollIntoView({ block: 'center', inline: 'nearest' });
              const box = element.getBoundingClientRect();
              const root = document.documentElement;
              const cx = box.left + box.width / 2;
              const cy = box.top + box.height / 2;
              const scope = element.getRootNode().elementFromPoint ? element.getRootNode() : document;
              const inside = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
              const hit = inside ? scope.elementFromPoint(cx, cy) : null;
              return {
                x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height,
                viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
                scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
                topElementIsSelf: hit !== null && (hit === element || element.contains(hit))
              };
            }""";

    private Visual() {}

    /**
     * Fails on every violated bound: x &lt; 0 or y &lt; 0 (rendered off the page),
     * right &gt; viewport.width (overflows the viewport), scrollWidth &gt; clientWidth (the
     * page scrolls horizontally), or another element on top at the centre of the box
     * (occluded). Returns {@code bounds} unchanged when every bound holds.
     */
    public static Bounds evaluateBounds(Bounds bounds) {
        if (bounds == null || bounds.rect() == null || bounds.viewport() == null) {
            throw new IllegalArgumentException("evaluateBounds: rect and viewport are required");
        }
        Rect rect = bounds.rect();
        Viewport viewport = bounds.viewport();
        for (double value : new double[] {rect.x(), rect.y(), rect.width(), rect.height(), viewport.width(), viewport.height(), bounds.scrollWidth(), bounds.clientWidth()}) {
            if (!Double.isFinite(value)) throw new IllegalArgumentException("evaluateBounds: every measurement must be a finite number, got " + value);
        }
        if (rect.width() < 0 || rect.height() < 0 || viewport.width() <= 0 || viewport.height() <= 0 || bounds.scrollWidth() < 0 || bounds.clientWidth() < 0) {
            throw new IllegalArgumentException("evaluateBounds: sizes must be non-negative and the viewport must have a positive size");
        }
        List<String> problems = new ArrayList<>();
        if (rect.x() < 0) problems.add("renders at x=" + px(rect.x()) + ", left of the page");
        if (rect.y() < 0) problems.add("renders at y=" + px(rect.y()) + ", above the page");
        if (rect.right() > viewport.width()) problems.add("right edge " + px(rect.right()) + " overflows the " + px(viewport.width()) + "px viewport");
        if (bounds.scrollWidth() > bounds.clientWidth()) {
            problems.add("the page scrolls horizontally (scrollWidth " + px(bounds.scrollWidth()) + " > clientWidth " + px(bounds.clientWidth()) + ")");
        }
        if (!bounds.topElementIsSelf()) problems.add("another element covers the centre of its box (occluded)");
        if (!problems.isEmpty()) {
            throw new AssertionError("visual bounds at " + px(viewport.width()) + "px: " + String.join("; ", problems));
        }
        return bounds;
    }

    public static Bounds visualBounds(Locator locator) {
        return visualBounds(locator, DEFAULT_VIEWPORT_WIDTH);
    }

    /**
     * Resizes the page to {@code viewportWidth} (keeping its height), measures the element,
     * restores the previous viewport, and evaluates the measurement with
     * {@link #evaluateBounds}. The locator must resolve to exactly one element.
     */
    public static Bounds visualBounds(Locator locator, int viewportWidth) {
        if (locator == null) throw new IllegalArgumentException("visualBounds: locator must not be null");
        if (viewportWidth < 1) throw new IllegalArgumentException("visualBounds: viewportWidth must be a positive integer, got " + viewportWidth);
        Page page = locator.page();
        ViewportSize previous = page.viewportSize();
        boolean resize = previous == null || previous.width != viewportWidth;
        if (resize) page.setViewportSize(viewportWidth, previous == null ? DEFAULT_VIEWPORT_HEIGHT : previous.height);
        Object measured;
        try {
            measured = locator.evaluate(MEASURE);
        } finally {
            if (resize && previous != null) page.setViewportSize(previous.width, previous.height);
        }
        if (!(measured instanceof Map<?, ?> values)) throw new IllegalStateException("visualBounds: the measurement returned no object");
        Rect rect = new Rect(number(values, "x"), number(values, "y"), number(values, "width"), number(values, "height"));
        Viewport viewport = new Viewport(number(values, "viewportWidth"), number(values, "viewportHeight"));
        return evaluateBounds(new Bounds(rect, viewport, number(values, "scrollWidth"), number(values, "clientWidth"),
                Boolean.TRUE.equals(values.get("topElementIsSelf"))));
    }

    private static double number(Map<?, ?> values, String key) {
        if (!(values.get(key) instanceof Number value)) throw new IllegalStateException("visualBounds: the measurement has no number " + key);
        return value.doubleValue();
    }

    /** 12.0 prints as 12, 12.5 as 12.5. */
    private static String px(double value) {
        return Boundary.normalize(BigDecimal.valueOf(value)).toPlainString();
    }
}
