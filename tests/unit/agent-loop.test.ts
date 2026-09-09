import { describe, expect, it } from 'vitest';
import { runAgentLoop, toSanitizedNodes } from '../../extension/src/agent/loop';
import { createSessionNavigationPolicy } from '../../extension/src/agent/session-policy';
import { createDeterministicPlanner } from '../../extension/src/agent/planner';
import { createActionBridge } from '../../extension/src/actions';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { createLocalVault } from '../../extension/src/vault';
import type { AgentAction, RemoteAgentRequest } from '../../extension/src/types/contracts';
import type { FieldStructure, ScanPageResponse } from '../../extension/src/types/messages';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';
const CANARY_PHONE = '555-123-4567';

/** Mutable fake page state; `scan` renders it the way the content script would. */
function fakePage() {
  const state = { email: '', phone: '', submitDisabled: false };
  const scan = async (): Promise<ScanPageResponse> => ({
    pageText: [
      'Demo form — enter your contact details',
      `Example format: ${CANARY_EMAIL}`,
      `Example format: ${CANARY_PHONE}`,
      state.email,
      state.phone,
    ]
      .filter((part) => part.length > 0)
      .join('\n'),
    snapshot: null,
    structure: [
      { tag: 'input', control: 'CONTROL_1', inputType: 'email', label: 'Email', value: state.email || undefined, disabled: false },
      { tag: 'input', control: 'CONTROL_2', inputType: 'tel', name: 'phone', label: 'Phone', value: state.phone || undefined, disabled: false },
      { tag: 'button', control: 'CONTROL_3', label: 'Submit', disabled: state.submitDisabled },
    ] satisfies FieldStructure[],
  });

  /** The "page": a resolved TYPE writes the real value; CLICK disables the button. */
  const executor = async (action: AgentAction) => {
    if (action.action === 'TYPE' && action.target === 'CONTROL_1') state.email = action.value;
    else if (action.action === 'TYPE' && action.target === 'CONTROL_2') state.phone = action.value;
    else if (action.action === 'CLICK' && action.target === 'CONTROL_3') state.submitDisabled = true;
    else return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, code: 'OK' };
  };
  return { state, scan, executor };
}

