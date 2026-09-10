// PrivAgent background service worker.
// Brokers messages between the side panel and an explicitly pinned tab. It holds no page content:
// SCAN_PAGE / SCROLL_VIEWPORT are relayed to the content script, which returns only
// structured inputs (SCAN_PAGE) or a scroll offset (SCROLL_VIEWPORT).
//
// ROBUST DELIVERY: declared content scripts only auto-inject into pages loaded AFTER the
// extension, so a tab opened earlier (or one whose async content-script loader has not yet
// registered its listener) has no receiver and `sendMessage` fails with `lastError`. Rather
// than surface PAGE_UNREACHABLE immediately, we inject the content script on demand with
// `chrome.scripting.executeScript` (using our `scripting` + http/https `host_permissions`,
// no extra grant needed) and retry. PAGE_UNREACHABLE is reported ONLY when injection itself
// is refused — i.e. the browser genuinely forbids access (fail closed, CONTRIBUTING.md §5 Rule 7).

import { isRestrictedUrl } from '../perception/visual/restricted';
import {
  CAPTURE_VIEWPORT,
  EXECUTE_ACTION,
  RESOLVE_ACTIVE_TAB,
  SCAN_PAGE,
  SCROLL_VIEWPORT,
  VALIDATE_OBSERVATION,
  type CaptureViewportResponse,
  type ExecuteActionResponse,
  type ScanPageResponse,
  type ScrollViewportResponse,
} from '../types/messages';
import { registerVisualPerceptionMessages } from './visual-messages';

