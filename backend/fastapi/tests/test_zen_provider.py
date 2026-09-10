"""OpenCode Zen provider tests (mocked httpx; NO real API calls in CI).

Covers the contract mapping through the Responses envelope (output_text and
output[].content[] extraction), done handling, the shared POST-SCAN,
fail-closed behaviour on every upstream failure class, and per-request
`provider` routing. Zen is mocked entirely; the live model runs only on a
host with OPENCODE_ZEN_API_KEY configured. The real key is never used here.
"""

import httpx
import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch

from app.main import app
from app.llm_common import SYSTEM_INSTRUCTION, PlanResult, PlannedAction
from app.zen_provider import (
    DEFAULT_MODEL,
    ZEN_ENDPOINT,
    _extract_output_text,
    build_zen_json_schema,
)

client = TestClient(app)


def _request(**overrides) -> dict:
    payload = {
        "taskObjective": "click the submit button",
        "sanitizedPageStructure": [
            {
                "tag": "button",
                "controlId": "CONTROL_1",
                "label": "Submit",
                "filled": False,
                "disabled": False,
            },
        ],
        "sanitizedVisibleText": "Order form",
        "aliases": [],
        "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def zen_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PROVIDER", "zen")
    monkeypatch.setenv("OPENCODE_ZEN_API_KEY", "test-key")
    monkeypatch.delenv("OPENCODE_ZEN_MODEL", raising=False)


def _mock_zen_ok(content: str, *, status: int = 200) -> Mock:
    response = Mock()
    response.status_code = status
    response.json.return_value = {"output_text": content}
    post_mock = Mock(return_value=response)
    return post_mock


def _valid_click() -> str:
    return PlanResult(
        action=PlannedAction(type="CLICK", controlId="CONTROL_1"),
        done=False,
        reason="submit button is enabled",
    ).model_dump_json()


def test_click_valid_result(zen_env):
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(_valid_click())):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json() == {"actions": [{"action": "CLICK", "target": "CONTROL_1"}]}


def test_type_using_alias(zen_env):
    content = PlanResult(
        action=PlannedAction(type="TYPE", controlId="CONTROL_1", value="USER_EMAIL_1"),
        done=False,
        reason="email field is empty",
    ).model_dump_json()
    payload = _request(
        taskObjective="fill the form with my details",
        sanitizedPageStructure=[
            {
                "tag": "input",
                "controlId": "CONTROL_1",
                "inputType": "email",
                "label": "Email",
                "filled": False,
                "disabled": False,
            },
        ],
        sanitizedVisibleText="Contact USER_EMAIL_1",
        aliases=[{"alias": "USER_EMAIL_1", "category": "EMAIL"}],
    )
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(content)):
        response = client.post("/v1/plan", json=payload)
    assert response.status_code == 200
    assert response.json() == {
        "actions": [{"action": "TYPE", "target": "CONTROL_1", "value": "USER_EMAIL_1"}]
    }


def test_done_result_returns_no_actions(zen_env):
    content = PlanResult(action=None, done=True, reason="already submitted").model_dump_json()
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(content)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == []


def test_malformed_json_fails_closed(zen_env):
    with patch("app.zen_provider.httpx.post", _mock_zen_ok("this is not json")):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_wrong_control_target_fails_closed(zen_env):
    # Selector-shaped target: strict PlanResult rejects it.
    bad = '{"action": {"type": "CLICK", "controlId": "#submit"}, "done": false, "reason": "go"}'
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(bad)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"
    # Extra field smuggled alongside a valid shape: extra="forbid" rejects it.
    smuggled = (
        '{"action": {"type": "CLICK", "controlId": "CONTROL_1", "selector": "#submit"}, '
        '"done": false, "reason": "go"}'
    )
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(smuggled)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_pii_in_model_output_rejected_by_post_scan(zen_env):
    content = PlanResult(
        action=PlannedAction(type="TYPE", controlId="CONTROL_1", value="user@example.test"),
        done=False,
        reason="filling the email",
    ).model_dump_json()
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(content)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "PII leak detected in LLM response"


