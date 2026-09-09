"""Gemini structured-output wire-compatibility regressions (mocked; NO real API calls).

The legacy `response_schema=PlanResult` path sent Pydantic's
`additionalProperties`/`pattern`/`maxLength` keys, which gemini-3.x rejects with
400 INVALID_ARGUMENT (`Unknown name "additional_properties"`). The provider now
sends a sanitized `response_json_schema` dict and revalidates raw model JSON
through the strict internal `PlanResult`. These tests prove the wire schema is
clean AND local strictness (CONTROL_n, extra="forbid", fail-closed) is intact.
"""

import json
from unittest.mock import Mock, patch

import pytest
from fastapi.testclient import TestClient

from app.gemini_provider import DEFAULT_MODEL, PlanResult, build_gemini_json_schema
from app.main import app

client = TestClient(app)

#: Keys Pydantic emits that the Gemini wire path rejects. None may appear
#: anywhere in the sanitized wire schema (recursively, including $defs).
BANNED_WIRE_KEYS = frozenset(
    {
        "additionalProperties",
        "additional_properties",
        "pattern",
        "maxLength",
        "minLength",
        "default",
        "const",
        "examples",
        "example",
        "discriminator",
    }
)


def _request(**overrides) -> dict:
    payload = {
        "taskObjective": "fill the form with my details and submit",
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
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def gemini_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.6-flash")


def _mock_gemini_text(text: str) -> Mock:
    """Mock whose SDK response carries RAW model JSON text (the real 3.x path:
    no SDK auto-parse into our model — the provider must revalidate it)."""
    client_mock = Mock()
    response_mock = Mock()
    response_mock.parsed = None
    response_mock.text = text
    client_mock.models.generate_content.return_value = response_mock
    return client_mock


def _collect_keys(node: object, found: set[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            _collect_keys(value, found)
    elif isinstance(node, list):
        for value in node:
            _collect_keys(value, found)


def test_default_model_is_gemini_36_flash():
    assert DEFAULT_MODEL == "gemini-3.6-flash"


def test_wire_schema_contains_no_unsupported_legacy_fields():
    schema = build_gemini_json_schema()
    assert isinstance(schema, dict)
    keys: set[str] = set()
    _collect_keys(schema, keys)
    assert keys.isdisjoint(BANNED_WIRE_KEYS), f"banned wire keys present: {keys & BANNED_WIRE_KEYS}"
    # Contract shape survives sanitization: action union, done/reason, $defs/$ref.
    assert schema["type"] == "object"
    assert set(schema["required"]) == {"done", "reason"}
    assert "PlannedAction" in schema["$defs"]
    assert schema["$defs"]["PlannedAction"]["required"] == ["type"]


def test_provider_sends_json_schema_not_legacy_response_schema(gemini_env):
    mock = _mock_gemini_text(
        json.dumps({"action": None, "done": True, "reason": "task complete"})
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == []
    _, kwargs = mock.models.generate_content.call_args
    config = kwargs["config"]
    assert config.response_schema is None
    assert isinstance(config.response_json_schema, dict)
    keys: set[str] = set()
    _collect_keys(config.response_json_schema, keys)
    assert keys.isdisjoint(BANNED_WIRE_KEYS)


def test_non_control_target_rejected_after_gemini_output(gemini_env):
    mock = _mock_gemini_text(
        json.dumps(
            {
                "action": {"type": "CLICK", "controlId": "email-submit"},
                "done": False,
                "reason": "clicking submit",
            }
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_extra_model_controlled_field_rejected(gemini_env):
    mock = _mock_gemini_text(
        json.dumps(
            {
                "action": {"type": "CLICK", "controlId": "CONTROL_1", "selector": "#submit"},
                "done": False,
                "reason": "clicking submit",
            }
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_malformed_gemini_json_fails_closed(gemini_env):
    mock = _mock_gemini_text('{"action": {"type": "CLICK"')
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_strict_internal_model_still_forbids_extras():
    # The internal boundary itself is untouched: direct validation rejects extras
    # and non-CONTROL_n targets regardless of what the wire allowed through.
    with pytest.raises(Exception):
        PlanResult.model_validate({"action": None, "done": True, "reason": "x", "extra": 1})