function buildLoop(page: ReturnType<typeof fakePage>, task: string) {
  const seenRequests: RemoteAgentRequest[] = [];
  const vault = createLocalVault();
  const planner = createDeterministicPlanner();
  const gateway = {
    plan: async (request: RemoteAgentRequest) => {
      seenRequests.push(request);
      return planner.plan(request);
    },
  };
  const run = () =>
    runAgentLoop({
      task,
      sessionId: 'test-session',
      vault,
      gateway,
      bridge: createActionBridge({ vault, sendToPage: page.executor }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });
  return { run, seenRequests, vault };
}

describe('agent loop (deterministic, in-extension)', () => {
  it('fills both fields via aliases, submits, and completes', async () => {
    const page = fakePage();
    const { run, seenRequests, vault } = buildLoop(page, 'fill the form with my details and submit');

    const result = await run();

    expect(result.status).toBe('completed');
    expect(result.actionsExecuted).toBe(3);
    // Alias resolution happened LOCALLY: the executor received the real values…
    expect(page.state.email).toBe(CANARY_EMAIL);
    expect(page.state.phone).toBe(CANARY_PHONE);
    // …while every outbound request carried aliases only — never a raw value.
    for (const request of seenRequests) {
      const json = JSON.stringify(request);
      expect(json).not.toContain(CANARY_EMAIL);
      expect(json).not.toContain(CANARY_PHONE);
    }
    // The vault (local, in memory) holds the alias→value mapping.
    expect(await vault.resolve('USER_EMAIL_1')).toBe(CANARY_EMAIL);
  });

  it('never exposes the resolved value in step records', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, 'fill the form with my details and submit');
    const result = await run();
    const json = JSON.stringify(result.steps);
    expect(json).not.toContain(CANARY_EMAIL);
    expect(json).not.toContain(CANARY_PHONE);
    expect(json).toContain('USER_EMAIL_1');
  });

  it('stops fail-closed when the page carries a critical credential', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, 'fill the form');
    // Simulate a password field on the page: credential pattern in page text ⇒ BLOCK.
    const inner = page.scan;
    page.scan = async () => ({
      ...(await inner()),
      pageText: 'password: hunter2hunter2',
    });
    const result = await run();
    expect(result.status).toBe('blocked');
    expect(result.actionsExecuted).toBe(0);
  });

  it('stops on a restricted surface and on scan failure', async () => {
    const restricted = fakePage();
    const restrictedRun = buildLoop(restricted, 'fill the form');
    restricted.scan = async () => ({ restricted: true });
    expect((await restrictedRun.run()).status).toBe('restricted');

    const broken = fakePage();
    const brokenRun = buildLoop(broken, 'fill the form');
    broken.scan = async () => {
      throw new Error('channel closed');
    };
    const result = await brokenRun.run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('SCAN_FAILED');
  });

  it('reports planner failure and rejected actions without retries', async () => {
    const failing = fakePage();
    failing.scan = async () => ({
      pageText: `Reach me at ${CANARY_EMAIL}`,
      snapshot: null,
      structure: [{ tag: 'input', control: 'CONTROL_99', inputType: 'email', label: 'Email', disabled: false }],
    });
    // Use the real loop with a gateway that throws — planner failures stop the loop.
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault,
      gateway: { plan: async () => { throw new Error('boom'); } },
      bridge: createActionBridge({ vault, sendToPage: failing.executor }),
      firewall: createPrivacyFirewall(),
      scan: failing.scan,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('PLANNER_FAILED');

    const rejecting = fakePage();
    rejecting.scan = async () => ({
      pageText: `Reach me at ${CANARY_EMAIL}`,
      snapshot: null,
      structure: [{ tag: 'input', control: 'CONTROL_99', inputType: 'email', label: 'Email', disabled: false }],
    });
    // ONE shared vault between loop (writes aliases) and bridge (resolves them) — the
    // same constraint the panel must honor.
    const sharedVault = createLocalVault();
    const rejected = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault: sharedVault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({ vault: sharedVault, sendToPage: rejecting.executor }),
      firewall: createPrivacyFirewall(),
      scan: rejecting.scan,
    });
    expect(rejected.status).toBe('error');
    expect(rejected.reason).toBe('NOT_FOUND');
  });

  it('stops at the step budget and flags a no-progress repeat', async () => {
    const scrolling = fakePage();
    let amount = 0;
    const vault = createLocalVault();
    const varying = await runAgentLoop({
      task: 'scroll around',
      sessionId: 's',
      vault,
      gateway: { plan: async () => [{ action: 'SCROLL', amount: (amount += 100) }] },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scrolling.scan,
      maxSteps: 4,
    });
    expect(varying.status).toBe('max_steps');
    expect(varying.steps).toHaveLength(4);

    // Repeated TYPE (not SCROLL — scrolling is exempt, it is progress-seeking).
    const stuck = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault: createLocalVault(),
      gateway: { plan: async () => [{ action: 'TYPE', target: 'CONTROL_1', value: 'hello' }]},
      bridge: createActionBridge({ vault: createLocalVault(), sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scrolling.scan,
      maxSteps: 8,
    });
    expect(stuck.status).toBe('max_steps');
    expect(stuck.reason).toBe('NO_PROGRESS');
  });

  it('scrolls to below-fold fields, fills them, and completes without tripping the guard', async () => {
    const state = { email: '', submitted: false };
    const page: {
      scrollY: number;
      scan: () => Promise<ScanPageResponse>;
      executor: (action: import('../../extension/src/types/contracts').AgentAction) => Promise<{ ok: boolean; code?: string }>;
    } = {
      scrollY: 0,
      scan: async () => {
        const emailTop = 1600 - page.scrollY;
        return {
          pageText: `Contact: BENCH_EMAIL_001@example.test\n${state.email}`,
          snapshot: { url: 'https://site.test/form', viewport: { width: 1280, height: 800 }, domTextLength: 0, candidates: [] },
          structure: [
            {
              tag: 'input',
              control: 'CONTROL_1',
              inputType: 'email',
              label: 'Email',
              value: state.email || undefined,
              disabled: false,
              belowFold: emailTop >= 800,
            },
            {
              tag: 'button',
              control: 'CONTROL_2',
              label: 'Submit',
              disabled: state.submitted,
              belowFold: 1750 - page.scrollY >= 800,
            },
          ],
        };
      },
      executor: async (action) => {
        if (action.action === 'SCROLL') {
          page.scrollY += action.amount;
          return { ok: true, code: 'OK' };
        }
        if (action.action === 'TYPE' && action.target === 'CONTROL_1') {
          state.email = action.value;
          return { ok: true, code: 'OK' };
        }
        if (action.action === 'CLICK' && action.target === 'CONTROL_2') {
          state.submitted = true;
          return { ok: true, code: 'OK' };
        }
        return { ok: false, code: 'NOT_FOUND' };
      },
    };

    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form with my details and submit',
      sessionId: 'scroll-session',
      vault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({ vault, sendToPage: page.executor }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });

    expect(result.status).toBe('completed');
    expect(state.email).toBe('BENCH_EMAIL_001@example.test');
    expect(state.submitted).toBe(true);
    // The scroll steps really happened through the validated bridge.
    expect(result.steps.filter((step) => step.action?.action === 'SCROLL').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to an allowlisted origin named in the task, then fills the form', async () => {
    let url = 'https://portal.test/start';
    const state = { email: '' };
    const executed: string[] = [];
    const scan = async (): Promise<ScanPageResponse> => {
      const onTarget = url.startsWith('https://privagent.test');
      return {
        pageText: [
          onTarget ? `Checkout — Contact BENCH_EMAIL_001@example.test` : 'Landing page: open privagent.test to continue',
          state.email,
        ]
          .filter((part) => part.length > 0)
          .join('\n'),
        snapshot: { url, viewport: { width: 1280, height: 800 }, domTextLength: 0, candidates: [] },
        structure: onTarget
          ? [
              {
                tag: 'input',
                control: 'CONTROL_1',
                inputType: 'email',
                label: 'Email',
                value: state.email || undefined,
                disabled: false,
              },
            ]
          : [],
      };
    };
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'open privagent.test and fill the form with my details',
      sessionId: 'nav-session',
      vault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({
        vault,
        policy: { navigationAllowlist: ['https://privagent.test'], maxScroll: 10_000 },
        sendToPage: async (action) => {
          executed.push(action.action);
          if (action.action === 'NAVIGATE') {
            url = action.url;
            return { ok: true, code: 'OK' };
          }
          if (action.action === 'TYPE' && action.target === 'CONTROL_1') {
            state.email = action.value;
            return { ok: true, code: 'OK' };
          }
          return { ok: false, code: 'NOT_FOUND' };
        },
      }),
      firewall: createPrivacyFirewall(),
      scan,
      navigationAllowlist: ['https://privagent.test'],
    });

    expect(result.status).toBe('completed');
    expect(executed[0]).toBe('NAVIGATE');
    expect(executed).toContain('TYPE');
    expect(result.steps[0]?.action).toEqual({ action: 'NAVIGATE', url: 'https://privagent.test' });
  });

  it('rejects an empty task', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, '   ');
    expect((await run()).status).toBe('error');
  });
});

