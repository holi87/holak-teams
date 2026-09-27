import { test, expect } from '@playwright/test';

// Contract smoke: a freshly scaffolded template collects, runs, and reports through the
// Argus outcome adapter, which records this case's event. Tests never append events by hand.
test('@contract-smoke generated template contract is runnable', async () => {
  expect(process.env.ARGUS_CONTRACT_SMOKE).toBe('1');
});
