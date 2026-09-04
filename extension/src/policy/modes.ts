// M6 — runtime companion to the `PrivacyMode` / `TaskPrivacyContract` types.
//
// `types/contracts.ts` is types-only, so the VALUES that back the privacy-mode union live
// here (same split as `actions/kinds.ts` for `AgentActionKind`). One vocabulary, one place:
// the loop emits `DEFAULT_PRIVACY_MODE`, the firewall validates with `isPrivacyMode`, so a
// mode can never be accepted at the boundary without existing in the type.
//
// Pure: no I/O, no state, no logging.

import type { PrivacyMode } from '../types/contracts';

/**
 * Exhaustive list of defined modes. `satisfies` keeps it in lockstep with `PrivacyMode` —
 * adding a mode here without widening the type (or vice versa) is a compile error.
 */
export const PRIVACY_MODES = ['strict'] as const satisfies readonly PrivacyMode[];

/** The regime the agent loop commits to today (the only implemented one). */
export const DEFAULT_PRIVACY_MODE: PrivacyMode = 'strict';

/** Runtime guard for untrusted input (a contract arriving from another context). */
export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === 'string' && (PRIVACY_MODES as readonly string[]).includes(value);
}
