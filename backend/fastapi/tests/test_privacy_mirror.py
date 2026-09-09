"""M9 mirror — the backend's own defense-in-depth gate at the remote boundary.

The extension firewall is the single egress gate and is tested separately
(`tests/unit/firewall-canary.test.ts`). These tests assert the SERVER-SIDE mirror covers
the same surface, because the mirror's whole reason to exist is the case where the client
gate did not run: a stale extension build, a hand-rolled request, a future second client.

Canaries are synthetic constants, so a hit is unambiguous evidence rather than a
coincidence, and no real user's data is ever involved. The positive control matters as
much as the refusals: if a sanitized request were also rejected, these tests would "pass"
while the service did nothing.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.pii_scan import contains_pixel_payload, scan_pii

client = TestClient(app)

CANARY_EMAIL = "CANARY_EMAIL_001@example.test"
CANARY_PHONE = "555-123-4567"
CANARY_CARD = "4111 1111 1111 1111"
CANARY_PASSWORD = "CANARY_PASSWORD_001"
#: A real (tiny) PNG data URL — the shape a `captureVisibleTab` result actually has.
CANARY_SCREENSHOT = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)


def _request(**overrides) -> dict:
    payload = {
        "taskObjective": "fill the checkout form and submit",
        "pageOrigin": "https://shop.example.test",
        "sanitizedPageStructure": [
            {
                "tag": "input",
                "control": "CONTROL_1",
                "inputType": "email",
                "label": "Email",
                "filled": False,
                "disabled": False,
            },
        ],
        "sanitizedVisibleText": "Checkout · Email USER_EMAIL_1 · Total 42.00",
        "aliases": [{"alias": "USER_EMAIL_1", "category": "EMAIL"}],
        "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload


def _with_node(**node_overrides) -> dict:
    payload = _request()
    payload["sanitizedPageStructure"][0].update(node_overrides)
    return payload


def test_sanitized_request_is_accepted_positive_control():
    response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == [
        {"action": "TYPE", "target": "CONTROL_1", "value": "USER_EMAIL_1"}
    ]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sanitizedVisibleText", f"Signed in as {CANARY_EMAIL}"),
        ("sanitizedVisibleText", f"Call {CANARY_PHONE}"),
        ("sanitizedVisibleText", f"Card {CANARY_CARD}"),
        ("taskObjective", f"email the receipt to {CANARY_EMAIL}"),
    ],
)
def test_prescan_refuses_raw_pii_in_top_level_text(field, value):
    response = client.post("/v1/plan", json=_request(**{field: value}))
    assert response.status_code == 422
    assert "Raw PII detected" in response.json()["detail"]


@pytest.mark.parametrize("node_field", ["label"])
def test_prescan_refuses_raw_pii_smuggled_into_a_node(node_field):
    """The per-node strings are exactly what the provider serializes into its prompt."""
    response = client.post("/v1/plan", json=_with_node(**{node_field: CANARY_EMAIL}))
    assert response.status_code == 422
    assert "Raw PII detected" in response.json()["detail"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sanitizedVisibleText", f"Password: {CANARY_PASSWORD}"),
        ("sanitizedVisibleText", f"api_key = {CANARY_PASSWORD}"),
        ("sanitizedVisibleText", f'secret: "{CANARY_PASSWORD}"'),
        ("taskObjective", f"sign in with password:{CANARY_PASSWORD}"),
    ],
)
def test_prescan_refuses_a_labelled_credential(field, value):
    """The asymmetry this closes was real: the mirror recognized EMAIL/PHONE/PAYMENT only.

    `tests/unit/firewall-canary.test.ts` asserts the extension gate blocks RAW_CREDENTIAL,
    and this module's whole premise is covering the case where that gate did not run — so a
    labelled password reaching a 200 here was a gap in the mirror, not a difference of
    opinion about severity. The pattern is now the extension's, character for character.
    """
    response = client.post("/v1/plan", json=_request(**{field: value}))
    assert response.status_code == 422
    assert "Raw PII detected" in response.json()["detail"]
    assert "CANARY_PASSWORD_001" not in response.text


def test_credential_shape_the_gates_share_a_blind_spot_for():
    """A KNOWN limitation of the SHARED pattern, asserted so it stays known.

    `Bearer <token>` is separated by whitespace, and the shared `[:=]` pattern requires a
    colon or equals right after the keyword (in "Authorization: Bearer x" the colon belongs
    to "Authorization"), so neither egress gate matches it. This test records the real
    behaviour instead of claiming coverage the code lacks (CONTRIBUTING.md §22).

    It is not an open hole in the product's own path: the value is aliased UPSTREAM by the
    extension's M2 `detectLabeledValues`, whose credential rule accepts a whitespace
    separator and now lists `bearer`, so a bearer token in page text never reaches a
    request. Widening the FIREWALL pattern to match was rejected deliberately — the
    label-evidence rules also match `Name: USER_NAME_1`, so a firewall using them would
    refuse correctly sanitized payloads.
    """
    assert scan_pii(f"Authorization: Bearer {CANARY_PASSWORD}") == []
    response = client.post(
        "/v1/plan",
        json=_request(sanitizedVisibleText=f"Authorization: Bearer {CANARY_PASSWORD}"),
    )
    assert response.status_code == 200


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sanitizedVisibleText", f"Checkout page. {CANARY_SCREENSHOT}"),
        ("taskObjective", f"describe this {CANARY_SCREENSHOT}"),
    ],
)
def test_prescan_refuses_an_encoded_capture(field, value):
    """No PII pattern matches base64 — only the separate media check can catch this."""
    response = client.post("/v1/plan", json=_request(**{field: value}))
    assert response.status_code == 422
    assert "Encoded media detected" in response.json()["detail"]


def test_prescan_refuses_an_encoded_capture_in_a_node_label():
    response = client.post("/v1/plan", json=_with_node(label=CANARY_SCREENSHOT))
    assert response.status_code == 422
    assert "Encoded media detected" in response.json()["detail"]


def test_media_check_does_not_flag_prose_about_images():
    """The pixel check must not degenerate into a second, sloppier PII filter."""
    response = client.post(
        "/v1/plan", json=_request(taskObjective="open the base64 image decoder and submit")
    )
    assert response.status_code == 200


def test_unexpected_top_level_field_is_refused_not_ignored():
    """A smuggled `screenshot` must fail closed, mirroring FIREWALL_UNEXPECTED_FIELD."""
    response = client.post("/v1/plan", json=_request(screenshot=CANARY_SCREENSHOT))
    assert response.status_code == 422


def test_unexpected_node_field_is_refused_not_ignored():
    response = client.post("/v1/plan", json=_with_node(rawValue=CANARY_EMAIL))
    assert response.status_code == 422


def test_refusal_bodies_never_echo_the_canary():
    """A remote boundary that quotes the offending value in its error re-emits the leak.

    Covers both refusal paths: the hand-written scans (HTTPException) and pydantic schema
    validation, whose default handler returns each rejected value in `input`.
    """
    for payload in (
        _request(sanitizedVisibleText=f"Signed in as {CANARY_EMAIL}"),
        _with_node(label=CANARY_EMAIL),
        _request(screenshot=CANARY_SCREENSHOT),
        _request(sanitizedVisibleText=f"page {CANARY_SCREENSHOT}"),
        _request(aliases=[{"alias": CANARY_EMAIL, "category": "EMAIL"}]),
    ):
        response = client.post("/v1/plan", json=payload)
        assert response.status_code == 422
        body = response.text
        assert "CANARY_EMAIL_001" not in body
        assert "iVBORw0KGgo" not in body


def test_validation_errors_still_say_which_field_failed():
    """Dropping the value must not make the 422 useless to a client."""
    response = client.post("/v1/plan", json=_request(screenshot=CANARY_SCREENSHOT))
    assert response.status_code == 422
    errors = response.json()["detail"]
    assert any(item["type"] == "extra_forbidden" for item in errors)
    assert any("screenshot" in item["loc"] for item in errors)


def test_scan_pii_returns_categories_never_the_matched_values():
    """The return value is what a careless caller would put in an error message."""
    found = scan_pii(f"{CANARY_EMAIL} / {CANARY_PHONE} / {CANARY_CARD}")
    assert set(found) == {"EMAIL", "PHONE", "PAYMENT"}
    assert all("CANARY" not in item and "@" not in item for item in found)


def test_scan_pii_reports_credential_as_a_category_too():
    found = scan_pii(f"password: {CANARY_PASSWORD}")
    assert found == ["CREDENTIAL"]


def test_scan_pii_does_not_flag_a_credential_keyword_without_a_value():
    """`{8,}` is what separates a labelled secret from the WORD "password" in prose."""
    assert scan_pii("Reset your password on the account settings page") == []
    assert scan_pii("Password: short") == []


def test_scan_helpers_accept_none_and_pass_aliases():
    assert scan_pii(None, "", "Email USER_EMAIL_1 · Phone USER_PHONE_1") == []
    assert contains_pixel_payload(None, "") is False
    assert contains_pixel_payload(CANARY_SCREENSHOT) is True
