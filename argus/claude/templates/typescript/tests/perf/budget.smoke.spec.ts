import { test, expect } from '../../src/fixtures/fixtures';
import { requireEnv } from '../../src/argus/errors';

// @perf lane placeholder smoke.
// The real load probe is src/perf/run-perf.mjs (autocannon, run via `npm run perf`).
// This spec exists so the `perf` Playwright project wires up and is part of the
// aggregated run. It is a GATE, not a benchmark: it only asserts that a perf budget
// has been explicitly STATED (PERF_BUDGET_MS) — never invent a threshold.
// The lane runs only when solution/test-lanes.tsv enables it. A missing budget is
// reported by requireEnv as `prerequisite-missing`; the test never skips itself.
// ADAPT-ME: once Kalchas's recon + the strategy name a real budget, add the
// characterisation assertions (or call run-perf.mjs from CI) here.

test.describe('@perf smoke', () => {
  test('perf budget is a positive, stated number', () => {
    const budget = Number(requireEnv('PERF_BUDGET_MS'));
    // Guard against a typo'd / non-numeric budget silently disabling the gate.
    expect(budget, 'PERF_BUDGET_MS must parse to a positive number').toBeGreaterThan(0);
  });
});
