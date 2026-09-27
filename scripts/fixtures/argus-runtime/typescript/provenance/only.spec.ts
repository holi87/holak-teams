import { test } from '@playwright/test';

// A focused test: the collect-only pass still lists the whole suite, the inventory gate's
// source scan reports `focused-test-forbidden`, and forbidOnly refuses any executed run.
test.only('a focused test is forbidden', async () => {});

test('a sibling of the focused test', async () => {});
