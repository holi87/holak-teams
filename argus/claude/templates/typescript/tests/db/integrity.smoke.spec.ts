import { test, expect } from '../../src/fixtures/fixtures';

// @db lane placeholder smoke.
// DB-level checks (state integrity, orphan rows, constraint enforcement) require a
// direct DB connection that the target may not expose. This lane is therefore GATED
// on DB_URL: with no connection string it skips (the common case — black-box only),
// and when one is provided it verifies the prerequisite is usable.
// ADAPT-ME: add the driver + real integrity queries once DB access is confirmed.

const DB_URL = process.env.DB_URL ?? null;

test.describe('@db smoke', () => {
  test.skip(DB_URL == null, 'db lane disabled: set DB_URL to enable direct-DB integrity checks');

  test('DB_URL prerequisite is a parseable connection string', () => {
    expect(() => new URL(DB_URL as string), 'DB_URL must be a valid URL/DSN').not.toThrow();
  });
});
