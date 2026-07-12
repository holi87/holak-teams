import { test } from '@playwright/test';

test('@regression @bug:BUG-0001 title provenance is recognized', async () => {});

test('details provenance is recognized', {
  tag: ['@regression', '@bug:BUG-0002'],
}, async () => {});
