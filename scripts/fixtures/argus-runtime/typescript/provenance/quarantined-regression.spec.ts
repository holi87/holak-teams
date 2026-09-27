import { test } from '@playwright/test';

// A regression is never quarantinable: quarantine would hide the RED that proves the bug.
test('quarantined regression is refused', { tag: ['@regression', '@bug:BUG-0006', '@quarantine'] }, async () => {});
