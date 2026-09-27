import { test, expect } from '../../support/fixtures/fixtures';

// End-to-end api lane for scripts/smoke-argus-runtime-typescript.sh, installed as
// quality/specs/api/widget.regression.spec.ts in a scaffold whose harness root is
// quality/support. scripts/fixtures/argus-runtime/faulty-target.mjs is the target.

// BUG-0001 (origin ATA-001, oracle ORC-API-001): GET /widgets/1 returns the widget. The target
// answers 500 in buggy mode, so the regression is RED until the target is fixed. The smoke
// deletes the strict-body line to build a weakened copy that the missing-field tamper survives.
test('widget read returns the specified widget', { tag: ['@regression', '@bug:ATA-001'] }, async ({ apiAsUser }) => {
  const res = await apiAsUser.get('/widgets/1');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ id: 1, name: 'widget' }); // argus-smoke: strict body
});

// A non-regression neighbour: baseline selects only this test while the known bug is RED,
// and full-suite runs both.
test('health endpoint reports ok', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});
