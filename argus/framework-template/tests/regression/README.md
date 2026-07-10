# Regression tests (bug-linked)

When Atalanta confirms a bug, a regression test goes here. **The app is NOT fixed during the engagement**, so the test asserts the SPEC-CORRECT behaviour and will be RED — that red, linked to its bug file, is your evidence that the suite catches the defect (evaluated criterion 4).

Use **red evidence** only: a plain failing test whose red maps to `BUG-NNNN`. Run it with
`--mode defect-evidence`; the reporter must append a matching
`product/fail/expected=true/reproduced` event. The same test runs strict green in
`candidate-regression` and `full-suite` after the product fix.
```ts
import { test, expect } from '../../src/fixtures/fixtures';
// BUG-0007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
test('@regression @bug:BUG-0007 rejects negative quantity', async ({ apiAsUser }) => {
  const res = await apiAsUser.post('/orders', { data: { item: 'x', qty: -5 } });
  expect(res.status()).toBe(400); // SPEC says reject; app returns 201 → RED = the bug
});
```

Do **not** use expected-failure wrappers (`test.fail`, xfail, skip, serial hiding) for confirmed defects. A known bug must keep its regression RED until the application is fixed.

Every regression test names its `BUG-NNNN`, cites the oracle, and emits the lifecycle event
through `scripts/outcome-event.sh`. One regression test per confirmed bug.
