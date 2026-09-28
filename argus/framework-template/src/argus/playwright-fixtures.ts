import { test as base, Route, TestInfo } from '@playwright/test';
import { dirname } from 'node:path';
import { targetApiURL } from './api-url';
import { ACTIVATION_ANNOTATION, boundBug, EXEMPT_PREFIX, isCounterfactualPass, loadFixture, NOT_APPLICABLE, variantExchanges, variantFor } from './counterfactual';
import { ArgusCounterfactualError, ArgusCounterfactualSubjectError } from './errors';
import { StubResponse, StubServer } from './stub-server';

// Counterfactual activation of the runner kit (TEMPLATE-CONTRACT.md SD-10 and "ADAPT: the
// runner kit"): the suite's `test` extends counterfactualTest. Inert unless
// ARGUS_EVIDENCE_PASS is cf-correct or cf-tamper-<k>. Then each worker runs one 127.0.0.1
// stub, and each test bound to a bug with a fixture runs against the variant of
// solution/counterfactual/<bug>.json: counterfactualApiURL() (src/argus/api-url.ts) names the
// stub in every lane, non-ui lanes also get it as baseURL, and the ui lane routes the
// browser's API pattern to it. The fixture records the variant it served as a test
// annotation; the outcome adapter credits no counterfactual verdict without it. An
// undeclared request fails the test with ArgusCounterfactualError. A test that bypasses the
// stub (a per-file baseURL override, a URL captured at module load, a hand-built client)
// fails with ArgusCounterfactualSubjectError: the override before its first request, and
// any test whose subject exchange the stub never served at teardown. Every other test skips
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
    async ({ argusStub, baseURL }, use, testInfo) => {
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
      // A `test.use({ baseURL })` replaces the stub override below, so the test's requests
      // would go to the target; refuse before the first one.
      const apiURL = stubApiURL(argusStub);
      if (!isUiLane(testInfo.project.name) && baseURL !== apiURL) {
        throw new ArgusCounterfactualSubjectError('baseURL is overridden for this test, so the counterfactual stub cannot serve its requests');
      }
      argusStub.load(variantExchanges(fixture, variant));
      testInfo.annotations.push({ type: ACTIVATION_ANNOTATION, description: variant.id });
      const previous = process.env.ARGUS_COUNTERFACTUAL_API_URL;
      process.env.ARGUS_COUNTERFACTUAL_API_URL = apiURL;
      try {
        await use({ bugId, variant: variant.id, stub: argusStub, apiURL });
      } finally {
        if (previous === undefined) delete process.env.ARGUS_COUNTERFACTUAL_API_URL;
        else process.env.ARGUS_COUNTERFACTUAL_API_URL = previous;
      }
      const requests = argusStub.requests();
      argusStub.load([]);
      const unmatched = requests.filter((record) => record.matched === null);
      if (unmatched.length > 0) {
        const listed = unmatched.slice(0, 5).map((record) => `${record.method} ${record.path}`).join(', ');
        throw new ArgusCounterfactualError(`the counterfactual stub received ${unmatched.length} request(s) the fixture does not declare: ${listed}`);
      }
      // A test that skipped itself made no claim; every other outcome needs the subject served.
      if (testInfo.status !== 'skipped' && !requests.some((record) => record.matched === fixture.subject)) {
        throw new ArgusCounterfactualSubjectError(`the counterfactual stub never served the subject exchange ${fixture.subject}`);
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
      const pattern = process.env.ARGUS_API_ROUTE_PATTERN || `${targetApiURL().replace(/\/+$/, '')}/**`;
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
    path = new URL(targetApiURL()).pathname;
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