describe('toSanitizedNodes', () => {
  it('gates labels through the PII detector and never carries values or field names', () => {
    const nodes = toSanitizedNodes([
      { tag: 'input', control: 'CONTROL_1', label: 'Email', name: 'email', value: CANARY_EMAIL, disabled: false },
      { tag: 'input', control: 'CONTROL_2', label: `Owner ${CANARY_EMAIL}`, value: 'typed text', disabled: false },
      { tag: 'button', control: 'CONTROL_3', label: 'Submit', disabled: false },
    ]);
    const [plain, gated, button] = nodes;
    expect(plain).toMatchObject({ control: 'CONTROL_1', label: 'Email', filled: true });
    expect(plain).not.toHaveProperty('name');
    expect(plain).not.toHaveProperty('value');
    expect(gated?.label).toBeUndefined();
    expect(gated?.filled).toBe(true);
    expect(button).toMatchObject({ tag: 'button', label: 'Submit', filled: false });
  });

  // A scan that reports no structure at all (older content script, a page with no
  // controls, or a partial response) must yield an EMPTY node list — never `undefined`
  // leaking into the request, and never a fabricated node.
  it('returns an empty list when the structure is missing or empty', () => {
    expect(toSanitizedNodes(undefined)).toEqual([]);
    expect(toSanitizedNodes([])).toEqual([]);
  });

  it('never serializes selector-relevant name/id canaries into the outbound structure', () => {
    const serialized = JSON.stringify(toSanitizedNodes([
      {
        tag: 'input',
        control: 'CONTROL_1',
        id: 'CANARY_CREDENTIAL_001',
        name: 'alice@example.test',
        inputType: 'email',
        disabled: false,
      },
    ]));

    expect(serialized).toContain('CONTROL_1');
    expect(serialized).not.toContain('alice@example.test');
    expect(serialized).not.toContain('CANARY_CREDENTIAL_001');
    expect(serialized).not.toContain('selector');
  });
});

describe('session navigation policy (per-run handle)', () => {
  it('defaults to an empty (deny-all) allowlist and isolates runs from each other', () => {
    const first = createSessionNavigationPolicy();
    const second = createSessionNavigationPolicy();
    expect(first.get()).toEqual([]);

    first.set(['https://a.test']);
    // No shared module-level state: publishing in one run cannot widen the other.
    expect(first.get()).toEqual(['https://a.test']);
    expect(second.get()).toEqual([]);
  });

  it('copies on write and hands out a frozen list the holder cannot widen', () => {
    const policy = createSessionNavigationPolicy();
    const source = ['https://a.test'];
    policy.set(source);
    source.push('https://evil.test');
    expect(policy.get()).toEqual(['https://a.test']);
    expect(() => (policy.get() as string[]).push('https://evil.test')).toThrow();
  });

  it('receives the origin the loop derived, which is what the bridge validates against', async () => {
    const page = fakePage();
    const navigationPolicy = createSessionNavigationPolicy();
    const vault = createLocalVault();
    // No explicit allowlist ⇒ the loop derives the scanned page's own origin.
    page.scan = async () => ({
      pageText: `Reach me at ${CANARY_EMAIL}`,
      snapshot: { url: 'https://site.test/form?x=1', viewport: { width: 1280, height: 800 }, domTextLength: 0, candidates: [] },
      structure: [],
    });
    const result = await runAgentLoop({
      task: 'do nothing here',
      sessionId: 'nav-handle-session',
      vault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({ vault, sendToPage: page.executor }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
      navigationPolicy,
    });

    expect(result.status).toBe('completed');
    // Origin only — never the full URL (a path/query can carry content).
    expect(navigationPolicy.get()).toEqual(['https://site.test']);
  });
});
