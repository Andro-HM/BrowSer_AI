"""Scan-coverage regression tests: every model- and client-controlled string is
PII-scanned in both directions.

- POST-SCAN (`llm_common.post_scan`): reason + value + controlId + url.
  A leak anywhere → 502 via the Gemini provider (mocked client, no network).
- PRE-SCAN (`main.plan`): taskObjective + visibleText + struct fields (existing)
  + pageOrigin. A leak anywhere → 422 before any provider runs.
"""

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch

from app.main import app

from app.llm_common import PlanResult, PlannedAction

client = TestClient(app)


def _clean_request(**overrides) -> dict:
    payload = {
        "taskObjective": "fill the form with my details and submit",
        "pageOrigin": "https://app.test",
        "sanitizedPageStructure": [
            {
                "tag": "input",
                "controlId": "CONTROL_1",
                "inputType": "email",
                "label": "Email",
                "filled": False,
                "disabled": False,
            },
        ],
        "sanitizedVisibleText": "Contact USER_EMAIL_1",
        "aliases": [{"alias": "USER_EMAIL_1", "category": "EMAIL"}],
        "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        "provider": "deterministic",
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload


def _mock_gemini(parsed: PlanResult) -> Mock:
    client_mock = Mock()
    response_mock = Mock()
    response_mock.parsed = parsed
    client_mock.models.generate_content.return_value = response_mock
    return client_mock


def test_model_action_rejects_nonopaque_control_id():
    with pytest.raises(ValidationError):
        PlannedAction(type="CLICK", controlId="[name='CANARY_EMAIL_001@example.test']")


def test_pii_in_action_url_gives_502(monkeypatch):
    monkeypatch.setenv("AGENT_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="NAVIGATE", url="https://x.test/?email=victim@test.com"),
            done=False,
            reason="navigating onward",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_clean_request(provider="gemini"))
    assert response.status_code == 502
    assert response.json()["detail"] == "PII leak detected in LLM response"


def test_pii_in_page_origin_gives_422():
    response = client.post(
        "/v1/plan",
        json=_clean_request(pageOrigin="https://app.test/?email=user@example.test"),
    )
    assert response.status_code == 422
    assert "Raw PII detected" in response.json()["detail"]


def test_clean_request_and_response_gives_200(monkeypatch):
    monkeypatch.setenv("AGENT_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="TYPE", controlId="CONTROL_1", value="USER_EMAIL_1"),
            done=False,
            reason="email field is empty",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_clean_request(provider="gemini"))
    assert response.status_code == 200
    assert response.json() == {
        "actions": [{"action": "TYPE", "target": "CONTROL_1", "value": "USER_EMAIL_1"}]
    }
