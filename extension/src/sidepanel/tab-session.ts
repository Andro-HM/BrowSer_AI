// One panel operation resolves its target once and carries that tab id through every
// browser message. Observation identity remains local and is never added to planner data.

import type { AgentAction } from '../types/contracts';
import {
  CAPTURE_VIEWPORT,
  EXECUTE_ACTION,
  RESOLVE_ACTIVE_TAB,
  SCAN_PAGE,
  SCROLL_VIEWPORT,
  type CaptureViewportResponse,
  type ExecuteActionResponse,
  type ObservationContext,
  type ResolveActiveTabResponse,
  type ScanPageResponse,
  type ScrollViewportResponse,
} from '../types/messages';

export interface PinnedTabSession {
  readonly tabId: number;
  scan(): Promise<ScanPageResponse>;
  capture(observation: ObservationContext): Promise<string>;
  scroll(top: number, observation: ObservationContext): Promise<void>;
  execute(action: AgentAction, observation: ObservationContext): Promise<ExecuteActionResponse>;
}

export async function pinActiveTab(): Promise<ResolveActiveTabResponse> {
  const response: ResolveActiveTabResponse | undefined = await chrome.runtime.sendMessage({
    type: RESOLVE_ACTIVE_TAB,
  });
  return response ?? { error: 'NO_ACTIVE_TAB' };
}

export function createPinnedTabSession(tabId: number): PinnedTabSession {
  return {
    tabId,
    scan: () => chrome.runtime.sendMessage({ type: SCAN_PAGE, targetTabId: tabId }) as Promise<ScanPageResponse>,
    async capture(observation): Promise<string> {
      const response: CaptureViewportResponse = await chrome.runtime.sendMessage({
        type: CAPTURE_VIEWPORT,
        targetTabId: tabId,
        ...observation,
      });
      if (response?.dataUrl !== undefined) return response.dataUrl;
      throw new Error(response?.restricted ? 'RESTRICTED' : (response?.error ?? 'CAPTURE_FAILED'));
    },
    async scroll(top, observation): Promise<void> {
      const response: ScrollViewportResponse = await chrome.runtime.sendMessage({
        type: SCROLL_VIEWPORT,
        targetTabId: tabId,
        top,
        ...observation,
      });
      if (response?.error !== undefined) throw new Error(response.error);
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    async execute(action, observation): Promise<ExecuteActionResponse> {
      const response: ExecuteActionResponse | undefined = await chrome.runtime.sendMessage({
        type: EXECUTE_ACTION,
        targetTabId: tabId,
        action,
        ...observation,
      });
      return response ?? { ok: false, code: 'EXEC_FAILED' };
    },
  };
}