def test_no_output_text_fails_closed(zen_env):
    response_mock = Mock()
    response_mock.status_code = 200
    response_mock.json.return_value = {"output": []}
    with patch("app.zen_provider.httpx.post", Mock(return_value=response_mock)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_missing_api_key_returns_502(zen_env, monkeypatch):
    monkeypatch.delenv("OPENCODE_ZEN_API_KEY")
    with patch("app.zen_provider.httpx.post") as post_mock:
        response = client.post("/v1/plan", json=_request())
    post_mock.assert_not_called()
    assert response.status_code == 502
    assert "OPENCODE_ZEN_API_KEY" in str(response.json()["detail"])


def test_timeout_fails_closed_with_502(zen_env):
    with patch(
        "app.zen_provider.httpx.post",
        Mock(side_effect=httpx.TimeoutException("timed out")),
    ):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "llm_timeout"


def test_network_error_fails_closed_with_502(zen_env):
    with patch(
        "app.zen_provider.httpx.post",
        Mock(side_effect=httpx.ConnectError("connection refused")),
    ):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failure_fails_closed_without_leaking_body(zen_env, status):
    response_mock = Mock()
    response_mock.status_code = status
    response_mock.text = "sensitive upstream diagnostics"
    with patch("app.zen_provider.httpx.post", Mock(return_value=response_mock)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"
    assert "sensitive upstream diagnostics" not in response.text


def test_rate_limit_fails_closed_with_502(zen_env):
    response_mock = Mock()
    response_mock.status_code = 429
    with patch("app.zen_provider.httpx.post", Mock(return_value=response_mock)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_server_error_fails_closed_with_502(zen_env):
    response_mock = Mock()
    response_mock.status_code = 500
    with patch("app.zen_provider.httpx.post", Mock(return_value=response_mock)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_model_override_through_env(zen_env, monkeypatch):
    monkeypatch.setenv("OPENCODE_ZEN_MODEL", "gpt-5.6-luna-experimental")
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(_valid_click())) as post_mock:
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    _, kwargs = post_mock.call_args
    assert kwargs["json"]["model"] == "gpt-5.6-luna-experimental"


def test_default_model_and_request_shape(zen_env):
    assert DEFAULT_MODEL == "gpt-5.6-luna"
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(_valid_click())) as post_mock:
        response = client.post(
            "/v1/plan",
            json=_request(
                lastExecutedAction={"action": "CLICK", "controlId": "CONTROL_1", "outcome": "executed"},
            ),
        )
    assert response.status_code == 200
    assert post_mock.call_count == 1
    (url,), kwargs = post_mock.call_args
    assert url == ZEN_ENDPOINT
    assert kwargs["headers"]["Authorization"] == "Bearer test-key"
    body = kwargs["json"]
    assert body["model"] == "gpt-5.6-luna"
    assert body["instructions"] == SYSTEM_INSTRUCTION
    sent = json_loads(body["input"])
    assert sent["taskObjective"] == "click the submit button"
    assert sent["lastExecutedAction"] == {
        "action": "CLICK",
        "controlId": "CONTROL_1",
        "outcome": "executed",
    }
    assert body["text"]["format"]["name"] == "privagent_plan"
    assert body["text"]["format"]["strict"] is True


def test_wire_schema_is_discriminated_and_closed():
    schema = build_zen_json_schema()
    assert schema["required"] == ["action", "done", "reason"]
    assert schema["additionalProperties"] is False
    branches = schema["properties"]["action"]["anyOf"]
    assert len(branches) == 6  # CLICK, TYPE, SELECT, SCROLL, NAVIGATE, null
    by_type = {}
    for branch in branches:
        if branch.get("type") == "null":
            continue
        t = branch["properties"]["type"]["enum"][0]
        by_type[t] = branch
        assert branch["additionalProperties"] is False
    assert set(by_type["CLICK"]["required"]) == {"type", "controlId"}
    assert set(by_type["TYPE"]["required"]) == {"type", "controlId", "value"}
    assert set(by_type["SELECT"]["required"]) == {"type", "controlId", "value"}
    assert set(by_type["SCROLL"]["required"]) == {"type", "direction"}
    assert set(by_type["NAVIGATE"]["required"]) == {"type", "url"}


def test_output_envelope_fallback_extraction():
    nested = {
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": '{"action": null, "done": true, "reason": "ok"}',
                    }
                ],
            }
        ]
    }
    assert _extract_output_text({"output_text": "  x  "}) == "  x  "
    assert _extract_output_text(nested) == '{"action": null, "done": true, "reason": "ok"}'
    assert _extract_output_text({}) is None
    assert _extract_output_text({"output": [{"content": [{"type": "other"}]}]}) is None


def test_request_provider_routes_to_zen_over_env(monkeypatch):
    monkeypatch.delenv("AGENT_PROVIDER", raising=False)
    monkeypatch.setenv("OPENCODE_ZEN_API_KEY", "test-key")
    with patch("app.zen_provider.httpx.post", _mock_zen_ok(_valid_click())) as post_mock:
        response = client.post("/v1/plan", json=_request(provider="zen"))
    assert response.status_code == 200
    assert response.json()["actions"] == [{"action": "CLICK", "target": "CONTROL_1"}]
    post_mock.assert_called_once()


def json_loads(text: str) -> dict:
    import json as _json

    return _json.loads(text)
