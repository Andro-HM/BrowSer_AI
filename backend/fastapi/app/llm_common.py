"""Shared LLM planner contracts for the `AGENT_PROVIDER` seam.

Both the Gemini (cloud) and Ollama (local) providers plan from the SAME sanitized
payload through the SAME schema, system instruction, post-scan and fail-closed error
classes — so a provider swap never changes the extension's contract or the privacy
guarantees (CONTRIBUTING.md §5 Rule 2).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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

#: Full action vocabulary. Used as the allow-all default when a request leaves
#: `availableActions` empty — the field only ever narrows this set, never widens it.
ALL_ACTION_TYPES = ("CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE")


class PlannedAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"]
    controlId: str | None = Field(default=None, pattern=r"^CONTROL_[1-9]\d*$", max_length=64)
    value: str | None = None  # required for TYPE, SELECT (alias or benign text only)
    direction: Literal["up", "down"] | None = None  # required for SCROLL
    url: str | None = None  # required for NAVIGATE

    @model_validator(mode="after")
    def require_action_fields(self) -> "PlannedAction":
        if self.type in ("CLICK", "TYPE", "SELECT") and self.controlId is None:
            raise ValueError("controlId is required for targeted actions")
        if self.type in ("TYPE", "SELECT") and not self.value:
            raise ValueError("value is required for TYPE and SELECT")
        if self.type == "SCROLL" and self.direction is None:
            raise ValueError("direction is required for SCROLL")
        if self.type == "NAVIGATE" and not self.url:
            raise ValueError("url is required for NAVIGATE")
        return self


class PlanResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
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
    "- You also receive lastExecutedAction: the immediately previous successfully "
    "executed action (or null on the first step). Reason from the CURRENT sanitized "
    "page state plus that history.\n"
    "- If lastExecutedAction shows the requested operation already succeeded and the "
    "current sanitized state is consistent with completion, return action: null and "
    "done: true.\n"
    "- NEVER blindly repeat the action in lastExecutedAction: propose the same "
    "non-scroll action twice in a row only when the current state still clearly "
    "requires it.\n"
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
        return ClickAction(action="CLICK", target=action.controlId or "")
    if kind == "TYPE":
        return TypeAction(action="TYPE", target=action.controlId or "", value=action.value or "")
    if kind == "SELECT":
        return SelectAction(action="SELECT", target=action.controlId or "", value=action.value or "")
    if kind == "SCROLL":
        amount = SCROLL_AMOUNT if action.direction == "down" else -SCROLL_AMOUNT
        return ScrollAction(action="SCROLL", amount=amount)
    return NavigateAction(action="NAVIGATE", url=action.url or "")


def post_scan(result: PlanResult) -> None:
    """Scan the model's own output for raw PII; raise `LLMPIILeakError` on a leak.

    Covers every model-controlled string that reaches the response: `reason`,
    `value` (TYPE/SELECT payload), `controlId`, and `url` (NAVIGATE targets can
    carry query-string PII).
    """
    action = result.action
    leaked = scan_pii(
        result.reason,
        action.value if action else None,
        action.controlId if action else None,
        action.url if action else None,
    )
    if leaked:
        raise LLMPIILeakError()


def to_plan_response(
    result: PlanResult, available_actions: list[str] | None = None
) -> PlanResponse:
    """Convert a model result, dropping actions outside `available_actions`.

    An empty/missing allowlist means allow-all (the field only narrows). A
    filtered-out action yields an empty action list — `PlanResponse` carries no
    reason field, so nothing further is reported.
    """
    if result.done or result.action is None:
        return PlanResponse(actions=[])
    action = to_plan_action(result.action)
    allowed = available_actions if available_actions else list(ALL_ACTION_TYPES)
    if action.action not in allowed:
        return PlanResponse(actions=[])
    return PlanResponse(actions=[action])
