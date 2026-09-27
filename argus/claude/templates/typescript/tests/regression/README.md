# Regression tests (bug-linked)

When a bug is confirmed, its regression test asserts the SPEC-CORRECT behaviour. **The app
is NOT fixed during the engagement**, so the test is RED, and that RED, linked to the bug,
is the evidence that the suite catches the defect.

## Where they live

A regression lives in the directory of the lane that owns the behaviour, for example
`tests/api/` or `tests/ui/`, never in this directory: the Playwright project is the lane
(`solution/test-lanes.tsv` enables or disables it), and there is no separate regression
project. `@regression` selects it in `defect-evidence` and
`candidate-regression`; `full-suite` runs it with everything else.

## Rules

- Tag it with `@regression` plus exactly one `@bug:<token>`. The token is the canonical
  `BUG-NNNN` or one stable origin alias of that bug in `solution/bug-ledger.json`. A missing,
  unknown, or second token, or a bug that is not confirmed, fails the inventory gate.
- One regression per confirmed bug; cite the oracle next to the assertion.
- Never emit outcome events by hand. The Argus outcome adapter
  (`scripts/argus-playwright-reporter.mjs`) turns each run into the lifecycle events:
  `expected-red` and `expected-red-repeat` in `defect-evidence`, `regression-green` or
  `regression-red` in `candidate-regression` and `full-suite`.
- Never disable or hide it: `test.skip`, `test.fixme`, `test.fail`, and `@quarantine` are
  refused for a regression (`.only` for every test). A known bug keeps its regression RED
  until the application is fixed.
- Give it a counterfactual fixture, `solution/counterfactual/<BUG-NNNN>.json`, or a
  declared exemption. `defect-evidence` replays the fixture from a local stub: the test must
  pass on the spec-correct response and fail on every tamper, starting with the observed
  defect. Authoring rules and the exemption set: `solution/counterfactual/README.md`.
- An intermittent defect declares `@repetition:<n>` from the ledger's reproduction record
  (RUNNER-CONTRACT.md SD-6).

```ts
// tests/api/orders.regression.spec.ts
import { test, expect } from '../../src/fixtures/fixtures';
// BUG-0007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
test('rejects negative quantity', { tag: ['@regression', '@bug:BUG-0007'] }, async ({ apiAsUser }) => {
  const res = await apiAsUser.post('/orders', { data: { item: 'x', qty: -5 } });
  expect(res.status()).toBe(400); // SPEC says reject; app returns 201 → RED = the bug
});
```

Run it with `./run-tests.sh --mode defect-evidence`; after the product fix the same test
runs strict green with `--mode candidate-regression`.
