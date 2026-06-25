import { test, expect } from '../../src/fixtures/fixtures';

// @security lane placeholder smoke.
// Security checks (authz / IDOR / broken-access-control) are GATED behind an
// explicit opt-in so they never run by accident against an environment that
// hasn't been cleared for them. ADAPT-ME: replace the placeholder route with the
// real protected surface from Kalchas's recon + the OpenAPI/threat model.

const SECURITY_ENABLED = process.env.SECURITY_ENABLED === '1';

test.describe('@security smoke', () => {
  test.skip(
    !SECURITY_ENABLED,
    'security lane disabled: set SECURITY_ENABLED=1 once the target is cleared for security checks',
  );

  test('protected route rejects anonymous access', async ({ request }) => {
    const res = await request.get('/me'); // ADAPT-ME: a real protected route from recon
    expect([401, 403]).toContain(res.status());
  });
});