chrome.runtime.onInstalled.addListener(() => {
  // Open the side panel when the toolbar action is clicked.
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

/** Send a message to a tab, resolving the response (or `undefined` on `lastError`). */
function sendToTab<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response?: T) => {
      // Reading lastError marks it handled; we never forward its text (may echo the URL).
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

/**
 * Ensure the content script is present in `tabId` by injecting the built content-script
 * file(s) listed in the manifest. Returns true on success. Uses `scripting` +
 * `host_permissions`; the browser refuses on pages it protects (→ false → fail closed).
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the explicitly pinned target and ensure the user has not switched away from it.
 * Fixed codes only: Chrome errors can contain URLs, so they never cross this boundary.
 */
async function getPinnedActiveTab(targetTabId: unknown): Promise<chrome.tabs.Tab | string> {
  if (!Number.isInteger(targetTabId) || (targetTabId as number) < 0) return 'TARGET_TAB_REQUIRED';
  try {
    const tab = await chrome.tabs.get(targetTabId as number);
    if (tab.id === undefined) return 'TARGET_TAB_DISAPPEARED';
    if (tab.active !== true) return 'TARGET_TAB_CHANGED';
    if (isRestrictedUrl(tab.url ?? '')) return 'RESTRICTED';
    return tab;
  } catch {
    return 'TARGET_TAB_DISAPPEARED';
  }
}

/**
 * Relay `message` to the pinned tab, injecting the content script on demand if the first
 * attempt finds no receiver. `onMissing` builds the fail-closed response used when the tab
 * is absent, restricted, or genuinely unreachable.
 */
async function relayToPinnedTab<T>(
  targetTabId: unknown,
  message: unknown,
  isMissing: (response: T | undefined) => boolean,
  fail: (code: string) => T,
): Promise<T> {
  const target = await getPinnedActiveTab(targetTabId);
  if (typeof target === 'string') return fail(target);
  const tabId = target.id as number;

  let response = await sendToTab<T>(tabId, message);
  if (isMissing(response)) {
    // No receiver yet — inject the content script and retry once it has settled.
    const injected = await injectContentScript(tabId);
    if (!injected) return fail('PAGE_UNREACHABLE');
    // The built content script registers its listener from an async dynamic import; give
    // it a couple of short attempts to settle before giving up.
    for (let attempt = 0; attempt < 3 && isMissing(response); attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const stillTargeted = await getPinnedActiveTab(tabId);
      if (typeof stillTargeted === 'string') return fail(stillTargeted);
      response = await sendToTab<T>(tabId, message);
    }
    if (isMissing(response)) return fail('PAGE_UNREACHABLE');
  }
  return response as T;
}

/**
 * Capture the pinned tab's visible viewport as a PNG data URL, resolving the tab's OWN
 * `windowId` first. This is the reason capture is brokered here rather than run in the
 * side panel: from a panel document `WINDOW_ID_CURRENT` (-2) does not reliably resolve to
 * the window that holds the web page, so `captureVisibleTab` there fails on ordinary pages.
 * The background worker verifies the pinned tab (same target as SCAN_PAGE).
 * The returned data URL is local only — it is handed straight back to the panel for local
 * rasterization and never leaves the device.
 */
async function capturePinnedViewport(
  targetTabId: unknown,
  observationEpoch: unknown,
  documentGeneration: unknown,
): Promise<CaptureViewportResponse> {
  const target = await getPinnedActiveTab(targetTabId);
  if (typeof target === 'string') {
    return target === 'RESTRICTED' ? { restricted: true } : { error: target };
  }
  if (target.id === undefined || target.windowId === undefined) return { error: 'TARGET_TAB_DISAPPEARED' };

  const validity = await sendToTab<ExecuteActionResponse>(target.id, {
    type: VALIDATE_OBSERVATION,
    observationEpoch,
    documentGeneration,
  });
  if (validity?.ok !== true) return { error: validity?.code ?? 'OBSERVATION_STALE' };

  const activeBefore = await chrome.tabs.query({ active: true, windowId: target.windowId });
  if (activeBefore[0]?.id !== target.id) return { error: 'TARGET_TAB_CHANGED' };

  return new Promise((resolve) => {
      chrome.tabs.captureVisibleTab(target.windowId, { format: 'png' }, (dataUrl) => {
        // Chrome error strings can contain a URL, so expose only a fixed diagnostic.
        // `dataUrl` is local only.
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ error: 'CAPTURE_FAILED' });
          return;
        }
        if (!dataUrl) {
          resolve({ error: 'EMPTY_CAPTURE' });
          return;
        }
        void chrome.tabs.query({ active: true, windowId: target.windowId }).then((activeAfter) => {
          if (activeAfter[0]?.id !== target.id) {
            resolve({ error: 'TARGET_TAB_CHANGED' });
            return;
          }
          resolve({ dataUrl });
        });
      });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === RESOLVE_ACTIVE_TAB) {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (tab?.id === undefined) {
        sendResponse({ error: 'NO_ACTIVE_TAB' });
      } else if (isRestrictedUrl(tab.url ?? '')) {
        sendResponse({ restricted: true });
      } else {
        sendResponse({ tabId: tab.id });
      }
    });
    return true;
  }

  if (message?.type === SCAN_PAGE) {
    void relayToPinnedTab<ScanPageResponse>(
      message.targetTabId,
      { type: SCAN_PAGE },
      // A missing receiver yields `undefined`; a real scan always has pageText or an error.
      (response) => response === undefined,
      (code) => (code === 'RESTRICTED' ? { restricted: true } : { error: code }),
    ).then(sendResponse);
    return true; // async sendResponse
  }

  if (message?.type === SCROLL_VIEWPORT) {
    void relayToPinnedTab<ScrollViewportResponse>(
      message.targetTabId,
      {
        type: SCROLL_VIEWPORT,
        top: message.top,
        observationEpoch: message.observationEpoch,
        documentGeneration: message.documentGeneration,
      },
      (response) => response === undefined,
      (code) => ({ error: code }),
    ).then(sendResponse);
    return true; // async sendResponse
  }

  if (message?.type === CAPTURE_VIEWPORT) {
    void capturePinnedViewport(
      message.targetTabId,
      message.observationEpoch,
      message.documentGeneration,
    ).then(sendResponse);
    return true; // async sendResponse
  }

  // M6 — execute one validated structured action in the pinned tab. The action has
  // already passed schema + policy validation and LOCAL alias resolution before it is
  // relayed; the worker adds no interpretation and forwards structured codes only.
  if (message?.type === EXECUTE_ACTION) {
    void relayToPinnedTab<ExecuteActionResponse>(
      message.targetTabId,
      {
        type: EXECUTE_ACTION,
        action: message.action,
        observationEpoch: message.observationEpoch,
        documentGeneration: message.documentGeneration,
      },
      (response) => response === undefined,
      (code) => ({ ok: false, code }),
    ).then(sendResponse);
    return true; // async sendResponse
  }

  return undefined;
});

// M3: additional message type on the same runtime channel (see visual-messages.ts).
registerVisualPerceptionMessages();

export {};
