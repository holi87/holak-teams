import { APIRequestContext } from '@playwright/test';
import { apiAs } from '../api/auth';
import { ArgusCleanupError } from '../argus/errors';
import { FaultInjector } from '../argus/fault-injector';
import { counterfactualTest } from '../argus/playwright-fixtures';
import { LoginPage } from '../pages/login.page';

// Custom fixtures = the framework's dependency injection.
// Specs declare what they need; setup/teardown happens here, never inline in tests.
// ADAPT-ME: add one fixture per role and per page object as the app reveals them.

export type CreatedResource = { ctx: APIRequestContext; path: string };

// A DELETE that answers one of these removed the resource or found it already gone.
const CLEANUP_STATUSES = new Set([200, 202, 204, 404]);
// Contexts whose disposal waits until createdResources has deleted what they created.
const deferredDisposal = new WeakMap<CreatedResource[], APIRequestContext[]>();

type Fixtures = {
  apiAsUser: APIRequestContext;
  apiAsAdmin: APIRequestContext;
  loginPage: LoginPage;
  /** Register POST-created entities here; teardown DELETEs every one, newest first. A status
   *  outside 200/202/204/404 or a thrown error fails the test as ArgusCleanupError. Use when
   *  the app ships no reset command; never rely on accumulating unique data alone. */
  createdResources: CreatedResource[];
  /** Runs a fault around one body and always restores it (src/argus/fault-injector.ts). */
  faultInjector: FaultInjector;
};

export const test = counterfactualTest.extend<Fixtures>({
  // The role contexts depend on argusCounterfactual so a cf-* pass has pointed ENV.apiURL at
  // the stub before they log in, and on createdResources so their disposal waits for its
  // teardown: cleanup must still be able to DELETE through them.
  apiAsUser: async ({ argusCounterfactual: _counterfactual, createdResources }, use) => {
    const ctx = await apiAs('user');
    await use(ctx);
    disposeAfterCleanup(createdResources, ctx);
  },
  apiAsAdmin: async ({ argusCounterfactual: _counterfactual, createdResources }, use) => {
    const ctx = await apiAs('admin');
    await use(ctx);
    disposeAfterCleanup(createdResources, ctx);
  },
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  // Depends on `request` so the built-in context outlives the cleanup as well.
  createdResources: async ({ request: _request }, use) => {
    const created: CreatedResource[] = [];
    const deferred: APIRequestContext[] = [];
    deferredDisposal.set(created, deferred);
    await use(created);
    try {
      await cleanupCreatedResources(created);
    } finally {
      for (const ctx of deferred) await ctx.dispose();
    }
  },
  faultInjector: async ({}, use) => {
    const injector = new FaultInjector();
    await use(injector);
    await injector.settle();
  },
  // consoleGuard: every test that opens a page inherits a console-error + 5xx-response guard.
  // Silent JS errors and broken XHRs are the cheapest high-yield web signal. It wraps the
  // `page` fixture, so API-only lanes never launch a browser for it. Errors and 5xx responses
  // observed while a faultInjector fault is active are the fault's intended effect.
  // ADAPT-ME: allowlist known-noise patterns (3rd-party scripts, expected 401 probes).
  page: async ({ page, faultInjector }, use) => {
    const allow: RegExp[] = [
      // /favicon\.ico/,
    ];
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !faultInjector.active && !allow.some((re) => re.test(msg.text()))) {
        violations.push(`console.error: ${msg.text()}`);
      }
    });
    page.on('response', (res) => {
      if (res.status() >= 500 && !faultInjector.active && !allow.some((re) => re.test(res.url()))) {
        violations.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
      }
    });
    await use(page);
    if (violations.length) {
      throw new Error(`consoleGuard caught silent failures:\n${violations.join('\n')}`);
    }
  },
});

/**
 * The createdResources teardown: DELETEs every registered resource, newest first, and attempts
 * each one even after a failure. A status outside 200/202/204/404 or a thrown error (for example
 * a disposed context) is a failure; the ArgusCleanupError names only the count, never a path or
 * a body.
 */
export async function cleanupCreatedResources(created: readonly CreatedResource[]): Promise<void> {
  let failures = 0;
  for (const { ctx, path } of [...created].reverse()) {
    try {
      const res = await ctx.delete(path);
      if (!CLEANUP_STATUSES.has(res.status())) failures += 1;
    } catch {
      failures += 1;
    }
  }
  if (failures > 0) throw new ArgusCleanupError(`cleanup failed for ${failures} resource(s)`);
}

function disposeAfterCleanup(created: CreatedResource[], ctx: APIRequestContext): void {
  deferredDisposal.get(created)?.push(ctx);
}

export { expect } from '@playwright/test';
