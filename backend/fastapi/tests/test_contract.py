"""Contract-conformance test: the exact example payload from
`docs/interface-contracts.md` §2 must return 200 with a schema-valid ActionPlan.

Deterministic provider only — no API keys, no network calls.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# Verbatim copy of the §2 example request.
EXAMPLE_REQUEST = {
    "taskObjective": "fill the form with my details and submit",
    "pageOrigin": None,
    "sanitizedPageStructure": [
        {
            "tag": "input",
            "controlId": "CONTROL_1",
            "inputType": "email",
            "label": "Email",
            "filled": False,
            "disabled": False,
        }
    ],
    "sanitizedVisibleText": "Contact USER_EMAIL_1",
    "aliases": [{"alias": "USER_EMAIL_1", "category": "EMAIL"}],
    "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
    "provider": "deterministic",
    "policy": {"privacyMode": "strict", "navigationAllowlist": []},
}


def test_docs_example_returns_valid_action_plan():
    response = client.post("/v1/plan", json=EXAMPLE_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {"actions"}
    assert body["actions"] == [
        {"action": "TYPE", "target": "CONTROL_1", "value": "USER_EMAIL_1"}
    ]


def test_docs_example_rejected_without_strict_mode():
    payload = {**EXAMPLE_REQUEST, "policy": {"privacyMode": "permissive", "navigationAllowlist": []}}
    response = client.post("/v1/plan", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == {"error": "invalid_privacy_mode", "allowed": ["strict"]}
