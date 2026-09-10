import { describe, expect, it, vi } from 'vitest';
import {
  isRepeatOfLastExecuted,
  runAgentLoop,
  toLastExecutedAction,
} from '../../extension/src/agent/loop';
import { createActionBridge } from '../../extension/src/actions';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { createLocalVault } from '../../extension/src/vault';
import type { AgentAction, RemoteAgentRequest } from '../../extension/src/types/contracts';
import type { ScanPageResponse } from '../../extension/src/types/messages';

const CANARY_EMAIL = 'CANARY_HISTORY_001@example.test';

let observationSequence = 0;
function nextObservation() {
  return {
    observationEpoch: `history-observation-${++observationSequence}`,
    documentGeneration: 'history-document',
  };
}

function submitPage() {
  const state = { submitted: false };
  const scan = async (): Promise<ScanPageResponse> => ({
    ...nextObservation(),
    pageText: state.submitted ? 'Confirmation screen' : 'Order form — review and submit',
    snapshot: null,
    structure: [
      { tag: 'button', controlId: 'CONTROL_3', label: 'Submit', disabled: false },
    ],
  });
  return { state, scan };
}

describe('lastExecutedAction history + pre-execution duplicate guard', () => {
  it('sends only kind + CONTROL_n + outcome — no values, selectors, or raw text', async () => {
    const page = submitPage();
    const seen: RemoteAgentRequest[] = [];
    let calls = 0;
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'click the submit button',
      sessionId: 'history-shape',
      vault,
      gateway: {
        plan: async (request) => {
          seen.push(request);
          calls++;
          // First step: click. Second step: done (simulates a model that
          // recognized completion from current state + history).
          if (calls === 1) return [{ action: 'CLICK', target: 'CONTROL_3' }];
          return [];
        },
      },
      bridge: createActionBridge({
        vault,
        sendToPage: async (action: AgentAction) => {
          if (action.action === 'CLICK' && action.target === 'CONTROL_3') {
            page.state.submitted = true;
            return { ok: true, code: 'OK' };
          }
          return { ok: false, code: 'NOT_FOUND' };
        },
      }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });

    expect(result.status).toBe('completed');
    // First request carries no history; the second carries exactly the metadata.
    expect(seen[0]?.lastExecutedAction).toBeUndefined();
    expect(seen[1]?.lastExecutedAction).toEqual({
      action: 'CLICK',
      controlId: 'CONTROL_3',
      outcome: 'executed',
    });
    const historyJson = JSON.stringify(seen[1]?.lastExecutedAction);
    expect(historyJson).not.toContain('#');
    expect(historyJson).not.toContain('submit');
    expect(historyJson).not.toContain('value');
    expect(historyJson).not.toContain('url');
  });

  it('updated page text + previous successful click can produce completion', async () => {
    const page = submitPage();
    const seen: RemoteAgentRequest[] = [];
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'click the submit button',
      sessionId: 'history-completion',
      vault,
      gateway: {
        plan: async (request: RemoteAgentRequest) => {
          seen.push(request);
          if (seen.length === 1) return [{ action: 'CLICK', target: 'CONTROL_3' }];
          // Second observation is fresh ("Confirmation screen") and carries the
          // history — the planner recognizes the operation already succeeded.
          expect(request.sanitizedVisibleText).toContain('Confirmation');
          expect(request.lastExecutedAction).toEqual({
            action: 'CLICK',
            controlId: 'CONTROL_3',
            outcome: 'executed',
          });
          return [];
        },
      },
      bridge: createActionBridge({
        vault,
        sendToPage: async () => {
          page.state.submitted = true;
          return { ok: true, code: 'OK' };
        },
      }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });

    expect(result.status).toBe('completed');
    expect(result.actionsExecuted).toBe(1);
  });

  it('does not execute the duplicate action twice', async () => {
    const page = submitPage();
    const execute = vi.fn(async () => ({ ok: true as const, code: 'OK' }));
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'click the submit button',
      sessionId: 'history-dedupe',
      vault,
      // A stuck planner that ignores state + history and repeats the click.
      gateway: { plan: async () => [{ action: 'CLICK', target: 'CONTROL_3' }] },
      bridge: createActionBridge({ vault, sendToPage: execute }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('NO_PROGRESS');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.actionsExecuted).toBe(1);
  });

  it('retains the NO_PROGRESS fail-safe for genuinely stuck cases', async () => {
    // NAVIGATE repeats carry no URL in the history metadata, so the
    // post-execution exact-match guard remains their fail-safe.
    const page = submitPage();
    const execute = vi.fn(async () => ({ ok: true as const, code: 'OK' }));
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'open the site',
      sessionId: 'history-nav-guard',
      vault,
      gateway: {
        plan: async () => [{ action: 'NAVIGATE', url: 'https://privagent.test/' }],
      },
      bridge: createActionBridge({
        vault,
        policy: { navigationAllowlist: ['https://privagent.test/'], maxScroll: 10_000 },
        sendToPage: execute,
      }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('NO_PROGRESS');
    // The exact-match post-guard fires after the second identical execution.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('never carries raw PII in history, and the firewall rejects smuggled history', async () => {
    const scan = async (): Promise<ScanPageResponse> => ({
      ...nextObservation(),
      pageText: `Contact ${CANARY_EMAIL}`,
      snapshot: null,
      structure: [
        { tag: 'input', controlId: 'CONTROL_1', inputType: 'email', label: 'Email', disabled: false },
        { tag: 'button', controlId: 'CONTROL_3', label: 'Submit', disabled: false },
      ],
    });
    const seen: RemoteAgentRequest[] = [];
    const vault = createLocalVault();
    await runAgentLoop({
      task: 'fill the form with my details and submit',
      sessionId: 'history-pii',
      vault,
      gateway: {
        plan: async (request: RemoteAgentRequest) => {
          seen.push(request);
          // Drive exactly two steps: TYPE then stop.
          if (seen.length === 1) {
            return [{ action: 'TYPE', target: 'CONTROL_1', value: 'USER_EMAIL_1' }];
          }
          return [];
        },
      },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan,
    });

    for (const request of seen) {
      expect(JSON.stringify(request)).not.toContain(CANARY_EMAIL);
      if (request.lastExecutedAction !== undefined) {
        expect(JSON.stringify(request.lastExecutedAction)).not.toContain(CANARY_EMAIL);
        expect(JSON.stringify(request.lastExecutedAction)).not.toContain('USER_EMAIL_1');
      }
    }

    const firewall = createPrivacyFirewall();
    const base: RemoteAgentRequest = {
      taskObjective: 'click the submit button',
      sanitizedPageStructure: [{ tag: 'button', controlId: 'CONTROL_3', filled: false, disabled: false }],
      sanitizedVisibleText: 'Confirmation screen',
      aliases: [],
      availableActions: ['CLICK'],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
      lastExecutedAction: { action: 'CLICK', controlId: 'CONTROL_3', outcome: 'executed' },
    };
    expect((await firewall.inspect(base)).allowed).toBe(true);

    // Selector-shaped handle, extra value field, and raw PII all fail closed.
    const selector = {
      ...base,
      lastExecutedAction: { action: 'CLICK', controlId: '#submit', outcome: 'executed' },
    } as unknown as RemoteAgentRequest;
    expect((await firewall.inspect(selector)).allowed).toBe(false);

    const withValue = {
      ...base,
      lastExecutedAction: { action: 'CLICK', controlId: 'CONTROL_3', outcome: 'executed', value: CANARY_EMAIL },
    } as unknown as RemoteAgentRequest;
    expect((await firewall.inspect(withValue)).reason).toBe('FIREWALL_MALFORMED');

    const scrollWithHandle = {
      ...base,
      lastExecutedAction: { action: 'SCROLL', controlId: 'CONTROL_3', outcome: 'executed' },
    } as unknown as RemoteAgentRequest;
    expect((await firewall.inspect(scrollWithHandle)).allowed).toBe(false);
  });

  it('unit: history helpers carry no values and exempt scrolls', () => {
    expect(toLastExecutedAction({ action: 'CLICK', target: 'CONTROL_3' })).toEqual({
      action: 'CLICK',
      controlId: 'CONTROL_3',
      outcome: 'executed',
    });
    expect(toLastExecutedAction({ action: 'SCROLL', amount: 720 })).toEqual({
      action: 'SCROLL',
      outcome: 'executed',
    });
    expect(
      isRepeatOfLastExecuted(
        { action: 'CLICK', target: 'CONTROL_3' },
        { action: 'CLICK', controlId: 'CONTROL_3', outcome: 'executed' },
      ),
    ).toBe(true);
    expect(
      isRepeatOfLastExecuted(
        { action: 'SCROLL', amount: 720 },
        { action: 'SCROLL', outcome: 'executed' },
      ),
    ).toBe(false);
  });
});
