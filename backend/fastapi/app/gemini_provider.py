"""M8 — Gemini Flash provider for the `AGENT_PROVIDER` seam.

Plans the next structured action via Gemini's native structured-JSON output
(`response_json_schema`), so the model returns valid JSON without markdown wrapping.

WIRE vs INTERNAL schema: the strict internal `PlanResult`/`PlannedAction` models
(`llm_common.py`, `extra="forbid"` + CONTROL_n pattern + action validators) are
UNCHANGED and remain the security boundary. They cannot be sent to Gemini
directly: Pydantic emits `additionalProperties`/`pattern`/`maxLength`/`default`
keys that newer models (gemini-3.x) reject with 400 INVALID_ARGUMENT
(`Unknown name "additional_properties"`). We therefore send a SANITIZED wire
schema (supported keys only) and REVALIDATE the raw model JSON through the
strict internal `PlanResult` before `post_scan`/`to_plan_response`. The wire is
permissive; the local revalidation is strict — fail closed on anything malformed.

PRIVACY (CONTRIBUTING.md §5): the request is ALREADY sanitized by the extension —
this provider never sees raw values by contract. It adds a POST-SCAN on the model's
own output and FAILS CLOSED. Shared schema/system-instruction/post-scan live in
`llm_common.py` so the Gemini and Ollama providers behave identically.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
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

# gemini-2.5-flash is unavailable to new users; retain GEMINI_MODEL as an explicit
# deployment override.
DEFAULT_MODEL = "gemini-3.6-flash"

#: Keys the Gemini `response_json_schema` path documents as supported. Everything
#: else Pydantic emits (additionalProperties, pattern, maxLength/minLength,
#: default, title is kept, const, examples, discriminator, …) is stripped from
#: the WIRE schema only. Strictness lives in the local `PlanResult` revalidation.
_GEMINI_WIRE_ALLOWED_KEYS = frozenset(
    {
        "$id",
        "$defs",
        "$ref",
        "$anchor",
        "type",
        "format",
        "title",
        "description",
        "enum",
        "items",
        "prefixItems",
        "minItems",
        "maxItems",
        "minimum",
        "maximum",
        "anyOf",
        "oneOf",
        "properties",
        "required",
        "propertyOrdering",
    }
)


#: Map keys whose CHILD KEYS are names, not schema keywords (`properties` maps
#: field names to schemas; `$defs` maps definition names to schemas). Their
#: children are sanitized as schemas but the names themselves are preserved.
_STRUCT_MAP_KEYS = frozenset({"properties", "$defs"})


def _sanitize_json_schema(node: Any) -> Any:
    """Recursively drop wire-unsupported keys from a JSON Schema dict.

    Pure function over plain dicts/lists — the internal Pydantic models are
    never touched.
    """
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in _STRUCT_MAP_KEYS and isinstance(value, dict):
                out[key] = {
                    name: _sanitize_json_schema(sub) for name, sub in value.items()
                }
            elif key in _GEMINI_WIRE_ALLOWED_KEYS:
                out[key] = _sanitize_json_schema(value)
        return out
    if isinstance(node, list):
        return [_sanitize_json_schema(value) for value in node]
    return node


def build_gemini_json_schema() -> dict[str, Any]:
    """Wire schema for `response_json_schema`: strict `PlanResult` minus keys the
    Gemini API rejects. Local `PlanResult` revalidation after the call keeps the
    CONTROL_n / extra="forbid" / action-field guarantees intact."""
    return _sanitize_json_schema(PlanResult.model_json_schema())  # type: ignore[return-value]
# Request timeout: milliseconds for the SDK `HttpOptions`, seconds for us.
# Gemini answers faster than a local model (Ollama allows 90s); a hung call
# must fail closed quickly so it can never block a demo or a worker.
GEMINI_TIMEOUT_MS = 30_000


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str | None, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def plan(self, request: PlanRequest) -> PlanResponse:
        # Missing key is surfaced on the planning path only (never on /health).
        if not self.api_key:
            raise HTTPException(
                status_code=502,
                detail={"error": "llm_unavailable", "message": "GEMINI_API_KEY not configured"},
            )

        # Imported here so the module is importable (and the deterministic default
        # keeps working) even when the Google SDK is absent.
        from google import genai  # type: ignore[import-not-found]
        from google.genai import types  # type: ignore[import-not-found]

        # `http_options` accepts a plain dict; `timeout` is milliseconds.
        client = genai.Client(api_key=self.api_key, http_options={"timeout": GEMINI_TIMEOUT_MS})

        payload = {
            "taskObjective": request.taskObjective,
            "sanitizedVisibleText": request.sanitizedVisibleText,
            "sanitizedPageStructure": [node.model_dump() for node in request.sanitizedPageStructure],
            "aliases": [binding.model_dump() for binding in request.aliases],
            "availableActions": request.availableActions,
        }
        if request.lastExecutedAction is not None:
            payload["lastExecutedAction"] = request.lastExecutedAction.model_dump()

        try:
            response = client.models.generate_content(
                model=self.model,
                contents=json.dumps(payload),
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    # Sanitized wire schema (see module docstring): never the raw
                    # Pydantic class — its additionalProperties/pattern keys 400
                    # on newer models.
                    response_json_schema=build_gemini_json_schema(),
                    system_instruction=SYSTEM_INSTRUCTION,
                ),
            )
        except (TimeoutError, httpx.TimeoutException) as error:
            # Distinct from generic outages: callers (and demos) can tell a slow
            # model apart from a down one. Propagates untouched through main.py.
            raise HTTPException(
                status_code=502,
                detail={"error": "llm_timeout", "message": "Gemini did not respond in 30s"},
            ) from error
        except Exception:
            raise GeminiUnavailableError() from None

        # With `response_json_schema` the SDK does not auto-parse into our model,
        # so the raw JSON text is revalidated through the STRICT internal
        # `PlanResult` (extra="forbid", CONTROL_n pattern, action validators).
        # A pre-parsed `PlanResult` (older SDK path / tests) is accepted as-is.
        # Anything else malformed fails closed — never a default action.
        parsed = response.parsed if response is not None else None
        if not isinstance(parsed, PlanResult):
            text = getattr(response, "text", None)
            if not isinstance(text, str) or not text.strip():
                raise GeminiUnavailableError()
            try:
                parsed = PlanResult.model_validate_json(text)
            except Exception:
                raise GeminiUnavailableError() from None

        # POST-SCAN: the model's own output must never carry raw PII.
        post_scan(parsed)
        return to_plan_response(parsed, request.availableActions)


def create_gemini_provider() -> GeminiProvider:
    return GeminiProvider(
        api_key=os.environ.get("GEMINI_API_KEY"),
        model=os.environ.get("GEMINI_MODEL", DEFAULT_MODEL),
    )
