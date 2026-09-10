// Deterministic test for the background SCAN_PAGE / SCROLL_VIEWPORT relay, including the
// on-demand content-script injection fallback that fixes the real runtime failure:
// a tab open BEFORE the extension loaded has no declared content-script receiver, so the
// first `sendMessage` finds nothing. The worker must then inject the content script and
// retry — surfacing PAGE_UNREACHABLE ONLY when injection itself is refused (fail closed).
//
// No real Chrome APIs: a fake `chrome` is installed before the worker module is imported,
// so its top-level `onMessage.addListener` registrations are captured and driven directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_VIEWPORT,
  EXECUTE_ACTION,
  RESOLVE_ACTIVE_TAB,
  SCAN_PAGE,
  SCROLL_VIEWPORT,
  VALIDATE_OBSERVATION,
} from '../../extension/src/types/messages';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

interface FakeState {
  listeners: Listener[];
  activeTab: { id?: number; url?: string; windowId?: number; active?: boolean } | undefined;
  pinnedTab: { id?: number; url?: string; windowId?: number; active?: boolean } | undefined;
  /** Queue of responses `tabs.sendMessage` returns, in order (undefined ⇒ no receiver). */
  sendMessageQueue: unknown[];
  sendMessageCalls: { tabId: number; message: unknown }[];
  executeScriptImpl: () => Promise<unknown>;
  executeScriptCalls: number;
  lastError: { message: string } | undefined;
  /** `captureVisibleTab` result: a data URL string, or undefined with a lastError set. */
  captureDataUrl: string | undefined;
  captureError: { message: string } | undefined;
  captureCalls: { windowId: number; options: unknown }[];
}

let state: FakeState;

function installFakeChrome(): void {
  state = {
    listeners: [],
    activeTab: { id: 7, url: 'https://example.test/page', windowId: 3, active: true },
    pinnedTab: { id: 7, url: 'https://example.test/page', windowId: 3, active: true },
    sendMessageQueue: [],
    sendMessageCalls: [],
    executeScriptImpl: () => Promise.resolve([{ result: undefined }]),
    executeScriptCalls: 0,
    lastError: undefined,
    captureDataUrl: 'data:image/png;base64,AAAA',
    captureError: undefined,
    captureCalls: [],
  };

  const chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: (fn: Listener) => state.listeners.push(fn) },
      get lastError() {
        return state.lastError;
      },
      getManifest: () => ({ content_scripts: [{ js: ['assets/content.js'] }] }),
    },
    sidePanel: { setPanelBehavior: vi.fn() },
    tabs: {
      query: (_q: unknown, cb?: (tabs: unknown[]) => void) => {
        const tabs = state.activeTab ? [state.activeTab] : [];
        if (cb) {
          cb(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
      get: (tabId: number) => {
        if (state.pinnedTab?.id === tabId) {
          return Promise.resolve({
            ...state.pinnedTab,
            active: state.activeTab?.id === tabId,
          });
        }
        if (state.activeTab?.id === tabId) return Promise.resolve(state.activeTab);
        return Promise.reject(new Error('missing tab'));
      },
      sendMessage: (
        _tabId: number,
        message: unknown,
        cb?: (response?: unknown) => void,
      ) => {
        state.sendMessageCalls.push({ tabId: _tabId, message });
        if ((message as { type?: string }).type === VALIDATE_OBSERVATION) {
          cb?.({ ok: true, code: 'OK' });
          return undefined;
        }
        const next = state.sendMessageQueue.shift();
        state.lastError = next === undefined ? { message: 'no receiver' } : undefined;
        cb?.(next);
        return undefined;
      },
      captureVisibleTab: (
        windowId: number,
        options: unknown,
        cb: (dataUrl?: string) => void,
      ) => {
        state.captureCalls.push({ windowId, options });
        state.lastError = state.captureError;
        cb(state.captureError ? undefined : state.captureDataUrl);
        return undefined;
      },
    },
    scripting: {
      executeScript: (_opts: unknown) => {
        state.executeScriptCalls += 1;
        return state.executeScriptImpl();
      },
    },
  };

  vi.stubGlobal('chrome', chrome);
}

async function loadWorker(): Promise<void> {
  vi.resetModules();
  await import('../../extension/src/background/index');
}

/** Drive the registered SCAN_PAGE/SCROLL_VIEWPORT listeners and await the response. */
function dispatch(message: Record<string, unknown> & { type: string }): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    for (const listener of state.listeners) {
      const keepOpen = listener(message, {}, (response) => {
        if (!settled) {
          settled = true;
          resolve(response);
        }
      });
      if (keepOpen === true) return; // async responder owns the resolve
    }
    if (!settled) resolve(undefined);
  });
}

