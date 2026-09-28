"""End-to-end api lane for scripts/smoke-argus-runtime-python.sh, installed as
api/test_widget_regression.py under the scaffold's test root.
scripts/fixtures/argus-runtime/faulty-target.mjs is the target.
"""
import pytest

pytestmark = pytest.mark.api


# BUG-0001 (origin ATA-001, oracle ORC-API-001): GET /widgets/1 returns the widget. The target
# answers 500 in buggy mode, so the regression is RED until the target is fixed. The smoke
# deletes the strict-body line to build a weakened copy that the missing-field tamper survives.
@pytest.mark.regression
@pytest.mark.bug("ATA-001")
def test_widget_read_returns_the_specified_widget(api_as):
    res = api_as("user").get("/widgets/1")
    assert res.status_code == 200
    assert res.json() == {"id": 1, "name": "widget"}  # argus-smoke: strict body


# A non-regression neighbour: baseline selects only this test while the known bug is RED,
# and full-suite runs both.
def test_health_endpoint_reports_ok(anon_client):
    res = anon_client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
