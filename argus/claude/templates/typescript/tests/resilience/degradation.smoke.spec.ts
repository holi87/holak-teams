import { test, expect } from '../../src/fixtures/fixtures';
import { ENV } from '../../src/config/env';

// @resilience lane example: graceful degradation while the API is unavailable.
// A client-scope fault stays inside this browser (page.route), so it needs no
// ARGUS_FAULT_INJECTION grant; a server-scope fault that changes the shared target does
// (src/argus/fault-injector.ts). faultInjector records the restore before injecting, always
// restores, and fails the run as `fault-restore-failed` when the restore cannot be verified.
// ADAPT-ME: point PAGE at a screen that loads data from the API and replace the error-state
// locator with the app's real error banner or empty state.

const API_PATTERN = process.env.ARGUS_API_ROUTE_PATTERN || `${ENV.targetApiURL.replace(/\/+$/, '')}/**`;
const API_PREFIX = ENV.targetApiURL.replace(/\/+$/, '');
const PAGE = '/'; // ADAPT-ME

test.describe('@resilience smoke', () => {
  test('the UI shows an error state while the API answers 503 and recovers afterwards', async ({ page, faultInjector }) => {
    let intercepted = 0;
    await page.goto(new URL(PAGE, ENV.uiURL).toString());
    await faultInjector.run(
      {
        name: 'api-unavailable',
        scope: 'client',
        inject: () =>
          page.route(API_PATTERN, async (route) => {
            intercepted += 1;
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
          }),
        restore: () => page.unroute(API_PATTERN),
        // The next API request must reach the real API again instead of the injected 503.
        verifyRestored: async () => {
          const before = intercepted;
          await Promise.all([page.waitForResponse((response) => response.url().startsWith(API_PREFIX)), page.reload()]);
          if (intercepted !== before) throw new Error('an API request was still intercepted after the restore');
        },
      },
      async () => {
        await page.reload();
        await expect(page.getByRole('alert')).toBeVisible(); // ADAPT-ME: the app's error state
      },
    );
  });
});
