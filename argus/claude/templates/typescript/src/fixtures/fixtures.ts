import { test as base, APIRequestContext } from '@playwright/test';
import { apiAs } from '../api/auth';
import { LoginPage } from '../pages/login.page';

// Custom fixtures = the framework's dependency injection.
// Specs declare what they need; setup/teardown happens here, never inline in tests.
// ADAPT-ME: add one fixture per role and per page object as the app reveals them.

type CreatedResource = { ctx: APIRequestContext; path: string };

type Fixtures = {
  apiAsUser: APIRequestContext;
  apiAsAdmin: APIRequestContext;
  loginPage: LoginPage;
  /** Register POST-created entities here; they are DELETEd in teardown (404 tolerated).
   *  Use when the app ships no reset command — never rely on accumulating unique data alone. */
  createdResources: CreatedResource[];
  consoleGuard: void;
};

export const test = base.extend<Fixtures>({
  apiAsUser: async ({}, use) => {
    const ctx = await apiAs('user');
    await use(ctx);
    await ctx.dispose();
  },
  apiAsAdmin: async ({}, use) => {
    const ctx = await apiAs('admin');
    await use(ctx);
    await ctx.dispose();
  },
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  createdResources: async ({}, use) => {
    const created: CreatedResource[] = [];
    await use(created);
    for (const { ctx, path } of created.reverse()) {
      const res = await ctx.delete(path).catch(() => null);
      if (res && !res.ok() && res.status() !== 404) {
        console.warn(`cleanup failed: DELETE ${path} → ${res.status()}`);
      }
    }
  },
  // Auto-fixture: every UI test inherits a console-error + failed-request guard.
  // Silent JS errors and broken XHRs are the cheapest high-yield web signal.
  // ADAPT-ME: allowlist known-noise patterns (3rd-party scripts, expected 401 probes).
  consoleGuard: [
    async ({ page }, use) => {
      const allow: RegExp[] = [
        // /favicon\.ico/,
      ];
      const violations: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !allow.some((re) => re.test(msg.text()))) {
          violations.push(`console.error: ${msg.text()}`);
        }
      });
      page.on('response', (res) => {
        if (res.status() >= 500 && !allow.some((re) => re.test(res.url()))) {
          violations.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
        }
      });
      await use();
      if (violations.length) {
        throw new Error(`consoleGuard caught silent failures:\n${violations.join('\n')}`);
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
