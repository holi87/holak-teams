import { test } from '@playwright/test';

// Provenance fixture for scripts/smoke-argus-runtime-typescript.sh. The inventory comes from
// Playwright's own collection, so every spelling Playwright honours is provenance.

test('@regression @bug:BUG-0001 title provenance is recognized', async () => {});

test('details provenance is recognized', {
  tag: ['@regression', '@bug:BUG-0002'],
}, async () => {});

// Details built in a variable are invisible to a source parser but real to Playwright.
const variableDetails = { tag: ['@regression', '@bug:ATA-005'] };
test('details from a variable are recognized', variableDetails, async () => {});
