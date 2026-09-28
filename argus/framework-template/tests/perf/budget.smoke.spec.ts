import { performance } from 'node:perf_hooks';
import { APIResponse } from '@playwright/test';
import { test, expect } from '../../src/fixtures/fixtures';
import { ResourceClient } from '../../src/api/api-client';
import { requireEnv } from '../../src/argus/errors';
import { buildOrder } from '../../src/data/factory';
import { assertRestStatus, expectStatus, n1Scaling } from '../../src/oracles';

// @perf lane smoke. It is a GATE, not a benchmark; the load probe is src/perf/run-perf.mjs
// (autocannon, `npm run perf`).
// - The p95 check asserts only a budget the strategy has STATED (PERF_BUDGET_MS); never
//   invent a threshold. A missing budget is reported by requireEnv as
//   `prerequisite-missing`; the test never skips itself.
// - n1Scaling needs no budget: it compares the product with itself at growing collection
//   sizes and requires the read to grow sub-linearly, so an N+1 fan-out is RED.
// The lane runs only when solution/test-lanes.tsv enables it.

// ADAPT-ME: the endpoint the stated budget covers, the sample counts, and the collection
// read Hermes flagged for N+1. The read uses a fixed page size, so a correct read stays
// flat in payload; the smallest size must fill that page, or the payload grows between
// the first two sizes on a correct app.
const BUDGET_ENDPOINT = '/health';
const WARMUP_REQUESTS = 3;
const MEASURED_REQUESTS = 40;
const COLLECTION = { path: '/orders', pageSize: 10, sizes: [10, 40, 160] };

/** One request, timed from send to the last body byte. */
async function timed(send: () => Promise<APIResponse>): Promise<{ res: APIResponse; ms: number; bytes: number }> {
  const start = performance.now();
  const res = await send();
  const body = await res.body();
  return { res, ms: performance.now() - start, bytes: body.length };
}

/** Nearest-rank percentile: the smallest sample with at least p% of the samples at or below it. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

test.describe('@perf smoke', () => {
  test('p95 latency stays within the stated budget', async ({ request }) => {
    const budget = Number(requireEnv('PERF_BUDGET_MS'));
    // Guard against a typo'd / non-numeric budget silently disabling the gate.
    expect(budget, 'PERF_BUDGET_MS must parse to a positive number').toBeGreaterThan(0);
    const timings: number[] = [];
    for (let call = 0; call < WARMUP_REQUESTS + MEASURED_REQUESTS; call += 1) {
      const { res, ms } = await timed(() => request.get(BUDGET_ENDPOINT));
      await expectStatus(res, 200);
      if (call >= WARMUP_REQUESTS) timings.push(ms);
    }
    const p95 = percentile(timings, 95);
    expect(p95, `p95 of ${MEASURED_REQUESTS} sequential GET ${BUDGET_ENDPOINT} is ${p95.toFixed(1)} ms; the stated budget is ${budget} ms`).toBeLessThanOrEqual(budget);
  });

  test('collection read grows sub-linearly with the collection size', async ({ apiAsUser, createdResources }) => {
    test.setTimeout(180_000); // arranging the largest size creates that many records
    const orders = new ResourceClient(apiAsUser, COLLECTION.path);
    // ADAPT-ME: start from an empty or freshly reset collection (solution/environment.tsv)
    // so each size is exact, or arrange through the app's seed command instead of the API.
    let arranged = 0;
    const arrangeTo = async (size: number) => {
      for (; arranged < size; arranged += 1) {
        const res = await orders.create(buildOrder());
        const location = res.headers().location;
        if (location) createdResources.push({ ctx: apiAsUser, path: location });
        await assertRestStatus(res, 'created');
      }
    };
    await n1Scaling({
      sizes: COLLECTION.sizes,
      measure: async (size) => {
        await arrangeTo(size);
        const { res, ms, bytes } = await timed(() => orders.list({ pageSize: COLLECTION.pageSize }));
        await expectStatus(res, 200);
        return { ms, bytes };
      },
    });
  });
});
