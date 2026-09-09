// M6/M7 seam — privacy firewall (blueprint §7, CONTRIBUTING.md §5).
//
// The SINGLE outbound boundary. Every `RemoteAgentRequest` passes `inspect()` before
// any transmission, and the verdict FAILS CLOSED: if safety cannot be established the
// request is blocked, never "probably fine".
//
// What the firewall can honestly establish (and how):
//   1. STRUCTURE — the payload is exactly a `RemoteAgentRequest`: every expected key,
//      correctly typed, and NO extra keys (a compromised/malicious planner cannot
//      smuggle payload through unspecified fields). This includes the M6 task privacy
//      contract: `privacyMode` must name a regime the implementation actually defines,
//      and the navigation allowlist must be a plain string array.
//   2. ALIAS SHAPE — every alias matches the semantic `USER_<CATEGORY>_<n>` grammar;
//      an alias field is a type, never a value.
//   3. CONTENT SCAN — the same local PII detector used on-page (M2 `detectPII`) runs
//      over every text-bearing string in the payload. One hit ⇒ BLOCK: if the payload
//      still contains a detectable email/phone/card/credential pattern, it is not clean.
//   4. PIXEL PAYLOAD — no text-bearing string may carry an encoded image. This is a
//      SEPARATE check because the content scan cannot do it: base64 matches no PII
//      pattern, so a viewport capture pasted into `sanitizedVisibleText` would otherwise
//      be structurally valid and pattern-clean, and would ride out through a legal field.
//      Raw pixels crossing the boundary is the one thing M3 exists to prevent.
//
// What the firewall deliberately does NOT claim: it cannot prove the absence of raw
// values the detector does not recognize (e.g. free-text names). That residual risk is
// bounded upstream — `EnforcementResult` only emits `sanitizedText` when the page was
// fully enforced — and documented honestly (CONTRIBUTING.md §22: no fabricated guarantees).
//
// This module performs no logging and no network I/O.

import type { RemoteAgentRequest } from '../types/contracts';
import { ALLOWED_ACTION_KINDS } from '../actions/kinds';
import { isPrivacyMode } from '../policy/modes';
import { detectPII } from '../perception/pii';
import { isControlHandle } from '../content/controls';

export interface FirewallVerdict {
  allowed: boolean;
  reason: string;
}

export interface PrivacyFirewall {
  inspect(request: RemoteAgentRequest): Promise<FirewallVerdict>;
}

const MAX_TASK_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_NODES = 500;
const MAX_ALIASES = 100;
const ALIAS_PATTERN = /^USER_[A-Z]+_\d+$/;

const REQUEST_KEYS = new Set([
  'taskObjective',
  'pageOrigin',
  'sanitizedPageStructure',
  'sanitizedVisibleText',
  'aliases',
  'availableActions',
  'policy',
]);

function deny(reason: string): FirewallVerdict {
  return { allowed: false, reason };
}

function allow(): FirewallVerdict {
  return { allowed: true, reason: 'OK' };
}

/** Structural check on one sanitized node — mirrors the `SanitizedNode` contract. */
function isValidNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;
  if (!['input', 'textarea', 'select', 'button'].includes(n['tag'] as string)) return false;
  if (!isControlHandle(n['control'])) return false;
  if (typeof n['filled'] !== 'boolean' || typeof n['disabled'] !== 'boolean') return false;
  for (const optional of ['inputType', 'label']) {
    const value = n[optional];
    if (value !== undefined && typeof value !== 'string') return false;
  }
  if (n['belowFold'] !== undefined && typeof n['belowFold'] !== 'boolean') return false;
  for (const key of Object.keys(n)) {
    if (!['tag', 'control', 'inputType', 'label', 'filled', 'disabled', 'belowFold'].includes(key)) {
      return false;
    }
  }
  return true;
}

/**
 * Structural check on the task privacy contract — mirrors `TaskPrivacyContract`.
 * `privacyMode` must be a mode the implementation actually DEFINES (not merely a string):
 * an unknown regime cannot be honoured, so it is refused rather than passed through. The
 * allowlist must be a string array (its entries are separately re-validated per NAVIGATE
 * action by `validateActionPolicy`), and no extra key may ride along.
 */
function isValidContract(policy: unknown): boolean {
  if (typeof policy !== 'object' || policy === null) return false;
  const p = policy as Record<string, unknown>;
  if (!isPrivacyMode(p['privacyMode'])) return false;
  const allowlist = p['navigationAllowlist'];
  if (!Array.isArray(allowlist) || !allowlist.every((entry) => typeof entry === 'string')) {
    return false;
  }
  return Object.keys(p).every((key) => key === 'privacyMode' || key === 'navigationAllowlist');
}

/**
 * The one content gate: every string that could carry page-derived text is scanned by
 * the same detector M2 uses on-page. Aliases (`USER_EMAIL_1`) are deliberately shaped
 * so they cannot match any detector pattern.
 */
