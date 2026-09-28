import { test, expect } from '../../src/fixtures/fixtures';
import { requireEnv } from '../../src/argus/errors';

// @security lane placeholder smoke.
// Security checks (authz / IDOR / broken-access-control) run only when
// solution/test-lanes.tsv enables the security lane, and that lane requires the explicit
// SECURITY_ENABLED=1 clearance for this environment. A missing clearance is reported by
// requireEnv as `prerequisite-missing`; the test never skips itself.
// ADAPT-ME: replace the placeholder route with the real protected surface from
// Kalchas's recon + the OpenAPI/threat model.

test.describe('@security smoke', () => {
  test('protected route rejects anonymous access', async ({ request }) => {
    expect(requireEnv('SECURITY_ENABLED'), 'SECURITY_ENABLED must be 1 once the target is cleared').toBe('1');
    const res = await request.get('/me'); // ADAPT-ME: a real protected route from recon
    expect([401, 403]).toContain(res.status());
  });
});
