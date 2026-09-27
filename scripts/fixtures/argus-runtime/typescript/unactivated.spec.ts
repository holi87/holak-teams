import { expect, test } from '@playwright/test';

// Unported regression for scripts/smoke-argus-runtime-typescript.sh: it uses Playwright's own
// `test` instead of counterfactualTest, as an ADAPT suite that never wired the runner kit's
// activation would. It passes in cf-correct and fails in every tamper pass without a stub,
// which the outcome adapter must never credit as counterfactual evidence.

test('widget read without the counterfactual activation', { tag: ['@regression', '@bug:ATA-001'] }, async () => {
  expect(process.env.ARGUS_EVIDENCE_PASS ?? '').not.toMatch(/^cf-tamper-/);
});