beforeEach(() => {
  installFakeChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCAN_PAGE relay', () => {
  it('relays the content-script response when a receiver is already present', async () => {
    await loadWorker();
    const payload = { pageText: 'safe', snapshot: { url: 'https://example.test/page' } };
    state.sendMessageQueue = [payload];

    const response = await dispatch({ type: SCAN_PAGE, targetTabId: 7 });

    expect(response).toEqual(payload);
    expect(state.executeScriptCalls).toBe(0); // no injection needed
  });

  it('injects the content script and retries when no receiver exists (the real fix)', async () => {
    await loadWorker();
    const payload = { pageText: 'safe', snapshot: { url: 'https://example.test/page' } };
    // First attempt: no receiver (undefined). After injection, the retry succeeds.
    state.sendMessageQueue = [undefined, payload];

    const response = await dispatch({ type: SCAN_PAGE, targetTabId: 7 });

    expect(state.executeScriptCalls).toBe(1);
    expect(response).toEqual(payload);
  });

  it('reports PAGE_UNREACHABLE only when injection itself is refused (fail closed)', async () => {
    await loadWorker();
    state.sendMessageQueue = [undefined]; // never a receiver
    state.executeScriptImpl = () => Promise.reject(new Error('cannot access')); // browser refuses

    const response = await dispatch({ type: SCAN_PAGE, targetTabId: 7 });

    expect(response).toEqual({ error: 'PAGE_UNREACHABLE' });
  });

  it('reports a restricted surface without attempting injection', async () => {
    await loadWorker();
    state.activeTab = { id: 7, url: 'chrome://settings', windowId: 3, active: true };
    state.pinnedTab = state.activeTab;

    const response = await dispatch({ type: SCAN_PAGE, targetTabId: 7 });

    expect(response).toEqual({ restricted: true });
    expect(state.executeScriptCalls).toBe(0);
    expect(state.sendMessageCalls).toHaveLength(0);
  });

  it('reports TARGET_TAB_DISAPPEARED when the pinned tab no longer exists', async () => {
    await loadWorker();
    state.activeTab = undefined;
    state.pinnedTab = undefined;

    const response = await dispatch({ type: SCAN_PAGE, targetTabId: 7 });

    expect(response).toEqual({ error: 'TARGET_TAB_DISAPPEARED' });
  });

  it('never forwards a raw sendMessage payload for an unknown message type', async () => {
    await loadWorker();
    const response = await dispatch({ type: 'SOMETHING_ELSE' });
    expect(response).toBeUndefined();
  });
});

