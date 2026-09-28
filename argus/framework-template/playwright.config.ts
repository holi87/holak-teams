import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

// URLs come from Kalchas's recon; default to the target's ports.
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const UI_URL = process.env.UI_URL ?? 'http://localhost:3000';
const AUTH_DIR = process.env.ARGUS_AUTH_DIRECTORY ?? '.auth';

export default defineConfig({
  testDir: './tests',
  // Traces, screenshots, and videos go to the managed browser-artifact directory inside an
  // engagement; run-tests.sh copies this directory into each evidence pass.
  outputDir: process.env.ARGUS_BROWSER_ARTIFACTS || 'test-results',
  fullyParallel: true,
  // A focused test never runs, locally or in CI. Only the collect-only inventory pass
  // (ARGUS_INVENTORY_ONLY=1) lists a suite that contains `.only`, so the inventory stays
  // complete and scripts/inventory-gate.sh reports it as `focused-test-forbidden`.
  forbidOnly: process.env.ARGUS_INVENTORY_ONLY !== '1',
  retries: 0, // determinism: fix flakiness at the source, never hide it behind retries
  workers: process.env.WORKERS ? Number(process.env.WORKERS) : undefined,
  // list (console), html (humans), json (tooling), and the Argus outcome adapter, which
  // stays inert unless scripts/runner-lib.sh exports ARGUS_RUNNER_MODE.
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
    ['./scripts/argus-playwright-reporter.mjs'],
  ],
  // Visual regression: first run creates baselines next to the spec; refresh with
  // --update-snapshots. Baselines are render-environment-specific — keep per-browser,
  // never accept a diff without eyeballing it.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'contract-smoke', testDir: './tests/contract' },
    // UI auth once, persisted as storageState — the canonical Playwright pattern.
    {
      name: 'setup',
      testDir: './tests/setup',
      testMatch: /.*\.setup\.ts/,
      use: { baseURL: UI_URL },
    },
    // One project per product lane. solution/test-lanes.tsv enables or disables each lane
    // and run-tests.sh selects only the enabled ones; a test never skips itself on a missing
    // prerequisite (requireEnv reports it). Regressions live in their lane's directory.
    { name: 'api', testDir: './tests/api', use: { baseURL: API_URL } },
    { name: 'perf', testDir: './tests/perf', use: { baseURL: API_URL } },
    { name: 'security', testDir: './tests/security', use: { baseURL: API_URL } },
    { name: 'db', testDir: './tests/db', use: { baseURL: API_URL } },
    { name: 'resilience', testDir: './tests/resilience', use: { baseURL: API_URL } },
    {
      name: 'ui',
      testDir: './tests/ui',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: UI_URL,
        storageState: join(AUTH_DIR, 'user.json'),
      },
    },
    // Browser/viewport matrix — chromium-only is a DECISION to record in the
    // strategy, not a default to assume. Enable per strategy (also add the
    // browsers to run-tests.sh playwright install). Keep the `<lane>-<variant>`
    // name: run-tests.sh selects `--project=<lane>-*` with the lane.
    // {
    //   name: 'ui-firefox',
    //   testDir: './tests/ui',
    //   dependencies: ['setup'],
    //   use: { ...devices['Desktop Firefox'], baseURL: UI_URL, storageState: join(AUTH_DIR, 'user.json') },
    // },
    // {
    //   name: 'ui-webkit',
    //   testDir: './tests/ui',
    //   dependencies: ['setup'],
    //   use: { ...devices['Desktop Safari'], baseURL: UI_URL, storageState: join(AUTH_DIR, 'user.json') },
    // },
    // {
    //   name: 'ui-mobile',
    //   testDir: './tests/ui',
    //   dependencies: ['setup'],
    //   use: { ...devices['iPhone 14'], baseURL: UI_URL, storageState: join(AUTH_DIR, 'user.json') },
    // },
  ],
});
