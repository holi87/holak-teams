import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

// URLs come from Kalchas's recon; default to the target's ports.
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const UI_URL = process.env.UI_URL ?? 'http://localhost:3000';
const AUTH_DIR = process.env.ARGUS_AUTH_DIRECTORY ?? '.auth';
const BROWSER_ARTIFACTS = process.env.ARGUS_BROWSER_ARTIFACTS;

export default defineConfig({
  testDir: './tests',
  ...(BROWSER_ARTIFACTS ? { outputDir: BROWSER_ARTIFACTS } : {}),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // determinism: fix flakiness at the source, never hide it behind retries
  workers: process.env.WORKERS ? Number(process.env.WORKERS) : undefined,
  // Playwright-native reporters only: list (console), html (humans), json (tooling).
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
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
    // UI auth once, persisted as storageState — the canonical Playwright pattern.
    {
      name: 'setup',
      testMatch: /tests\/setup\/.*\.setup\.ts/,
      use: { baseURL: UI_URL },
    },
    { name: 'api', testDir: './tests/api', use: { baseURL: API_URL } },
    { name: 'regression', testDir: './tests/regression', use: { baseURL: API_URL } },
    // Gated lanes — the specs self-skip until their prerequisite is explicitly set
    // (PERF_BUDGET_MS / SECURITY_ENABLED=1 / DB_URL), so an unset run shows them
    // skipped (not failed) and exit code stays 0.
    { name: 'perf', testDir: './tests/perf', use: { baseURL: API_URL } },
    { name: 'security', testDir: './tests/security', use: { baseURL: API_URL } },
    { name: 'db', testDir: './tests/db', use: { baseURL: API_URL } },
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
    // browsers to run-tests.sh playwright install):
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
