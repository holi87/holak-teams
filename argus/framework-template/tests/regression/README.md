# Regression tests (bug-linked)

When Atalanta confirms a bug, a regression test goes here. **The app is NOT fixed during the engagement**, so the test asserts the SPEC-CORRECT behaviour and will be RED — that red, linked to its bug file, is your evidence that the suite catches the defect (evaluated criterion 4).

Use **red evidence** only: a plain failing test whose red maps to `bugs/BUG-NNN`. The report visibly shows the defect caught.
```ts
import { test, expect } from '../../src/fixtures/fixtures';
// BUG-007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
test('@regression BUG-007 rejects negative quantity', async ({ apiAsUser }) => {
  const res = await apiAsUser.post('/orders', { data: { item: 'x', qty: -5 } });
  expect(res.status()).toBe(400); // SPEC says reject; app returns 201 → RED = the bug
});
```

Do **not** use expected-failure wrappers (`test.fail`, xfail, skip, serial hiding) for confirmed defects. A known bug must keep its regression RED until the application is fixed.

Every regression test names its `BUG-NNN` and cites the oracle (requirement / OpenAPI). One regression test per confirmed bug.
