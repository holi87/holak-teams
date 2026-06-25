import { Page } from '@playwright/test';

// Network fault injection for UI error-state testing. The UI's spinners, error
// banners, retries and offline degradation are nearly unreachable without
// interception — cover them deterministically with page.route(), never by
// waiting for a real outage.
//
// Each helper intercepts the NEXT matching request only, then unroutes itself.

/** Next request matching `pattern` responds with `status` and an empty JSON body. */
export async function failNext(page: Page, pattern: string | RegExp, status = 500): Promise<void> {
  await page.route(pattern, async (route) => {
    await page.unroute(pattern);
    await route.fulfill({ status, contentType: 'application/json', body: '{}' });
  });
}

/** Next request matching `pattern` is delayed by `ms` before continuing normally. */
export async function delayNext(page: Page, pattern: string | RegExp, ms: number): Promise<void> {
  await page.route(pattern, async (route) => {
    await page.unroute(pattern);
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

/** Next request matching `pattern` is aborted (connection failure). */
export async function abortNext(page: Page, pattern: string | RegExp): Promise<void> {
  await page.route(pattern, async (route) => {
    await page.unroute(pattern);
    await route.abort('failed');
  });
}
