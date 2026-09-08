"""SSRF guard: `OLLAMA_URL` is validated at provider construction.

Loopback `http(s)` is always accepted; everything else (private ranges,
link-local metadata endpoints, non-http schemes, bare hostnames) raises
`ValueError` unless `OLLAMA_ALLOW_REMOTE=true` explicitly permits remote use.
No network calls in these tests.
"""

import pytest

from app.ollama_provider import OllamaProvider


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
