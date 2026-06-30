package qa.support;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Test-data builders: every spec gets fresh, unique, override-friendly data.
 * Never hardcode shared records in specs — parallel writers (or reruns against a
 * non-reset app) will collide.
 *
 * ADAPT-ME: one builder per domain entity from Kalchas's data-model map.
 */
public final class DataFactory {

    private DataFactory() {}

    private static final AtomicLong SEQ = new AtomicLong();

    /** Collision-safe unique string, e.g. {@code unique("item") -> "item-1719000000000-1"}. */
    public static String unique(String prefix) {
        return prefix + "-" + System.currentTimeMillis() + "-" + SEQ.incrementAndGet();
    }

    /** Start an order builder pre-filled with valid, unique defaults. Override what you need. */
    public static OrderBuilder order() {
        return new OrderBuilder();
    }

    /**
     * Example builder — replace with the real entity shape from the OpenAPI spec.
     * {@link #build()} returns a {@code Map} that REST Assured serialises to a JSON body.
     */
    public static final class OrderBuilder {
        private String item = unique("item");
        private int qty = 1;

        public OrderBuilder item(String item) { this.item = item; return this; }
        public OrderBuilder qty(int qty)       { this.qty = qty;   return this; }

        public Map<String, Object> build() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("item", item);
            m.put("qty", qty);
            return m;
        }
    }
}
