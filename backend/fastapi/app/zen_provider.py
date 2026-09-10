"""OpenCode Zen provider (GPT-5.6 Luna) for the `AGENT_PROVIDER` seam.

Plans the next structured action through the Zen Responses API
(`POST https://opencode.ai/zen/v1/responses`) with a discriminated JSON-schema
response format, so the model returns valid JSON without markdown wrapping.

WIRE vs INTERNAL schema: the strict internal `PlanResult`/`PlannedAction` models
(`llm_common.py`, `extra="forbid"` + CONTROL_n pattern + action validators) are
UNCHANGED and remain the security boundary. The wire schema sent upstream is a
generation constraint only (per-action branches carrying just their relevant
fields); it cannot enforce CONTROL_n patterns or required-field rules on every
gateway, so the raw model text is ALWAYS revalidated through the strict
internal `PlanResult` before `post_scan`/`to_plan_response`. The wire is
permissive; the local revalidation is strict — fail closed on anything
malformed. Malformed output is never repaired into an executable action.

PRIVACY (CONTRIBUTING.md §5): the request is ALREADY sanitized by the extension —
this provider sends the SAME sanitized fields as the Gemini provider (task,
visible text, page structure, aliases, available actions, last-executed-action
metadata) and nothing else: never a screenshot, image/base64 payload, raw OCR
value, raw PII, CSS selector, or alias→value mapping. It adds a POST-SCAN on
the model's own output and FAILS CLOSED. Shared system-instruction/post-scan
live in `llm_common.py` so all remote providers behave identically.

The API key lives ONLY in the backend environment (`OPENCODE_ZEN_API_KEY`);
it is never logged, never echoed in errors, and never leaves this process
except as the upstream Authorization header.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import HTTPException

from .agent import PlanRequest, PlanResponse
from .llm_common import (
    LLMUnavailableError,
    PlanResult,
    SYSTEM_INSTRUCTION,
    post_scan,
    to_plan_response,
)

ZEN_ENDPOINT = "https://opencode.ai/zen/v1/responses"

DEFAULT_MODEL = "gpt-5.6-luna"

# Zen answers over the network like Gemini (Ollama allows 90s for local
# inference); a hung call must fail closed quickly so it can never block a
# demo or a worker. Slightly more headroom than Gemini's 30s.
TIMEOUT_SECONDS = 35.0


def _targeted_branch(action_type: str, extra: dict[str, Any]) -> dict[str, Any]:
    """One discriminated branch: the action type plus ONLY its relevant fields."""
    properties: dict[str, Any] = {
        "type": {"type": "string", "enum": [action_type]},
        "controlId": {"type": "string"},
    }
    properties.update(extra)
    return {
        "type": "object",
        "properties": properties,
        "required": ["type", "controlId", *extra.keys()],
        "additionalProperties": False,
    }


def build_zen_json_schema() -> dict[str, Any]:
    """Discriminated wire schema for the Responses `text.format` constraint.

    CLICK → type + controlId; TYPE/SELECT → + value; SCROLL → type + direction;
    NAVIGATE → type + url; plus `null` for the done case. Every branch forbids
    extra properties. CONTROL_n shape and required-field rules are enforced
    locally by `PlanResult` after the call — never trusted from the wire.
    """
    return {
        "type": "object",
        "properties": {
            "action": {
                "anyOf": [
                    _targeted_branch("CLICK", {}),
                    _targeted_branch("TYPE", {"value": {"type": "string"}}),
                    _targeted_branch("SELECT", {"value": {"type": "string"}}),
                    {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string", "enum": ["SCROLL"]},
                            "direction": {"type": "string", "enum": ["up", "down"]},
                        },
                        "required": ["type", "direction"],
                        "additionalProperties": False,
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string", "enum": ["NAVIGATE"]},
                            "url": {"type": "string"},
                        },
                        "required": ["type", "url"],
                        "additionalProperties": False,
                    },
                    {"type": "null"},
                ]
            },
            "done": {"type": "boolean"},
            "reason": {"type": "string"},
        },
        "required": ["action", "done", "reason"],
        "additionalProperties": False,
    }


def _extract_output_text(body: Any) -> str | None:
    """Pull the model's JSON text out of a Responses envelope, robustly.

    Prefers the top-level `output_text` shortcut; otherwise walks
    `output[*].content[*]` for `type == "output_text"` blocks. Returns None
    when no usable text exists — the caller fails closed.
    """
    if not isinstance(body, dict):
        return None
    shortcut = body.get("output_text")
    if isinstance(shortcut, str) and shortcut.strip():
        return shortcut
    output = body.get("output")
    if not isinstance(output, list):
        return None
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "output_text":
                continue
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                return text
    return None


class ZenProvider:
    name = "zen"

    def __init__(self, api_key: str | None, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def plan(self, request: PlanRequest) -> PlanResponse:
        # Missing key is surfaced on the planning path only (never on /health).
        if not self.api_key:
            raise HTTPException(
                status_code=502,
                detail={"error": "llm_unavailable", "message": "OPENCODE_ZEN_API_KEY not configured"},
            )

        # SAME sanitized fields as the Gemini provider — nothing raw ever crosses.
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
            response = httpx.post(
                ZEN_ENDPOINT,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "instructions": SYSTEM_INSTRUCTION,
                    "input": json.dumps(payload),
                    "text": {
                        "format": {
                            "type": "json_schema",
                            "name": "privagent_plan",
                            "strict": True,
                            "schema": build_zen_json_schema(),
                        }
                    },
                },
                timeout=TIMEOUT_SECONDS,
            )
        except httpx.TimeoutException as error:
            # Distinct from generic outages: callers (and demos) can tell a slow
            # model apart from a down one. Propagates untouched through main.py.
            raise HTTPException(
                status_code=502,
                detail={"error": "llm_timeout", "message": "Zen did not respond in 35s"},
            ) from error
        except httpx.HTTPError:
            raise LLMUnavailableError() from None

        # Any non-200 (401/403 auth, 429 quota, 5xx) fails closed WITHOUT echoing
        # the upstream body — it can carry sensitive diagnostics.
        if response.status_code != 200:
            raise LLMUnavailableError()
        try:
            body = response.json()
        except ValueError:
            raise LLMUnavailableError() from None

        text = _extract_output_text(body)
        if text is None:
            raise LLMUnavailableError()
        try:
            parsed = PlanResult.model_validate_json(text)
        except Exception:
            raise LLMUnavailableError() from None

        # POST-SCAN: the model's own output must never carry raw PII.
        # LLMPIILeakError propagates to main.py's 502 handler untouched.
        post_scan(parsed)
        return to_plan_response(parsed, request.availableActions)


def create_zen_provider() -> ZenProvider:
    return ZenProvider(
        api_key=os.environ.get("OPENCODE_ZEN_API_KEY"),
        model=os.environ.get("OPENCODE_ZEN_MODEL", DEFAULT_MODEL),
    )
