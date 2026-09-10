import { describe, expect, it } from 'vitest';
import {
  getActivePanelOperation,
  tryAcquirePanelOperation,
} from '../../extension/src/sidepanel/operation-lock';

describe('side-panel operation isolation', () => {
  it('prevents manual scan and visual checks from overlapping an agent run', () => {
    const releaseAgent = tryAcquirePanelOperation('agent');
    expect(releaseAgent).not.toBeNull();
    expect(getActivePanelOperation()).toBe('agent');

    expect(tryAcquirePanelOperation('scan')).toBeNull();
    expect(tryAcquirePanelOperation('visual')).toBeNull();

    releaseAgent?.();
    const releaseScan = tryAcquirePanelOperation('scan');
    expect(releaseScan).not.toBeNull();
    releaseScan?.();
    expect(getActivePanelOperation()).toBeNull();
  });

  it('uses an idempotent owner release token', () => {
    const release = tryAcquirePanelOperation('visual');
    expect(release).not.toBeNull();
    release?.();
    release?.();
    expect(getActivePanelOperation()).toBeNull();
  });
});
