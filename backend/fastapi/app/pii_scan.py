"""Defense-in-depth PII scan shared by the plan endpoint (inbound) and the Gemini
provider (outbound).

The extension sanitizes everything BEFORE it leaves the device; this is the backend's
own mirror of those patterns so a raw value that slips through is still caught at the
remote boundary (CONTRIBUTING.md §5 Rule 2). Aliases (`USER_EMAIL_1`) are shaped so
they cannot match any pattern here.
"""

import re

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
# Indian PII mirrors of the extension detectors (SIH 2026): Aadhaar (UIDAI first
# digit 2-9, 4-4-4 groups; lookarounds keep card prefixes from misfiring), PAN
# (5 letters + 4 digits + 1 letter), UPI VPA (gated on known handles/context and
# never inside a real email address). Existing patterns above are untouched.
AADHAAR_RE = re.compile(r"(?<!\d)(?<![\d][\s-])[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}(?![\s-]?\d)")
PAN_RE = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
UPI_RE = re.compile(r"\b[\w.\-]{2,256}@[a-zA-Z]{2,64}\b")
UPI_HANDLES = frozenset(
    {
        "okicici",
        "oksbi",
        "okaxis",
        "okhdfc",
        "ybl",
        "ibl",
        "upi",
        "paytm",
        "gpay",
        "phonepe",
    }
)
UPI_CONTEXT_RE = re.compile(r"(upi|vpa|\bpay\b)", re.IGNORECASE)
MEDIA_DATA_RE = re.compile(r"data:(?:image|video|audio)/", re.IGNORECASE)
BASE64_RUN_RE = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")


def contains_pixel_payload(*texts: str | None) -> bool:
    """Reject inline media/encoded captures independently of PII pattern matching."""
    return any(text is not None and (MEDIA_DATA_RE.search(text) or BASE64_RUN_RE.search(text)) for text in texts)


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


def _upi_hits(text: str) -> list[str]:
    """UPI VPAs: known-handle or UPI-context matches, never inside an email."""
    email_spans = [(m.start(), m.end()) for m in EMAIL_RE.finditer(text)]
    hits: list[str] = []
    for match in UPI_RE.finditer(text):
        start, end = match.start(), match.end()
        if end < len(text) and text[end] == ".":
            continue
        if any(start < span_end and end > span_start for span_start, span_end in email_spans):
            continue
        domain = (match.group(0).split("@", 1)[1] if "@" in match.group(0) else "").lower()
        if domain in UPI_HANDLES or UPI_CONTEXT_RE.search(text[max(0, start - 24) : start]):
            hits.append(match.group(0))
    return hits


def scan_pii(*texts: str) -> list[str]:
    """Return the raw PII values found across `texts` (empty when none)."""
    hits: list[str] = []
    for text in texts:
        if not text:
            continue
        hits.extend(EMAIL_RE.findall(text))
        hits.extend(PHONE_RE.findall(text))
        for match in CARD_RE.findall(text):
            if _luhn_valid(match):
                hits.append(match)
        hits.extend(AADHAAR_RE.findall(text))
        hits.extend(PAN_RE.findall(text))
        hits.extend(_upi_hits(text))
    return hits
