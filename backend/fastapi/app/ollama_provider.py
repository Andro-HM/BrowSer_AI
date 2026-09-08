"""M9 — Local model provider (Ollama) for the `AGENT_PROVIDER` seam.

Runs an open-weights model ON-DEVICE via Ollama (e.g. Gemma 3 12B — set `OLLAMA_MODEL`
to your exact tag; the Gemma 3 family is also multimodal, which is the future vision
path). The request is ALREADY sanitized by the extension; this provider enforces the
SAME fail-closed guarantees as the Gemini provider via the shared `llm_common`:
  - JSON-mode output parsed into `PlanResult` (a malformed answer fails closed);
  - POST-SCAN on the model's output (`value`, `reason`) -> HTTP 502 on a leak;
  - Ollama down / 5xx / timeout / malformed JSON -> `LLMUnavailableError` -> HTTP 502
    `llm_unavailable`.

Privacy: nothing leaves the machine — the strongest tier (CONTRIBUTING.md §5).
"""

from __future__ import annotations

import json
import os

import httpx

from .agent import PlanRequest, PlanResponse
from .llm_common import (
    LLMUnavailableError,
    PlanResult,
    SYSTEM_INSTRUCTION,
    post_scan,
    to_plan_response,
)

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "gemma3:12b"
TIMEOUT_SECONDS = 90.0


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model

    def plan(self, request: PlanRequest) -> PlanResponse:
        payload = {
            "taskObjective": request.taskObjective,
            "sanitizedVisibleText": request.sanitizedVisibleText,
            "sanitizedPageStructure": [node.model_dump() for node in request.sanitizedPageStructure],
            "aliases": [binding.model_dump() for binding in request.aliases],
            "availableActions": request.availableActions,
        }

        try:
            response = httpx.post(
                f"{self.base_url}/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_INSTRUCTION},
                        {"role": "user", "content": json.dumps(payload)},
                    ],
                    "response_format": {"type": "json_object"},
                },
                timeout=TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPError:
            raise LLMUnavailableError() from None

        try:
            content = response.json()["choices"][0]["message"]["content"]
            parsed = PlanResult.model_validate_json(content)
        except (KeyError, IndexError, TypeError, ValueError):
            raise LLMUnavailableError() from None

        # POST-SCAN: the local model's output must never carry raw PII either.
        post_scan(parsed)
        return to_plan_response(parsed)


def create_ollama_provider() -> OllamaProvider:
    return OllamaProvider(
        base_url=os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL),
        model=os.environ.get("OLLAMA_MODEL", DEFAULT_MODEL),
    )