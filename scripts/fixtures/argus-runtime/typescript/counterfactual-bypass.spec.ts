import { expect } from '@playwright/test';
import { ENV } from '../../src/config/env';
import { counterfactualTest as test } from '../../src/argus/playwright-fixtures';

// Regressions that leave the counterfactual stub, for scripts/smoke-argus-runtime-typescript.sh:
// one builds its URL from ENV.apiURL read at module load, before any fixture points it at the
// stub; the other overrides baseURL for its describe block. The smoke runs them with API_URL
// naming a live buggy target, so a verdict they produce is the target's, never the stub's.
const CAPTURED_API_URL = ENV.apiURL;

test('widget read through a URL captured at module load', { tag: ['@regression', '@bug:ATA-001'] }, async ({ request }) => {
  const res = await request.get(`${CAPTURED_API_URL}/widgets/1`);
  expect(res.status()).toBe(200);
});

test.describe('per-file base URL', () => {
  test.use({ baseURL: ENV.targetApiURL });

  test('widget read with an overridden base URL', { tag: ['@regression', '@bug:ATA-001'] }, async ({ request }) => {
    const res = await request.get('/widgets/1');
    expect(res.status()).toBe(200);
  });
});
