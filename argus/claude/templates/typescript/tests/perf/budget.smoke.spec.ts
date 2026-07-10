import { test, expect } from '../../src/fixtures/fixtures';

// @perf lane placeholder smoke.
// The real load probe is src/perf/run-perf.mjs (autocannon, run via `npm run perf`).
// This spec exists so the `perf` Playwright project wires up and is part of the
// aggregated run. It is a GATE, not a benchmark: it only asserts that a perf budget
// has been explicitly STATED (PERF_BUDGET_MS) — never invent a threshold.
// ADAPT-ME: once Kalchas's recon + the strategy name a real budget, add the
// characterisation assertions (or call run-perf.mjs from CI) here.

const PERF_BUDGET_MS = process.env.PERF_BUDGET_MS ? Number(process.env.PERF_BUDGET_MS) : null;

test.describe('@perf smoke', () => {
  test.skip(
    PERF_BUDGET_MS == null,
    'perf gate disabled: set PERF_BUDGET_MS to a STATED budget to enable the perf lane',
  );

  test('perf budget is a positive, stated number', () => {
    // Guard against a typo'd / non-numeric budget silently disabling the gate.
    expect(PERF_BUDGET_MS, 'PERF_BUDGET_MS must parse to a positive number').toBeGreaterThan(0);
  });
});
