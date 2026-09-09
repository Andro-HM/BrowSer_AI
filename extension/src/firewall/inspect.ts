// M6/M7 seam — privacy firewall (blueprint §7, CONTRIBUTING.md §5).
//
// The SINGLE outbound boundary. Every `RemoteAgentRequest` passes `inspect()` before
// any transmission, and the verdict FAILS CLOSED: if safety cannot be established the
// request is blocked, never "probably fine".
//
// What the firewall can honestly establish (and how):
//   1. STRUCTURE — the payload is exactly a `RemoteAgentRequest`: every expected key,
//      correctly typed, and NO extra keys (a compromised/malicious planner cannot
//      smuggle payload through unspecified fields).
//   2. ALIAS SHAPE — every alias matches the semantic `USER_<CATEGORY>_<n>` grammar;
//      an alias field is a type, never a value.
//   3. CONTENT SCAN — the same local PII detector used on-page (M2 `detectPII`) runs
//      over every text-bearing string in the payload. One hit ⇒ BLOCK: if the payload
//      still contains a detectable email/phone/card/credential pattern, it is not clean.
//
// What the firewall deliberately does NOT claim: it cannot prove the absence of raw
// values the detector does not recognize (e.g. free-text names). That residual risk is
// bounded upstream — `EnforcementResult` only emits `sanitizedText` when the page was
// fully enforced — and documented honestly (CONTRIBUTING.md §22: no fabricated guarantees).
//
// This module performs no logging and no network I/O.

import { isControlHandle, type RemoteAgentRequest } from '../types/contracts';
import { ALLOWED_ACTION_KINDS } from '../actions/kinds';
import { detectPII } from '../perception/pii';

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
const ALIAS_CATEGORIES = new Set([
  'EMAIL',
  'PHONE',
  'NAME',
  'ADDRESS',
  'PASSWORD',
  'OTP',
  'PAYMENT',
  'ID',
  'CUSTOM',
  'AADHAAR',
  'PAN',
  'UPI',
]);

const REQUEST_KEYS = new Set([
  'taskObjective',
  'pageOrigin',
  'provider',
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
  if (!isControlHandle(n['controlId'])) return false;
  if (typeof n['filled'] !== 'boolean' || typeof n['disabled'] !== 'boolean') return false;
  for (const optional of ['inputType', 'label', 'name']) {
    const value = n[optional];
    if (value !== undefined && typeof value !== 'string') return false;
  }
  if (n['belowFold'] !== undefined && typeof n['belowFold'] !== 'boolean') return false;
  for (const key of Object.keys(n)) {
    if (
      ![
        'tag',
        'controlId',
        'inputType',
        'label',
        'name',
        'filled',
        'disabled',
        'belowFold',
      ].includes(key)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The one content gate: every string that could carry page-derived text is scanned by
 * the same detector M2 uses on-page. Aliases (`USER_EMAIL_1`) are deliberately shaped
 * so they cannot match any detector pattern.
 */
function payloadContainsDetectablePII(request: RemoteAgentRequest): boolean {
  const texts: string[] = [request.sanitizedVisibleText, request.taskObjective];
  for (const node of request.sanitizedPageStructure) {
    if (node.inputType !== undefined) texts.push(node.inputType);
    if (node.label !== undefined) texts.push(node.label);
    if (node.name !== undefined) texts.push(node.name);
  }
  return texts.some((text) => detectPII(text).length > 0);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

/** Navigation configuration is an origin list, never arbitrary URL/page content. */
function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

const MEDIA_DATA_URL = /data:(?:image|video|audio)\//i;
const BASE64_RUN = /[A-Za-z0-9+/]{256,}={0,2}/;
function containsPixelPayload(request: RemoteAgentRequest): boolean {
  const texts: string[] = [request.sanitizedVisibleText, request.taskObjective];
  for (const node of request.sanitizedPageStructure) {
    if (node.inputType !== undefined) texts.push(node.inputType);
    if (node.label !== undefined) texts.push(node.label);
    if (node.name !== undefined) texts.push(node.name);
  }
  return texts.some((text) => MEDIA_DATA_URL.test(text) || BASE64_RUN.test(text));
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
      const required = [...REQUEST_KEYS].filter(
        (key) => key !== 'pageOrigin' && key !== 'provider',
      );
      const missing = required.filter((key) => !(key in r));
      if (missing.length > 0) return Promise.resolve(deny('FIREWALL_MALFORMED'));

      if (
        typeof r['taskObjective'] !== 'string' ||
        (r['taskObjective'] as string).length > MAX_TASK_LENGTH
      ) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }
      if (
        typeof r['sanitizedVisibleText'] !== 'string' ||
        (r['sanitizedVisibleText'] as string).length > MAX_TEXT_LENGTH
      ) {
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
            isExactObject(a, ['alias', 'category']) &&
            typeof a['alias'] === 'string' &&
            ALIAS_PATTERN.test(a['alias']) &&
            typeof a['category'] === 'string' &&
            ALIAS_CATEGORIES.has(a['category']),
        )
      ) {
        return Promise.resolve(deny('FIREWALL_BAD_ALIAS'));
      }

      const availableActions = r['availableActions'];
      if (
        !Array.isArray(availableActions) ||
        !availableActions.every((kind) =>
          (ALLOWED_ACTION_KINDS as readonly string[]).includes(kind as string),
        )
      ) {
        return Promise.resolve(deny('FIREWALL_BAD_ACTIONS'));
      }

      // provider: an optional, value-free planner hint restricted to the known set.
      if (r['provider'] !== undefined) {
        const provider = r['provider'];
        if (
          typeof provider !== 'string' ||
          !['gemini', 'ollama', 'deterministic'].includes(provider)
        ) {
          return Promise.resolve(deny('FIREWALL_MALFORMED'));
        }
      }

      // pageOrigin: origin-only string (never a full URL) — validated as such.
      if (r['pageOrigin'] !== undefined) {
        if (typeof r['pageOrigin'] !== 'string') return Promise.resolve(deny('FIREWALL_MALFORMED'));
        try {
          const parsed = new URL(r['pageOrigin'] as string);
          if (
            parsed.pathname !== '/' ||
            parsed.search !== '' ||
            parsed.hash !== '' ||
            parsed.username !== '' ||
            parsed.password !== ''
          ) {
            return Promise.resolve(deny('FIREWALL_MALFORMED'));
          }
        } catch {
          return Promise.resolve(deny('FIREWALL_MALFORMED'));
        }
      }

      const policy = r['policy'];
      if (
        !isExactObject(policy, ['privacyMode', 'navigationAllowlist']) ||
        policy['privacyMode'] !== 'strict' ||
        !Array.isArray(policy['navigationAllowlist']) ||
        !policy['navigationAllowlist'].every(isHttpsOrigin)
      ) {
        return Promise.resolve(deny('FIREWALL_MALFORMED'));
      }

      // 3 — content scan (run last so a malformed payload is reported as such first).
      if (payloadContainsDetectablePII(request)) {
        return Promise.resolve(deny('FIREWALL_PII_DETECTED'));
      }
      if (containsPixelPayload(request)) return Promise.resolve(deny('FIREWALL_PIXEL_PAYLOAD'));

      return Promise.resolve(allow());
    },
  };
}
