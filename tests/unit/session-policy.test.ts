import { describe, expect, it } from 'vitest';
import { createSessionNavigationPolicy } from '../../extension/src/agent/session-policy';

describe('per-run navigation policy', () => {
  it('does not let one run replace another run\'s allowlist', () => {
    const first = createSessionNavigationPolicy(['https://one.test']);
    const second = createSessionNavigationPolicy(['https://two.test']);
    second.set(['https://changed.test']);
    expect(first.get()).toEqual(['https://one.test']);
    expect(second.get()).toEqual(['https://changed.test']);
  });
});
