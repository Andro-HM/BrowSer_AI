// M6 — the task privacy contract's vocabulary and its fail-closed defaults.
//
// The contract itself is a TYPE (`TaskPrivacyContract` in types/contracts.ts); what is
// testable at runtime is the mode vocabulary that backs it and the deny-all default the
// local enforcement side starts from.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIVACY_MODE,
  PRIVACY_MODES,
  isPrivacyMode,
} from '../../extension/src/policy/modes';
import { DEFAULT_ACTION_POLICY, validateActionPolicy } from '../../extension/src/actions/validate';

describe('privacy mode vocabulary', () => {
  it('declares exactly the modes the implementation defines', () => {
    // Honest surface (CONTRIBUTING.md §22): no mode name exists without behaviour behind
    // it. If a relaxation mode is ever implemented, this list — and this test — change
    // together with it.
    expect(PRIVACY_MODES).toEqual(['strict']);
    expect(DEFAULT_PRIVACY_MODE).toBe('strict');
  });

  it('rejects every undefined regime a caller could claim', () => {
    expect(isPrivacyMode('strict')).toBe(true);
    for (const claimed of ['standard', 'permissive', 'STRICT', '', 'none', null, undefined, 1, {}]) {
      expect(isPrivacyMode(claimed)).toBe(false);
    }
  });
});

describe('default action policy (local enforcement side of the contract)', () => {
  it('denies navigation outright and cannot be widened in place', () => {
    expect(DEFAULT_ACTION_POLICY.navigationAllowlist).toEqual([]);
    expect(Object.isFrozen(DEFAULT_ACTION_POLICY)).toBe(true);
    expect(() =>
      (DEFAULT_ACTION_POLICY.navigationAllowlist as string[]).push('https://evil.test'),
    ).toThrow();

    const verdict = validateActionPolicy(
      { action: 'NAVIGATE', url: 'https://evil.test' },
      DEFAULT_ACTION_POLICY,
    );
    expect(verdict).toEqual({ valid: false, reason: 'POLICY_URL_NOT_ALLOWLISTED' });
  });
});
