// One shared side-panel visual service for manual scans and agent runs.

import { createVisualPerceptionService, type VisualPerceptionService } from '../perception/visual';
import { SCROLL_VIEWPORT, type ScrollViewportResponse } from '../types/messages';
import { captureViaBackground } from './capture';

async function scrollViewport(top: number): Promise<void> {
  const response: ScrollViewportResponse = await chrome.runtime.sendMessage({ type: SCROLL_VIEWPORT, top });
  if (response?.error !== undefined) throw new Error(response.error);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

let service: VisualPerceptionService | null = null;
export function getVisualService(): VisualPerceptionService {
  service ??= createVisualPerceptionService({ captureViewport: captureViaBackground, scrollViewport });
  return service;
}
