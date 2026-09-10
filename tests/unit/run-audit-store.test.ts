import { describe, expect, it } from 'vitest';
import type { RemoteAgentRequest } from '../../extension/src/types/contracts';
import { createRunAuditStore } from '../../extension/src/sidepanel/run-audit-store';

const REQUEST: RemoteAgentRequest = {
  taskObjective: 'Fill the saved email field',
  pageOrigin: 'https://privagent.test',
  provider: 'zen',
  sanitizedPageStructure: [
    {
      tag: 'input',
      controlId: 'CONTROL_1',
      inputType: 'email',
      label: 'Email',
      filled: false,
      disabled: false,
    },
  ],
  sanitizedVisibleText: 'Email USER_EMAIL_1',
  aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
  availableActions: ['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'NAVIGATE'],
  policy: { privacyMode: 'strict', navigationAllowlist: ['https://privagent.test'] },
};

describe('most-recent-run privacy audit store', () => {
  it('keeps an exact in-memory clone of the approved request and measured safe facts', () => {
    const store = createRunAuditStore();
    store.begin('run-1', 'zen');
    store.recordApprovedOutbound(REQUEST, 'zen');

    const outbound = store.getSnapshot().outbound;
    expect(outbound?.request).toEqual(REQUEST);
    expect(outbound?.request).not.toBe(REQUEST);
    expect(outbound?.payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(REQUEST)).byteLength);
    expect(outbound).toMatchObject({
      provider: 'zen',
      rawSensitiveValues: 0,
      rawPixelPayloads: 0,
      aliasCount: 1,
      controlCount: 1,
    });
  });

  it('replaces the previous run and records only value-free findings and resolutions', () => {
    const store = createRunAuditStore();
    store.begin('run-1', 'gemini');
    store.recordFindings([{ id: 'USER_EMAIL_1', category: 'EMAIL', source: 'DOM', disposition: 'aliased' }]);
    store.recordAliasResolution({ alias: 'USER_EMAIL_1', target: 'CONTROL_1', action: 'TYPE' });
    store.begin('run-2', 'offline');

    expect(store.getSnapshot()).toMatchObject({
      runId: 'run-2',
      provider: 'offline',
      status: 'running',
      findings: [],
      resolutions: [],
      outbound: null,
      result: null,
    });
  });
});
