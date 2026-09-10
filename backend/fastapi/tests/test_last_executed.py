"""Last-executed-action history: the planner sees the previous success without
seeing any raw values, so a model can recognize completion instead of repeating.

Covers: history shape without raw values/selectors; updated text + history can
yield completion (mocked LLM `done`); the model payload forwards the history for
both Gemini and Ollama; deterministic does NOT auto-complete repeats (the loop
NO_PROGRESS guard stays necessary); raw PII in history fails closed.
"""

import json
from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agent import PlanRequest
from app.llm_common import SYSTEM_INSTRUCTION
from app.main import app

client = TestClient(app)

CANARY_EMAIL = "CANARY_HISTORY_001@example.test"


def _request(**overrides) -> dict:
    payload = {
        "taskObjective": "click the submit button",
        "sanitizedPageStructure": [
            {"tag": "button", "controlId": "CONTROL_3", "label": "Submit", "filled": False, "disabled": False},
        ],
        "sanitizedVisibleText": "Order form — review and submit",
        "aliases": [],
        "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload


def test_history_shape_carries_no_raw_values_or_selectors():
    request = PlanRequest(**_request(
        lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"},
    ))
    assert request.lastExecutedAction is not None
    dumped = request.lastExecutedAction.model_dump()
    assert dumped == {"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"}
    assert "value" not in dumped and "url" not in dumped and "selector" not in dumped
    # First step omits the field entirely — it stays optional.
    assert PlanRequest(**_request()).lastExecutedAction is None


def test_deterministic_accepts_history_but_does_not_auto_complete_repeats():
    """The offline planner ignores history: the same click is still proposed,
    so the loop's NO_PROGRESS guard remains the necessary fail-safe."""
    first = _request()
    second = _request(
        sanitizedVisibleText="Confirmation screen",
        lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"},
    )
    assert client.post("/v1/plan", json=first).json()["actions"] == [
        {"action": "CLICK", "target": "CONTROL_3"}
    ]
    # No special-casing: the repeat is still proposed, never silently completed.
    assert client.post("/v1/plan", json=second).json()["actions"] == [
        {"action": "CLICK", "target": "CONTROL_3"}
    ]


def test_updated_text_plus_history_can_produce_completion_gemini(monkeypatch):
    from app.llm_common import PlanResult

    monkeypatch.setenv("AGENT_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client_mock = Mock()
    response_mock = Mock()
    response_mock.parsed = PlanResult(action=None, done=True, reason="submit already succeeded")
    client_mock.models.generate_content.return_value = response_mock
    payload = _request(
        sanitizedVisibleText="Confirmation screen",
        lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"},
    )
    with patch("google.genai.Client", return_value=client_mock):
        response = client.post("/v1/plan", json=payload)
    assert response.status_code == 200
    assert response.json()["actions"] == []
    # The history actually reached the model payload.
    _, kwargs = client_mock.models.generate_content.call_args
    sent = json.loads(kwargs["contents"])
    assert sent["lastExecutedAction"] == {"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"}


def test_history_forwarded_to_ollama_payload(monkeypatch):
    from app.llm_common import PlanResult, PlannedAction

    monkeypatch.setenv("AGENT_PROVIDER", "ollama")
    result = PlanResult(action=None, done=True, reason="already submitted")
    post_mock = Mock()
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"choices": [{"message": {"content": result.model_dump_json()}}]}
    post_mock.return_value = response
    payload = _request(
        sanitizedVisibleText="Confirmation screen",
        lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"},
    )
    with patch("app.ollama_provider.httpx.post", post_mock):
        http = client.post("/v1/plan", json=payload)
    assert http.status_code == 200
    assert http.json()["actions"] == []
    _, kwargs = post_mock.call_args
    sent = json.loads(kwargs["json"]["messages"][1]["content"])
    assert sent["lastExecutedAction"] == {"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"}


def test_system_instruction_mentions_history_completion_and_no_repeat():
    assert "lastExecutedAction" in SYSTEM_INSTRUCTION
    assert "done: true" in SYSTEM_INSTRUCTION
    assert "blindly repeat" in SYSTEM_INSTRUCTION
    # No fixture-specific special-casing.
    assert "FORM SUBMITTED" not in SYSTEM_INSTRUCTION
    assert "CONTROL_3" not in SYSTEM_INSTRUCTION


def test_raw_pii_and_malformed_history_fail_closed_without_echo():
    # Selector-shaped handle rejected by the contract.
    bad_shape = _request(lastExecutedAction={"action": "CLICK", "controlId": "#submit", "outcome": "executed"})
    response = client.post("/v1/plan", json=bad_shape)
    assert response.status_code == 422
    assert "#submit" not in response.text

    # Smuggled value field rejected (extra="forbid").
    smuggled = _request(
        lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed", "value": CANARY_EMAIL},
    )
    response = client.post("/v1/plan", json=smuggled)
    assert response.status_code == 422
    assert CANARY_EMAIL not in response.text

    # SCROLL must not carry a handle; CLICK must carry one.
    scroll_handle = _request(lastExecutedAction={"action": "SCROLL", "controlId": "CONTROL_3", "outcome": "executed"})
    assert client.post("/v1/plan", json=scroll_handle).status_code == 422
    missing_handle = _request(lastExecutedAction={"action": "CLICK", "outcome": "executed"})
    assert client.post("/v1/plan", json=missing_handle).status_code == 422

    # Raw PII cannot hide in the history handle either.
    pii_history = _request(lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"})
    pii_history["sanitizedVisibleText"] = f"reach {CANARY_EMAIL}"
    response = client.post("/v1/plan", json=pii_history)
    assert response.status_code == 422
    assert CANARY_EMAIL not in response.text


def test_ollama_down_with_history_still_fails_closed(monkeypatch):
    monkeypatch.setenv("AGENT_PROVIDER", "ollama")
    payload = _request(lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_3", "outcome": "executed"})
    with patch(
        "app.ollama_provider.httpx.post",
        Mock(side_effect=httpx.ConnectError("connection refused")),
    ):
        response = client.post("/v1/plan", json=payload)
    assert response.status_code == 502
