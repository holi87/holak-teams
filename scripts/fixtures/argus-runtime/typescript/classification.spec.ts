import { test as base, expect } from '@playwright/test';
import { ArgusCleanupError, requireEnv } from '../../src/argus/errors';

// Classification fixture for scripts/smoke-argus-runtime-typescript.sh. Each case produces
// exactly one primary outcome for the Argus Playwright outcome adapter; none contacts a
// real target. The smoke asserts the inventory row and the event of every case.
const test = base.extend<{ brokenSetup: void; leakyTeardown: void }>({
  brokenSetup: async ({}, use) => {
    throw new Error('fixture setup failed on purpose');
    await use();
  },
  leakyTeardown: async ({}, use) => {
    await use();
    throw new ArgusCleanupError('cleanup failed for 1 resource(s)');
  },
});

test('regression reproduces the observed defect', { tag: ['@regression', '@bug:ATA-001'] }, async () => {
  expect('observed-behaviour').toBe('specified-behaviour');
});

test('regression no longer reproduces', { tag: ['@regression', '@bug:BUG-0001'] }, async () => {
  expect('specified-behaviour').toBe('specified-behaviour');
});

test('intermittent regression declares its repetition', { tag: ['@regression', '@bug:BUG-0001', '@repetition:5'] }, async () => {
  expect('specified-behaviour').toBe('specified-behaviour');
});

test('regression with unknown provenance', { tag: ['@regression', '@bug:XYZ-999'] }, async () => {
  expect(true).toBe(true);
});

test('regression skipped at runtime', { tag: ['@regression', '@bug:ATA-001'] }, async () => {
  test.skip(true, 'runtime skip of a regression');
});

test('thrown type error is an automation defect', async () => {
  const missing = undefined as unknown as { call(): void };
  missing.call();
});

test('fixture setup failure', async ({ brokenSetup }) => {
  void brokenSetup;
});

test('cleanup failure after a passing body', async ({ leakyTeardown }) => {
  void leakyTeardown;
  expect(1).toBe(1);
});

test('assertion failure with a cleanup failure', async ({ leakyTeardown }) => {
  void leakyTeardown;
  expect(1).toBe(2);
});

test.describe('hook group', () => {
  test.beforeEach(async () => {
    throw new Error('beforeEach failed on purpose');
  });

  test('hook failure', async () => {
    expect(true).toBe(true);
  });
});

test.skip('statically skipped', async () => {});

test.fixme('fixme placeholder', async () => {});

test.fail('expected failure is forbidden', async () => {
  expect(1).toBe(2);
});

test('unreachable target', async ({ request }) => {
  await request.get('http://127.0.0.1:9/');
});

test('missing prerequisite', async () => {
  requireEnv('ARGUS_SMOKE_UNSET_PREREQUISITE');
});

test('test-level timeout', async () => {
  test.setTimeout(300);
  await new Promise((resolve) => setTimeout(resolve, 3000));
});

test.describe('Grüße suite', () => {
  test('title with spaces — ünïcode', async () => {
    expect(true).toBe(true);
  });
});

test(`long title ${'x'.repeat(230)}`, async () => {
  expect(true).toBe(true);
});

test('collision a/b', async () => {
  expect(true).toBe(true);
});

test('collision a b', async () => {
  expect(true).toBe(true);
});
