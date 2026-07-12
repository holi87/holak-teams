# Regression tests (bug-linked)

When Atalanta confirms a bug, a regression test goes here. **The app is NOT fixed during the engagement**, so the test asserts the SPEC-CORRECT behaviour and will be RED — that red, linked to its bug file, is your evidence that the suite catches the defect (evaluated criterion 4).

Use **red evidence** only: a plain failing test selected by `pytest.mark.regression` whose
`@bug:` provenance maps to the canonical ID or one stable origin alias in
`solution/bug-ledger.json`. Run it in
`--mode defect-evidence`; a pytest hook must append the matching
`product/fail/expected=true/reproduced` event. Candidate/full modes remain strict green.

```python
import pytest
from qa.api_client import Endpoints

pytestmark = pytest.mark.regression


# BUG-0007: server accepts negative quantity (req §3.2 / OpenAPI POST /orders)
def test_bug_007_rejects_negative_quantity(api_as):
    res = api_as("user").post(Endpoints.ORDERS, json={"item": "x", "qty": -5})
    assert res.status_code == 400  # SPEC says reject; app returns 201 -> RED = the bug
```

Do **not** use expected-failure wrappers (`pytest.mark.xfail`, `skip`, conditional `skipif` on the bug) for confirmed defects. A known bug must keep its regression RED until the application is fixed.

Every regression test carries the native regression marker plus `@bug:<canonical-or-origin>`, cites the oracle, and emits the lifecycle event
through `scripts/outcome-event.sh`. One regression test per confirmed bug; tag it with
`@pytest.mark.regression`.
