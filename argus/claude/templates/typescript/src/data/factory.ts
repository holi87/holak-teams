// Test-data builders: every spec gets fresh, unique, override-friendly data.
// Never hardcode shared records in specs — parallel workers will collide.
// ADAPT-ME: one builder per domain entity from Kalchas's data-model map.

let seq = 0;
export function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

// Example builder — replace with the real entity shape from the OpenAPI spec.
export interface OrderInput {
  item: string;
  qty: number;
}

export function buildOrder(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    item: unique('item'),
    qty: 1,
    ...overrides,
  };
}
