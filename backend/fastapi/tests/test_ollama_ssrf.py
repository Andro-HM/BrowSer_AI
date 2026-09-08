"""SSRF guard: `OLLAMA_URL` is validated at provider construction.

Loopback `http(s)` is always accepted; everything else (private ranges,
link-local metadata endpoints, non-http schemes, bare hostnames) raises
`ValueError` unless `OLLAMA_ALLOW_REMOTE=true` explicitly permits remote use.
A rejected URL surfaces through `/v1/plan` as 502 (never 500, never with the
URL echoed). No network calls in these tests.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.ollama_provider import OllamaProvider

client = TestClient(app)


def test_loopback_localhost_accepted(monkeypatch):
    monkeypatch.delenv("OLLAMA_ALLOW_REMOTE", raising=False)
    provider = OllamaProvider(base_url="http://localhost:11434", model="gemma3:12b")
    assert provider.base_url == "http://localhost:11434"


def test_loopback_127_accepted(monkeypatch):
    monkeypatch.delenv("OLLAMA_ALLOW_REMOTE", raising=False)
    provider = OllamaProvider(base_url="http://127.0.0.1:11434", model="gemma3:12b")
    assert provider.base_url == "http://127.0.0.1:11434"


def test_link_local_metadata_blocked(monkeypatch):
    monkeypatch.delenv("OLLAMA_ALLOW_REMOTE", raising=False)
    with pytest.raises(ValueError, match="OLLAMA_URL must point to loopback"):
        OllamaProvider(base_url="http://169.254.169.254", model="gemma3:12b")


def test_rfc1918_private_blocked(monkeypatch):
    monkeypatch.delenv("OLLAMA_ALLOW_REMOTE", raising=False)
    with pytest.raises(ValueError, match="OLLAMA_URL must point to loopback"):
        OllamaProvider(base_url="http://192.168.1.1:11434", model="gemma3:12b")


def test_file_scheme_blocked(monkeypatch):
    monkeypatch.delenv("OLLAMA_ALLOW_REMOTE", raising=False)
    with pytest.raises(ValueError, match="OLLAMA_URL must point to loopback"):
        OllamaProvider(base_url="file:///etc/passwd", model="gemma3:12b")


def test_remote_hostname_allowed_with_explicit_flag(monkeypatch):
    monkeypatch.setenv("OLLAMA_ALLOW_REMOTE", "true")
    provider = OllamaProvider(base_url="http://remote-host:11434", model="gemma3:12b")
    assert provider.base_url == "http://remote-host:11434"


def test_rejected_url_config_maps_to_502_not_500(monkeypatch):
    """The `except ValueError` arm in `main._plan_impl`: SSRF stays blocked,
    surfaced as 502 `llm_unavailable` — never a 500, never echoing the URL."""
    monkeypatch.setenv("OLLAMA_URL", "http://169.254.169.254")
    monkeypatch.delenv("OLLAMA_ALLOW_REMOTE", raising=False)
    response = client.post(
        "/v1/plan",
        json={
            "taskObjective": "fill form",
            "sanitizedVisibleText": "hello",
            "sanitizedPageStructure": [],
            "aliases": [],
            "availableActions": ["CLICK"],
            "provider": "ollama",
            "policy": {"privacyMode": "strict", "navigationAllowlist": []},
        },
    )
    assert response.status_code == 502
    assert response.json()["detail"] == {
        "error": "llm_unavailable",
        "message": "invalid OLLAMA_URL config",
    }