describe('SCROLL_VIEWPORT relay', () => {
  it('relays the scroll offset the content script reached', async () => {
    await loadWorker();
    state.sendMessageQueue = [{ scrollY: 800 }];

    const response = await dispatch({
      type: SCROLL_VIEWPORT,
      targetTabId: 7,
      top: 800,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(response).toEqual({ scrollY: 800 });
  });

  it('injects then retries when the receiver is missing', async () => {
    await loadWorker();
    state.sendMessageQueue = [undefined, { scrollY: 1600 }];

    const response = await dispatch({
      type: SCROLL_VIEWPORT,
      targetTabId: 7,
      top: 1600,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(state.executeScriptCalls).toBe(1);
    expect(response).toEqual({ scrollY: 1600 });
  });
});

describe('CAPTURE_VIEWPORT broker', () => {
  // The reason capture is brokered in the background at all: it captures using the pinned
  // tab's OWN windowId (resolved here), not WINDOW_ID_CURRENT from the panel document.
  it('captures the pinned tab using its resolved windowId and returns only a data URL', async () => {
    await loadWorker();
    state.captureDataUrl = 'data:image/png;base64,PIXELS';

    const response = await dispatch({
      type: CAPTURE_VIEWPORT,
      targetTabId: 7,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(state.captureCalls).toHaveLength(1);
    expect(state.captureCalls[0]?.windowId).toBe(3); // the tab's own window, never -2
    expect(response).toEqual({ dataUrl: 'data:image/png;base64,PIXELS' });
  });

  it('reports a restricted surface without attempting capture (fail closed)', async () => {
    await loadWorker();
    state.activeTab = { id: 7, url: 'chrome://settings', windowId: 3, active: true };
    state.pinnedTab = state.activeTab;

    const response = await dispatch({
      type: CAPTURE_VIEWPORT,
      targetTabId: 7,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(response).toEqual({ restricted: true });
    expect(state.captureCalls).toHaveLength(0);
  });

  it('reports TARGET_TAB_DISAPPEARED when the pinned tab no longer exists', async () => {
    await loadWorker();
    state.activeTab = undefined;
    state.pinnedTab = undefined;

    const response = await dispatch({
      type: CAPTURE_VIEWPORT,
      targetTabId: 7,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(response).toEqual({ error: 'TARGET_TAB_DISAPPEARED' });
    expect(state.captureCalls).toHaveLength(0);
  });

  it('forwards the Chrome capture-failure string (an API diagnostic, never pixels)', async () => {
    await loadWorker();
    state.captureError = { message: 'Cannot capture this tab' };

    const response = await dispatch({
      type: CAPTURE_VIEWPORT,
      targetTabId: 7,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(response).toEqual({ error: 'CAPTURE_FAILED' });
  });

  it('reports EMPTY_CAPTURE when the API returns no data URL', async () => {
    await loadWorker();
    state.captureDataUrl = undefined;
    state.captureError = undefined;

    const response = await dispatch({
      type: CAPTURE_VIEWPORT,
      targetTabId: 7,
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(response).toEqual({ error: 'EMPTY_CAPTURE' });
  });
});

describe('pinned tab isolation', () => {
  it('resolves once and never redirects a delayed action to a newly active tab', async () => {
    await loadWorker();
    expect(await dispatch({ type: RESOLVE_ACTIVE_TAB })).toEqual({ tabId: 7 });

    let releasePlanner!: () => void;
    const remotePlannerDelay = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const execution = remotePlannerDelay.then(() => dispatch({
      type: EXECUTE_ACTION,
      targetTabId: 7,
      action: { action: 'CLICK', target: 'CONTROL_1' },
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    }));

    state.activeTab = {
      id: 8,
      url: 'https://other.test/page',
      windowId: 3,
      active: true,
    };
    releasePlanner();
    const response = await execution;

    expect(response).toEqual({ ok: false, code: 'TARGET_TAB_CHANGED' });
    expect(state.sendMessageCalls).toHaveLength(0);
  });

  it('rejects execution when the pinned tab disappears', async () => {
    await loadWorker();
    state.activeTab = undefined;
    state.pinnedTab = undefined;

    const response = await dispatch({
      type: EXECUTE_ACTION,
      targetTabId: 7,
      action: { action: 'TYPE', target: 'CONTROL_1', value: 'safe' },
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });

    expect(response).toEqual({ ok: false, code: 'TARGET_TAB_DISAPPEARED' });
    expect(state.sendMessageCalls).toHaveLength(0);
  });
});
