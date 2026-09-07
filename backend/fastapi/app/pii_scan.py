"""Defense-in-depth content scan shared by the plan endpoint (inbound) and the Gemini
provider (outbound).

The extension sanitizes everything BEFORE it leaves the device and its firewall is the
single egress gate; this module is the backend's own MIRROR of that gate, so a raw value
that somehow slips through is still refused at the remote boundary (CONTRIBUTING.md §5
Rule 2). Aliases (`USER_EMAIL_1`) are shaped so they cannot match any pattern here.

This is deliberately NOT a second privacy policy. It makes no decisions: no categories
are ranked, no severity is assigned, no aliases are allocated, nothing is redacted or
rewritten. All of that lives once, in the extension (M4/M5/M6). Here there are only two
boolean refusals — "this still looks raw" and "this still looks like pixels" — which is
what defense in depth at a trust boundary means.

The two checks are separate because the failure modes are unrelated: PII is a pattern in
text, whereas an encoded capture is a blob with no pattern at all, so `scan_pii` cannot
see one. Both mirror `extension/src/firewall/inspect.ts`.
"""

import re

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
#: A labelled credential — `password: …`, `api_key = …`, `Bearer …`. Character-for-character
#: the extension's `CREDENTIAL_REGEX` (`extension/src/perception/pii/index.ts`), because a
#: mirror that recognized a DIFFERENT set of patterns would not be one: the extension
#: firewall blocks this shape (`FIREWALL_PII_DETECTED`), so the remote boundary must too or
#: a stale client's labelled password would be refused locally and accepted here.
CREDENTIAL_RE = re.compile(
    r"(?:api[_-]?key|secret|token|password|bearer|auth|access[_-]?token)"
    r"\s*[:=]\s*[\"']?[A-Za-z0-9\-_.~+/]{8,}[\"']?",
    re.I,
)

#: An inline media payload — the shape a `captureVisibleTab` result actually has.
MEDIA_DATA_URL_RE = re.compile(r"data:(?:image|video|audio)/", re.I)
#: An unbroken base64-ish run long enough to be a payload rather than a word. Kept at the
#: same 256-char threshold as the extension firewall so the two gates agree: ordinary
#: prose, selectors and labels never produce such a run, so talking ABOUT base64 is not
#: mistaken for shipping pixels.
BASE64_RUN_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")


def _luhn_valid(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 13 or len(digits) > 19:
        return False
    total = 0
    double = False
    for char in reversed(digits):
        digit = int(char)
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double
    return total % 10 == 0


def scan_pii(*texts: str | None) -> list[str]:
    """Return the CATEGORY names of PII found across `texts` (empty when none).

    Categories, never the matched values. A raw value returned from here would be one
    `HTTPException(detail=...)` or one f-string away from being echoed back over the wire
    or into a server log — the exact leak this module exists to stop. Callers need only
    "was anything found, and of what kind", so that is all they get.

    `None` is accepted so callers can pass optional fields (e.g. an action's `value`)
    without pre-filtering.
    """
    found: list[str] = []
    for text in texts:
        if not text:
            continue
        if EMAIL_RE.search(text):
            found.append("EMAIL")
        if PHONE_RE.search(text):
            found.append("PHONE")
        if any(_luhn_valid(match) for match in CARD_RE.findall(text)):
            found.append("PAYMENT")
        if CREDENTIAL_RE.search(text):
            found.append("CREDENTIAL")
    return found


def contains_pixel_payload(*texts: str | None) -> bool:
    """True when any text carries encoded image/video/audio bytes.

    Checked independently of `scan_pii`: base64 matches no PII pattern, so a viewport
    capture pasted into a legal text field would otherwise be pattern-clean and ride
    straight into the model prompt. Raw pixels crossing the boundary is the one thing
    the local visual pipeline exists to prevent.
    """
    return any(
        text and (MEDIA_DATA_URL_RE.search(text) or BASE64_RUN_RE.search(text))
        for text in texts
    )
