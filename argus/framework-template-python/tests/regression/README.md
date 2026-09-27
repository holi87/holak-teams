# Regression tests (bug-linked)

When a bug is confirmed, its regression test asserts the SPEC-CORRECT behaviour. **The app
is NOT fixed during the engagement**, so the test is RED, and that RED, linked to the bug,
is the evidence that the suite catches the defect.

## Where they live

A regression lives in the directory of the lane that owns the behaviour, for example
`tests/api/` or `tests/ui/`, never in this directory: its lane marker is what
`solution/test-lanes.tsv` enables or disables, and there is no separate regression lane.
`pytest.mark.regression` selects it in `defect-evidence` and `candidate-regression`;
`full-suite` runs it with everything else.

## Rules

- Mark it with `pytest.mark.regression`, exactly one lane marker (`pytest.mark.api`,
  `pytest.mark.ui`, …), and exactly one `@pytest.mark.bug("<token>")`. The token is the
  canonical `BUG-NNNN` or one stable origin alias of that bug in `solution/bug-ledger.json`.
  A missing, unknown, or second token, a second lane marker, or a bug that is not confirmed
  fails the inventory gate. A module-level `pytestmark` applies to every test in the module,
  so keep a regression's `regression` and `bug` markers on its function when the module
  also holds ordinary tests.
- One regression per confirmed bug; cite the oracle next to the assertion.
- Never emit outcome events by hand. The Argus outcome adapter (`qa.argus_plugin`) turns each
  run into the lifecycle events: `expected-red` and `expected-red-repeat` in
  `defect-evidence`, `regression-green` or `regression-red` in `candidate-regression` and
  `full-suite`.
- Never disable or hide it: `pytest.mark.skip`, `skipif`, `xfail`, a runtime `pytest.skip()`,
  and `pytest.mark.quarantine` are refused for a regression, and a `pytest.raises` wrapped
  around the defect hides it. A known bug keeps its regression RED until the application is
  fixed. Determinism applies here too: no rerun plugin — a flaky regression is itself a
  finding.
- Give it a counterfactual fixture, `solution/counterfactual/<BUG-NNNN>.json`, or a
  declared exemption. `defect-evidence` replays the fixture from a local stub: the test must
  pass on the spec-correct response and fail on every tamper, starting with the observed
  defect. Every request the test makes (a login included) must be one of the fixture's
  exchanges. Authoring rules and the exemption set: `solution/counterfactual/README.md`.
- An intermittent defect declares `@pytest.mark.repetition(n)` from the ledger's
  reproduction record (RUNNER-CONTRACT.md SD-6), and its one test repeats the reproduction in
  its body: `reproduce(n, attempt)` from `qa.argus` runs up to n attempts, each from fresh
  state, and fails at the first violation. Never parametrize it: each parametrized item is a
  separate case, not an attempt.

```python
# tests/api/test_orders_regression.py
import pytest

from qa.api_client import Endpoints

pytestmark = pytest.mark.api


# BUG-0007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
@pytest.mark.regression
@pytest.mark.bug("BUG-0007")
def test_rejects_negative_quantity(api_as):
    res = api_as("user").post(Endpoints.ORDERS, json={"item": "x", "qty": -5})
    assert res.status_code == 400  # SPEC says reject; app returns 201 -> RED = the bug
```

Run it with `./run-tests.sh --mode defect-evidence`; after the product fix the same test
runs strict green with `--mode candidate-regression`.
