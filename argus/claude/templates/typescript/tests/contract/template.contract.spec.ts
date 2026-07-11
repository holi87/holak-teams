import { test, expect } from '@playwright/test';

test('@contract-smoke generated template contract is runnable', async () => {
  expect(process.env.ARGUS_CONTRACT_SMOKE).toBe('1');
});
