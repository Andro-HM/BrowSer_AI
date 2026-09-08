"""M8 — Gemini Flash provider for the `AGENT_PROVIDER` seam.

Plans the next structured action via Gemini's native structured-JSON output
(`response_schema`), so the model returns valid JSON without markdown wrapping.

PRIVACY (CONTRIBUTING.md §5): the request is ALREADY sanitized by the extension —
this provider never sees raw values by contract. It adds a POST-SCAN on the model's
own output and FAILS CLOSED. Shared schema/system-instruction/post-scan live in
`llm_common.py` so the Gemini and Ollama providers behave identically.
"""

from __future__ import annotations

import json
import os

from fastapi import HTTPException

from .agent import PlanRequest, PlanResponse
from .llm_common import (
    LLMPIILeakError as GeminiPIILeakError,
    LLMUnavailableError as GeminiUnavailableError,
    PlanResult,
    PlannedAction,
    SYSTEM_INSTRUCTION,
    post_scan,
    to_plan_response,
)

DEFAULT_MODEL = "gemini-2.0-flash"


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str | None, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def plan(self, request: PlanRequest) -> PlanResponse:
        # Missing key is surfaced on the planning path only (never on /health).
        if not self.api_key:
            raise HTTPException(
                status_code=500, detail="GEMINI_API_KEY environment variable is missing"
            )

        # Imported here so the module is importable (and the deterministic default
        # keeps working) even when the Google SDK is absent.
        from google import genai  # type: ignore[import-not-found]
        from google.genai import types  # type: ignore[import-not-found]

        client = genai.Client(api_key=self.api_key)

        payload = {
            "taskObjective": request.taskObjective,
            "sanitizedVisibleText": request.sanitizedVisibleText,
            "sanitizedPageStructure": [node.model_dump() for node in request.sanitizedPageStructure],
            "aliases": [binding.model_dump() for binding in request.aliases],
            "availableActions": request.availableActions,
        }

        try:
            response = client.models.generate_content(
                model=self.model,
                contents=json.dumps(payload),
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=PlanResult,
                    system_instruction=SYSTEM_INSTRUCTION,
                ),
            )
        except Exception:
            raise GeminiUnavailableError() from None

        parsed = response.parsed if response is not None else None
        if not isinstance(parsed, PlanResult):
            raise GeminiUnavailableError()

        # POST-SCAN: the model's own output must never carry raw PII.
        post_scan(parsed)
        return to_plan_response(parsed)


def create_gemini_provider() -> GeminiProvider:
    return GeminiProvider(
        api_key=os.environ.get("GEMINI_API_KEY"),
        model=os.environ.get("GEMINI_MODEL", DEFAULT_MODEL),
    )