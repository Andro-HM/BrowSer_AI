"""Rate limiter wiring: 30/minute per IP on `/v1/plan`, then 429.

The limiter is disabled under pytest by default (the suite shares one
TestClient IP and would self-429), so this test toggles
`app.state.limiter.enabled` on and restores it in a `finally` — nothing else
in the suite is affected. Deterministic provider, no network calls.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _request() -> dict:
    return {
        "taskObjective": "fill the form",
        "sanitizedVisibleText": "hello",
        "sanitizedPageStructure": [],
        "aliases": [],
        "availableActions": ["CLICK"],
        "provider": "deterministic",
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }


def test_plan_enforces_30_per_minute_then_429(monkeypatch):
    monkeypatch.delenv("PRIVAGENT_API_KEY", raising=False)
    app.state.limiter.enabled = True
    try:
        codes = [client.post("/v1/plan", json=_request()).status_code for _ in range(31)]
    finally:
        app.state.limiter.enabled = False
    assert codes[:30] == [200] * 30
    assert codes[30] == 429
    # The 429 body shape (re-assert on a fresh over-limit hit).
    app.state.limiter.enabled = True
    try:
        response = client.post("/v1/plan", json=_request())
    finally:
        app.state.limiter.enabled = False
    assert response.status_code == 429
    assert response.json() == {"error": "rate_limited"}
