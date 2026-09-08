"""Bearer auth on /v1/*: enforced when `PRIVAGENT_API_KEY` is set, open dev
mode when it is not. Deterministic provider — no network calls."""

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


def test_missing_token_when_key_required_gives_401(monkeypatch):
    monkeypatch.setenv("PRIVAGENT_API_KEY", "secret-key")
    response = client.post("/v1/plan", json=_request())
    assert response.status_code == 401
    assert response.json()["detail"] == {"error": "unauthorized"}


def test_wrong_token_gives_401(monkeypatch):
    monkeypatch.setenv("PRIVAGENT_API_KEY", "secret-key")
    response = client.post(
        "/v1/plan", json=_request(), headers={"Authorization": "Bearer wrong-key"}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {"error": "unauthorized"}


def test_correct_token_gives_200(monkeypatch):
    monkeypatch.setenv("PRIVAGENT_API_KEY", "secret-key")
    response = client.post(
        "/v1/plan", json=_request(), headers={"Authorization": "Bearer secret-key"}
    )
    assert response.status_code == 200
    assert response.json() == {"actions": []}


def test_no_key_configured_gives_200_dev_mode(monkeypatch):
    monkeypatch.delenv("PRIVAGENT_API_KEY", raising=False)
    response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json() == {"actions": []}
