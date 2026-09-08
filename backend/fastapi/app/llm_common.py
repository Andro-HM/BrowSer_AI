"""Shared LLM planner contracts for the `AGENT_PROVIDER` seam.

Both the Gemini (cloud) and Ollama (local) providers plan from the SAME sanitized
payload through the SAME schema, system instruction, post-scan and fail-closed error
classes — so a provider swap never changes the extension's contract or the privacy
guarantees (CONTRIBUTING.md §5 Rule 2).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from .agent import (
    ClickAction,
    NavigateAction,
    PlanAction,
    PlanResponse,
    ScrollAction,
    SelectAction,
    TypeAction,
)
from .pii_scan import scan_pii

SCROLL_AMOUNT = 720.0


class PlannedAction(BaseModel):
    type: Literal["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"]
    selector: str | None = None  # required for CLICK, TYPE, SELECT
    value: str | None = None  # required for TYPE, SELECT (alias or benign text only)
    direction: Literal["up", "down"] | None = None  # required for SCROLL
    url: str | None = None  # required for NAVIGATE


class PlanResult(BaseModel):
    action: PlannedAction | None = None
    done: bool
    reason: str


SYSTEM_INSTRUCTION = (
    "You are a privacy-preserving browser agent. You receive only sanitized DOM "
    "structure, visible text, and semantic aliases (e.g. USER_EMAIL_1, USER_PHONE_1, "
    "USER_PAYMENT_1, USER_NAME_1).\n"
    "Rules:\n"
    "- NEVER invent or output real personal information.\n"
    "- Use ONLY the provided aliases when filling sensitive fields.\n"
    "- Action types MUST BE EXACTLY ONE OF: CLICK, TYPE, SELECT, SCROLL, NAVIGATE.\n"
    "- If the task is completed, return action: null and done: true.\n"
    "- If no safe action can be determined, return action: null and done: true."
)


class LLMUnavailableError(Exception):
    """The model provider failed (rate limit, network, auth) — fail closed upstream."""


class LLMPIILeakError(Exception):
    """The model returned detectable raw PII — fail closed upstream."""


def to_plan_action(action: PlannedAction) -> PlanAction:
    kind = action.type
    if kind == "CLICK":
        return ClickAction(action="CLICK", target=action.selector or "")
    if kind == "TYPE":
        return TypeAction(action="TYPE", target=action.selector or "", value=action.value or "")
    if kind == "SELECT":
        return SelectAction(action="SELECT", target=action.selector or "", value=action.value or "")
    if kind == "SCROLL":
        amount = SCROLL_AMOUNT if action.direction == "down" else -SCROLL_AMOUNT
        return ScrollAction(action="SCROLL", amount=amount)
    return NavigateAction(action="NAVIGATE", url=action.url or "")


def post_scan(result: PlanResult) -> None:
    """Scan the model's own output for raw PII; raise `LLMPIILeakError` on a leak.

    Covers every model-controlled string that reaches the response: `reason`,
    `value` (TYPE/SELECT payload), `selector` (CSS selectors can embed raw
    values), and `url` (NAVIGATE targets can carry query-string PII).
    """
    action = result.action
    leaked = scan_pii(
        result.reason,
        action.value if action else None,
        action.selector if action else None,
        action.url if action else None,
    )
    if leaked:
        raise LLMPIILeakError()


def to_plan_response(result: PlanResult) -> PlanResponse:
    if result.done or result.action is None:
        return PlanResponse(actions=[])
    return PlanResponse(actions=[to_plan_action(result.action)])