function payloadContainsDetectablePII(request: RemoteAgentRequest): boolean {
  return textBearingStrings(request).some((text) => detectPII(text).length > 0);
}

/** Every string in the payload that could plausibly carry page-derived content. */
function textBearingStrings(request: RemoteAgentRequest): string[] {
  const texts: string[] = [request.sanitizedVisibleText, request.taskObjective];
  for (const node of request.sanitizedPageStructure) {
    if (node.label !== undefined) texts.push(node.label);
  }
  return texts;
}

/** A `data:` URL for image/video/audio content — i.e. an inline media payload. */
const MEDIA_DATA_URL = /data:(?:image|video|audio)\//i;
/**
 * An unbroken base64-ish run long enough to be a payload rather than a word. A real
 * capture is tens of thousands of characters; ordinary prose, selectors, labels and
 * aliases never produce a 256-character run without a space or punctuation break. The
 * threshold is deliberately well clear of both, so the check does not degenerate into a
 * second, sloppier PII filter that trips on the WORD "base64".
 */
const BASE64_RUN = /[A-Za-z0-9+/]{256,}={0,2}/;

/**
 * True when a string carries encoded pixels. Checked independently of the PII scan
 * because the two failure modes are unrelated: PII is a pattern in text, a capture is a
 * blob with no pattern at all.
 */
function containsPixelPayload(request: RemoteAgentRequest): boolean {
  return textBearingStrings(request).some(
    (text) => MEDIA_DATA_URL.test(text) || BASE64_RUN.test(text),
  );
}

export function createPrivacyFirewall(): PrivacyFirewall {
  return {
    inspect(request: RemoteAgentRequest): Promise<FirewallVerdict> {
      if (typeof request !== 'object' || request === null) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }

      // 1 — exact shape: every expected key present, nothing extra (fail closed).
      for (const key of Object.keys(request)) {
        if (!REQUEST_KEYS.has(key)) return Promise.resolve(deny('FIREWALL_UNEXPECTED_FIELD'));
      }

      const r = request as unknown as Record<string, unknown>;
      // `pageOrigin` is OPTIONAL (origin-only when present); every other key is required.
      const required = [...REQUEST_KEYS].filter((key) => key !== 'pageOrigin');
      const missing = required.filter((key) => !(key in r));
      if (missing.length > 0) return Promise.resolve(deny('FIREWALL_MALFORMED'));

      if (typeof r['taskObjective'] !== 'string' || (r['taskObjective'] as string).length > MAX_TASK_LENGTH) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }
      if (typeof r['sanitizedVisibleText'] !== 'string' || (r['sanitizedVisibleText'] as string).length > MAX_TEXT_LENGTH) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }

      const nodes = r['sanitizedPageStructure'];
      if (!Array.isArray(nodes) || nodes.length > MAX_NODES || !nodes.every(isValidNode)) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }

      const aliases = r['aliases'];
      if (
        !Array.isArray(aliases) ||
        aliases.length > MAX_ALIASES ||
        !aliases.every(
          (a) =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as Record<string, unknown>)['alias'] === 'string' &&
            ALIAS_PATTERN.test((a as Record<string, unknown>)['alias'] as string) &&
            typeof (a as Record<string, unknown>)['category'] === 'string',
        )
      ) {
        return Promise.resolve(deny('FIREWALL_BAD_ALIAS'));
      }

      const availableActions = r['availableActions'];
      if (
        !Array.isArray(availableActions) ||
        !availableActions.every((kind) => (ALLOWED_ACTION_KINDS as readonly string[]).includes(kind as string))
      ) {
        return Promise.resolve(deny('FIREWALL_BAD_ACTIONS'));
      }

      // pageOrigin: origin-only string (never a full URL) — validated as such.
      if (r['pageOrigin'] !== undefined) {
        if (typeof r['pageOrigin'] !== 'string') return Promise.resolve(deny('FIREWALL_MALFORMED'));
        try {
          const parsed = new URL(r['pageOrigin'] as string);
          if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
            return Promise.resolve(deny('FIREWALL_MALFORMED'));
          }
        } catch {
          return Promise.resolve(deny('FIREWALL_MALFORMED'));
        }
      }

      const policy = r['policy'];
      if (!isValidContract(policy)) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }

      // 3 — content scan (run last so a malformed payload is reported as such first).
      if (payloadContainsDetectablePII(request)) {
        return Promise.resolve(deny('FIREWALL_PII_DETECTED'));
      }

      // 4 — pixel payload. Distinct from the PII scan and never folded into it: an
      // encoded capture has no PII pattern, so the scan above cannot see it.
      if (containsPixelPayload(request)) {
        return Promise.resolve(deny('FIREWALL_PIXEL_PAYLOAD'));
      }

      return Promise.resolve(allow());
    },
  };
}
