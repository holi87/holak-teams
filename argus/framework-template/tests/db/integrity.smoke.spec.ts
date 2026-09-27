import { test, expect } from '../../src/fixtures/fixtures';
import { requireEnv } from '../../src/argus/errors';

// @db lane placeholder smoke.
// DB-level checks (state integrity, orphan rows, constraint enforcement) require a
// direct DB connection that the target may not expose (black-box only is the common
// case). solution/test-lanes.tsv therefore enables the db lane only with DB_URL, and a
// missing DB_URL is reported by requireEnv as `prerequisite-missing`.
// ADAPT-ME: add the driver + real integrity queries once DB access is confirmed.

test.describe('@db smoke', () => {
  test('DB_URL prerequisite is a parseable connection string', () => {
    const dbUrl = requireEnv('DB_URL');
    expect(() => new URL(dbUrl), 'DB_URL must be a valid URL/DSN').not.toThrow();
  });
});
