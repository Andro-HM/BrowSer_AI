"""PrivAgent backend (blueprint §13).

Exposes the planning service (`/v1/plan`, alias `/v1/act`) and a health check. This
service must NEVER receive raw protected values or alias->value mappings
(CONTRIBUTING.md §5 Rule 2). The endpoint enforces that with a PRE-SCAN on the
inbound payload, and the provider layer (Gemini) enforces a POST-SCAN on model output.

Refusals are also part of the boundary: no error path here may quote the value it
rejected, so both the hand-written scans and the schema-validation handler below report
only what failed and where.
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .agent import PlanRequest, plan_actions
from .gemini_provider import GeminiPIILeakError, GeminiUnavailableError
from .pii_scan import contains_pixel_payload, scan_pii

app = FastAPI(title="PrivAgent Backend", version="0.0.0")


@app.exception_handler(RequestValidationError)
def validation_error_handler(_request: Request, error: RequestValidationError) -> JSONResponse:
    """Report WHERE a request was invalid, never WHAT the offending value was.

    FastAPI's default handler echoes each rejected value back in `input` (and sometimes
    in `ctx`). For this service that turns the refusal into the leak: rejecting a
    smuggled `screenshot` field would return the whole base64 capture in the 422 body,
    and rejecting a value-shaped alias would return the raw value — both then landing in
    whatever access log or error tracker records response bodies.

    `type`, `loc` and `msg` are kept, so a client still learns exactly which field failed
    and why ("extra_forbidden at body.screenshot"); only the payload is dropped.
    """
    safe = [
        {"type": item.get("type"), "loc": item.get("loc"), "msg": item.get("msg")}
        for item in error.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": safe})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "privagent-backend", "milestone": "M0"}


def _text_bearing(request: PlanRequest) -> list[str | None]:
    """Every string in the request that could carry page-derived content.

    Scoped to what a provider actually SEES: the objective, the visible text, and each
    node's `label`/`name` — all of which the Gemini provider serializes into the prompt.
    Scanning only the two top-level strings would leave the per-node text unchecked,
    which is precisely where a raw value would hide. Mirrors `textBearingStrings` in
    `extension/src/firewall/inspect.ts` so the two gates cover the same surface.
    """
    texts: list[str | None] = [request.taskObjective, request.sanitizedVisibleText]
    for node in request.sanitizedPageStructure:
        texts.append(node.label)
        texts.append(node.name)
    return texts


@app.post("/v1/plan")
def plan(request: PlanRequest) -> dict:
    """Plan the next structured action(s) from an ALREADY-SANITIZED request.

    PRIVACY (CONTRIBUTING.md §5 Rule 2): the extension sanitizes the payload before it
    leaves the device; this endpoint mirrors the detection patterns as defense in depth
    and rejects any raw email/phone/card — or any encoded capture — that still shows up.
    """
    # PRE-SCAN (inbound): raw PII must never reach ANY provider.
    texts = _text_bearing(request)
    if scan_pii(*texts):
        raise HTTPException(status_code=422, detail="Raw PII detected in outbound request")

    # Separate check: an encoded capture matches no PII pattern, so the scan above cannot
    # see it. Without this, base64 pixels in a legal text field reach the model prompt.
    if contains_pixel_payload(*texts):
        raise HTTPException(status_code=422, detail="Encoded media detected in outbound request")

    try:
        return plan_actions(request)
    except GeminiUnavailableError as error:
        raise HTTPException(status_code=502, detail="llm_unavailable") from error
    except GeminiPIILeakError as error:
        raise HTTPException(status_code=502, detail="PII leak detected in LLM response") from error
    except NotImplementedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error


@app.post("/v1/act")
def act(request: PlanRequest) -> dict:
    """Alias of `/v1/plan` (same contract, same planner, same guarantees)."""
    return plan(request)