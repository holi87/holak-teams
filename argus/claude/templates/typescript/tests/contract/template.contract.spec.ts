import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';

// The contract evaluator refuses to invent a passing event, so a smoke run that emits
// nothing is a contract error rather than a green suite. This case therefore records its
// own outcome the way every real case does: the event exists because the test ran.
test('@contract-smoke generated template contract is runnable', async () => {
  expect(process.env.ARGUS_CONTRACT_SMOKE).toBe('1');
  execFileSync('scripts/outcome-event.sh', [
    'template.contract.spec.ts',
    'product',
    'pass',
    'false',
    'n/a',
    '-',
    'contract-smoke-executed',
  ]);
});
