import { test as base, APIRequestContext, Route, TestInfo } from '@playwright/test';
import { dirname } from 'node:path';
import { apiAs } from '../api/auth';
import { boundBug, EXEMPT_PREFIX, isCounterfactualPass, loadFixture, NOT_APPLICABLE, variantExchanges, variantFor } from '../argus/counterfactual';
import { ArgusCleanupError, ArgusCounterfactualError } from '../argus/errors';
import { FaultInjector } from '../argus/fault-injector';
import { StubResponse, StubServer } from '../argus/stub-server';
import { ENV } from '../config/env';
import { LoginPage } from '../pages/login.page';

// Custom fixtures = the framework's dependency injection.
// Specs declare what they need; setup/teardown happens here, never inline in tests.
// ADAPT-ME: add one fixture per role and per page object as the app reveals them.

// Counterfactual evidence (TEMPLATE-CONTRACT.md SD-10). Inert unless ARGUS_EVIDENCE_PASS is
// cf-correct or cf-tamper-<k>. Then each worker runs one 127.0.0.1 stub, and each test bound
// to a bug with a fixture runs against the variant of solution/counterfactual/<bug>.json:
// ENV.apiURL points at the stub in every lane, non-ui lanes also get it as baseURL, and the
// ui lane routes the browser's API pattern to it. No request reaches the target API; an
// undeclared request fails the test with ArgusCounterfactualError. Every other test skips
// with a sentinel the adapter recognises.
// The stub URL keeps the real API_URL's path verbatim, so a client resolves every request path
// as it would against the target: exchange paths are the paths the target sees.
type CounterfactualWorkerFixtures = { argusStub: StubServer | null };
type CounterfactualFixtures = { argusCounterfactual: { bugId: string; variant: string; stub: StubServer; apiURL: string } | null };

export const counterfactualTest = base.extend<CounterfactualFixtures, CounterfactualWorkerFixtures>({
  argusStub: [
    async ({}, use) => {
      if (!isCounterfactualPass(process.env.ARGUS_EVIDENCE_PASS)) {
        await use(null);
        return;
      }
      const stub = await StubServer.start();
      try {
        await use(stub);
      } finally {
        await stub.stop();
      }
    },
    { scope: 'worker', auto: true },
  ],
  argusCounterfactual: [
    async ({ argusStub }, use, testInfo) => {
      if (!argusStub) {
        await use(null);
        return;
      }
      // The stub outlives the test: drop the previous test's exchanges and request log.
      argusStub.load([]);
      const pass = process.env.ARGUS_EVIDENCE_PASS ?? '';
      const root = templateRoot(testInfo);
      const bugId = boundBug(root, testInfo.tags);
      // The same validation as the inventory plan, contract check included, so a fixture the
      // plan lists as invalid never runs.
      const fixture = bugId ? await loadFixture(root, bugId) : undefined;
      if (fixture?.kind === 'exempt' && pass === 'cf-correct') {
        testInfo.skip(true, `${EXEMPT_PREFIX}${fixture.reason}`);
        return;
      }
      // Unbound tests, missing or invalid fixtures, and tamper passes beyond the fixture's
      // tampers have no variant; the evidence gate reports missing and invalid fixtures.
      const variant = fixture?.kind === 'fixture' ? variantFor(fixture, pass) : 'not-applicable';
      if (!bugId || fixture?.kind !== 'fixture' || variant === 'not-applicable') {
        testInfo.skip(true, NOT_APPLICABLE);
        return;
      }
      argusStub.load(variantExchanges(fixture, variant));
      const previous = process.env.ARGUS_COUNTERFACTUAL_API_URL;
      const apiURL = stubApiURL(argusStub);
      process.env.ARGUS_COUNTERFACTUAL_API_URL = apiURL;
      try {
        await use({ bugId, variant: variant.id, stub: argusStub, apiURL });
      } finally {
        if (previous === undefined) delete process.env.ARGUS_COUNTERFACTUAL_API_URL;
        else process.env.ARGUS_COUNTERFACTUAL_API_URL = previous;
      }
      const unmatched = argusStub.unmatched();
      argusStub.load([]);
      if (unmatched.length > 0) {
        const listed = unmatched.slice(0, 5).map((record) => `${record.method} ${record.path}`).join(', ');
        throw new ArgusCounterfactualError(`the counterfactual stub received ${unmatched.length} request(s) the fixture does not declare: ${listed}`);
      }
    },
    { auto: true },
  ],
  baseURL: async ({ baseURL, argusStub }, use, testInfo) => {
    await use(argusStub && !isUiLane(testInfo.project.name) ? stubApiURL(argusStub) : baseURL);
  },
  context: async ({ context, argusCounterfactual }, use, testInfo) => {
    if (argusCounterfactual && isUiLane(testInfo.project.name)) {
      const { stub } = argusCounterfactual;
      const pattern = process.env.ARGUS_API_ROUTE_PATTERN || `${ENV.targetApiURL.replace(/\/+$/, '')}/**`;
      await context.route(pattern, (route) => fulfillFromStub(route, stub));
    }
    await use(context);
  },
});

// playwright.config.ts lives at the template root whatever the selected harness layout.
function templateRoot(testInfo: TestInfo): string {
  return testInfo.config.configFile ? dirname(testInfo.config.configFile) : process.cwd();
}

function stubApiURL(stub: StubServer): string {
  let path = '';
  try {
    path = new URL(ENV.targetApiURL).pathname;
  } catch {
    path = '';
  }
  return path === '' || path === '/' ? stub.url : `${stub.url}${path}`;
}

// The Playwright project is the lane; `ui-<variant>` projects belong to the ui lane.
function isUiLane(project: string): boolean {
  return project === 'ui' || project.startsWith('ui-');
}

async function fulfillFromStub(route: Route, stub: StubServer): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const response: StubResponse = stub.resolve({ method: request.method(), path: `${url.pathname}${url.search}` })
    ?? { status: 501, body: { argusStub: 'unmatched' } };
  const headers = { ...(response.headers ?? {}) };
  let body: string | undefined;
  if (typeof response.body === 'string') {
    body = response.body;
    headers['content-type'] ??= 'text/plain; charset=utf-8';
  } else if (response.body !== undefined) {
    body = JSON.stringify(response.body);
    headers['content-type'] ??= 'application/json';
  }
  await route.fulfill({ status: response.status, headers, body });
}

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
