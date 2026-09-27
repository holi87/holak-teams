import { test as base, APIRequestContext, Route, TestInfo } from '@playwright/test';
import { dirname } from 'node:path';
import { apiAs } from '../api/auth';
import { boundBug, EXEMPT_PREFIX, isCounterfactualPass, loadFixture, NOT_APPLICABLE, variantExchanges, variantFor } from '../argus/counterfactual';
import { ArgusCounterfactualError } from '../argus/errors';
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
type CounterfactualWorkerFixtures = { argusStub: StubServer | null };
type CounterfactualFixtures = { argusCounterfactual: { bugId: string; variant: string; stub: StubServer } | null };

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
      process.env.ARGUS_COUNTERFACTUAL_API_URL = argusStub.url;
      try {
        await use({ bugId, variant: variant.id, stub: argusStub });
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
    await use(argusStub && !isUiLane(testInfo.project.name) ? argusStub.url : baseURL);
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

export const test = counterfactualTest.extend<Fixtures>({
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
