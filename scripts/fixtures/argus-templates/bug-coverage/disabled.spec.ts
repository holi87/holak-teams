import { test } from '@playwright/test';

test.skip('@regression @bug:BUG-9101 skipped coverage must not count', async () => {});

test.fixme('fixme coverage must not count', {
  tag: ['@regression', '@bug:BUG-9102'],
}, async () => {});

test.fail('expected-failure coverage must not count', {
  tag: ['@regression', '@bug:BUG-9103'],
}, async () => {});
