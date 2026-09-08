"""PrivAgent backend (blueprint §13).

Exposes the planning service (`/v1/plan`, alias `/v1/act`) and a health check. This
service must NEVER receive raw protected values or alias->value mappings
(CONTRIBUTING.md §5 Rule 2). The endpoint enforces that with a PRE-SCAN on the
inbound payload, and the provider layer (Gemini) enforces a POST-SCAN on model output.
"""

from fastapi import FastAPI, HTTPException

from .agent import PlanRequest, plan_actions
from .llm_common import LLMPIILeakError, LLMUnavailableError
from .pii_scan import scan_pii

app = FastAPI(title="PrivAgent Backend", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "privagent-backend", "milestone": "M0"}


@app.post("/v1/plan")
def plan(request: PlanRequest) -> dict:
    """Plan the next structured action(s) from an ALREADY-SANITIZED request.

    PRIVACY (CONTRIBUTING.md §5 Rule 2): the extension sanitizes the payload before it
    leaves the device; this endpoint mirrors the detection patterns as defense in depth
    and rejects any raw email/phone/card that still shows up.
    """
    # PRE-SCAN (inbound): raw PII must never reach ANY provider.
    # Covers the top-level text plus every free-text struct field that can carry
    # a raw value past the sanitizer: alias bindings and all node strings
    # (selector/label/name). NOTE: PlanRequest has no `pageContext`/`reason`
    # fields — the LLM result `reason` is covered by the provider POST-SCAN.
    struct_texts: list[str] = []
    for binding in request.aliases:
        struct_texts.append(binding.alias)
        struct_texts.append(binding.category)
    for node in request.sanitizedPageStructure:
        struct_texts.append(node.selector)
        if node.label is not None:
            struct_texts.append(node.label)
        if node.name is not None:
            struct_texts.append(node.name)
    if scan_pii(request.taskObjective, request.sanitizedVisibleText, *struct_texts):
        raise HTTPException(status_code=422, detail="Raw PII detected in outbound request")

    # PRIVACY-MODE gate (fail closed): only "strict" is implemented anywhere
    # (backend, extension loop, firewall, all tests). Anything else cannot be
    # honoured, so the request is rejected rather than served half-privately.
    if request.policy.privacyMode != "strict":
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_privacy_mode", "allowed": ["strict"]},
        )

    try:
        return plan_actions(request)
    except LLMUnavailableError as error:
        raise HTTPException(status_code=502, detail="llm_unavailable") from error
    except LLMPIILeakError as error:
        raise HTTPException(status_code=502, detail="PII leak detected in LLM response") from error
    except NotImplementedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error


@app.post("/v1/act")
def act(request: PlanRequest) -> dict:
    """Alias of `/v1/plan` (same contract, same planner, same guarantees)."""
    return plan(request)