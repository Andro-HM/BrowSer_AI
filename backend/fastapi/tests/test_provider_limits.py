"""Provider limits: Gemini 30s timeout and `availableActions` enforcement.

Timeout test forces `generate_content` to raise `TimeoutError` (mocked client,
no network). Enforcement tests drive the mocked Gemini planner with a NAVIGATE
result against narrowing allowlists.
"""

from fastapi.testclient import TestClient
from unittest.mock import Mock, patch

from app.main import app

from app.llm_common import PlanResult, PlannedAction

client = TestClient(app)


def _request(**overrides) -> dict:
    payload = {
        "taskObjective": "open example.com",
        "pageOrigin": "https://app.test",
        "sanitizedPageStructure": [],
        "sanitizedVisibleText": "landing page",
        "aliases": [],
        "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        "provider": "gemini",
        "policy": {"privacyMode": "strict", "navigationAllowlist": ["https://example.com"]},
    }
    payload.update(overrides)
    return payload


def _mock_gemini(parsed: PlanResult | None = None, *, side_effect=None) -> Mock:
    client_mock = Mock()
    if side_effect is not None:
        client_mock.models.generate_content.side_effect = side_effect
    else:
        response_mock = Mock()
        response_mock.parsed = parsed
        client_mock.models.generate_content.return_value = response_mock
    return client_mock


def _gemini_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


def test_gemini_timeout_gives_502_llm_timeout(monkeypatch):
    _gemini_env(monkeypatch)
    mock = _mock_gemini(side_effect=TimeoutError("timed out"))
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == {
        "error": "llm_timeout",
        "message": "Gemini did not respond in 30s",
    }


def test_navigate_filtered_out_when_not_allowed(monkeypatch):
    _gemini_env(monkeypatch)
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="NAVIGATE", url="https://example.com/"),
            done=False,
            reason="navigating onward",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request(availableActions=["CLICK", "TYPE"]))
    assert response.status_code == 200
    assert response.json() == {"actions": []}


def test_empty_allowlist_means_allow_all(monkeypatch):
    _gemini_env(monkeypatch)
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="NAVIGATE", url="https://example.com/"),
            done=False,
            reason="navigating onward",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request(availableActions=[]))
    assert response.status_code == 200
    assert response.json() == {"actions": [{"action": "NAVIGATE", "url": "https://example.com/"}]}


def test_only_navigate_allowed_but_nothing_else_returned(monkeypatch):
    _gemini_env(monkeypatch)
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="NAVIGATE", url="https://example.com/"),
            done=False,
            reason="navigating onward",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request(availableActions=["CLICK"]))
    assert response.status_code == 200
    assert response.json() == {"actions": []}
