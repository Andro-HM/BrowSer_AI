import { describe, expect, it } from 'vitest';
import { createActionBridge } from '../../extension/src/actions';
import { runAgentLoop } from '../../extension/src/agent/loop';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import type { AgentAction, RemoteAgentRequest } from '../../extension/src/types/contracts';
import {
  createLayeredVault,
  createLocalVault,
  createSecurePersistentVault,
  type EncryptedVaultEnvelope,
  type EncryptedVaultStore,
} from '../../extension/src/vault';
import { taskNeedsSavedDetails } from '../../extension/src/sidepanel/AgentTask';
import { createRunAuditStore } from '../../extension/src/sidepanel/run-audit-store';

const SECRET = 'PERSISTENT_AGENT_CANARY_4182@example.test';

function memoryStore(): EncryptedVaultStore {
  let envelope: EncryptedVaultEnvelope | undefined;
  return {
    async read() { return envelope === undefined ? undefined : structuredClone(envelope); },
    async write(next) { envelope = structuredClone(next); },
  };
}

describe('persistent alias → local execution integration', () => {
  it('sends metadata only, fills the real value locally, and re-sanitizes the next observation', async () => {
    const secure = createSecurePersistentVault({
      store: memoryStore(),
      iterations: 1_000,
      minimumPassphraseLength: 1,
    });
    await secure.create('synthetic-passphrase');
    await secure.add({ label: 'Primary email', category: 'EMAIL', value: SECRET });
    const vault = createLayeredVault(createLocalVault(), secure);
    const audit = createRunAuditStore();
    audit.begin('persistent-agent', 'offline');
    const requests: RemoteAgentRequest[] = [];
    const page = { email: '' };
    let scanIndex = 0;

    const result = await runAgentLoop({
      task: 'Fill the form with my saved email',
      sessionId: 'persistent-agent',
      vault,
      availableAliases: vault.persistentAliases(),
      audit,
      firewall: createPrivacyFirewall(),
      scan: async () => ({
        observationEpoch: `persistent-observation-${++scanIndex}`,
        documentGeneration: 'persistent-document',
        pageText: `Email\n${page.email}`,
        snapshot: null,
        structure: [
          {
            tag: 'input',
            controlId: 'CONTROL_1',
            inputType: 'email',
            label: 'Email',
            value: page.email || undefined,
            disabled: false,
          },
        ],
      }),
      gateway: {
        async plan(request) {
          requests.push(structuredClone(request));
          return requests.length === 1
            ? [{ action: 'TYPE', target: 'CONTROL_1', value: 'USER_EMAIL_1' }]
            : [];
        },
      },
      bridge: createActionBridge({
        vault,
        sendToPage: async (action: AgentAction) => {
          if (action.action !== 'TYPE') return { ok: false, code: 'UNSUPPORTED' };
          page.email = action.value;
          return { ok: true, code: 'OK' };
        },
        onAliasResolved: (alias, target, action) => {
          audit.recordAliasResolution({ alias, target, action });
        },
      }),
    });
    audit.complete(result);

    expect(result.status).toBe('completed');
    expect(page.email).toBe(SECRET);
    expect(requests[0]?.aliases).toContainEqual({ alias: 'USER_EMAIL_1', category: 'EMAIL' });
    expect(requests[1]?.aliases).toContainEqual({ alias: 'USER_EMAIL_2', category: 'EMAIL' });
    for (const request of requests) expect(JSON.stringify(request)).not.toContain(SECRET);
    expect(audit.getSnapshot().outbound?.payloadJson).not.toContain(SECRET);
    expect(audit.getSnapshot().resolutions).toEqual([
      { alias: 'USER_EMAIL_1', target: 'CONTROL_1', action: 'TYPE' },
    ]);
    expect(await secure.resolve('USER_EMAIL_1')).toBe(SECRET);
  });

  it('re-sanitizes a patternless persistent value after local form filling', async () => {
    const address = '42 Synthetic Lane';
    const secure = createSecurePersistentVault({
      store: memoryStore(),
      iterations: 1_000,
      minimumPassphraseLength: 1,
    });
    await secure.create('synthetic-passphrase');
    await secure.add({ label: 'Demo address', category: 'ADDRESS', value: address });
    const vault = createLayeredVault(createLocalVault(), secure);
    const requests: RemoteAgentRequest[] = [];
    let fieldValue = '';
    let scanIndex = 0;

    const result = await runAgentLoop({
      task: 'Fill my saved address',
      sessionId: 'patternless-persistent-agent',
      vault,
      availableAliases: vault.persistentAliases(),
      firewall: createPrivacyFirewall(),
      scan: async () => ({
        observationEpoch: `address-observation-${++scanIndex}`,
        documentGeneration: 'address-document',
        pageText: `Address\n${fieldValue}`,
        snapshot: null,
        structure: [{
          tag: 'input',
          controlId: 'CONTROL_1',
          inputType: 'text',
          label: 'Address',
          value: fieldValue || undefined,
          disabled: false,
        }],
      }),
      gateway: {
        async plan(request) {
          requests.push(structuredClone(request));
          return requests.length === 1
            ? [{ action: 'TYPE', target: 'CONTROL_1', value: 'USER_ADDRESS_1' }]
            : [];
        },
      },
      bridge: createActionBridge({
        vault,
        sendToPage: async (action) => {
          if (action.action !== 'TYPE') return { ok: false, code: 'UNSUPPORTED' };
          fieldValue = action.value;
          return { ok: true, code: 'OK' };
        },
      }),
    });

    expect(result.status).toBe('completed');
    expect(fieldValue).toBe(address);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.sanitizedVisibleText).not.toContain(address);
    expect(requests[1]?.sanitizedVisibleText).toContain('USER_ADDRESS_2');
    for (const request of requests) expect(JSON.stringify(request)).not.toContain(address);
  });

  it('recognizes saved-detail tasks so a locked vault can stop before planning', () => {
    expect(taskNeedsSavedDetails('Fill the form with my saved details and submit')).toBe(true);
    expect(taskNeedsSavedDetails('Use my email')).toBe(true);
    expect(taskNeedsSavedDetails('Click the public Continue button')).toBe(false);
  });
});
