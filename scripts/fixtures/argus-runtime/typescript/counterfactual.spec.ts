import { expect } from '@playwright/test';
import { ENV } from '../../src/config/env';
import { counterfactualTest as test } from '../../src/fixtures/fixtures';
import { assertSchemaRef } from '../../src/oracles';

// Counterfactual fixture for scripts/smoke-argus-runtime-typescript.sh. In a cf-* pass the
// request fixture reaches only the in-worker stub serving solution/counterfactual/BUG-0001.json;
// the smoke points API_URL at a closed port, so nothing contacts a real target. The smoke
// deletes the strict-body line to build a weakened copy, and ARGUS_SMOKE_EXTRA_REQUEST=1
// adds a request the fixture does not declare.

test('widget read returns the specified widget', { tag: ['@regression', '@bug:ATA-001'] }, async ({ request, argusCounterfactual }) => {
  expect(ENV.apiURL).toBe(argusCounterfactual?.stub.url ?? ENV.targetApiURL);
  const res = await request.get('/widgets/1');
  if (process.env.ARGUS_SMOKE_EXTRA_REQUEST === '1') await request.get('/widgets/2');
  expect(res.status()).toBe(200);
  await assertSchemaRef(await res.json(), '#/components/schemas/Widget'); // argus-smoke: strict body
});

test('a test without a bound bug has no counterfactual variant', async () => {
  expect(true).toBe(true);
});
