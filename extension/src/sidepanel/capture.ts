// Panel-side capture bridge for the M3 visual service.
//
// WHY THIS EXISTS: `chrome.tabs.captureVisibleTab` must be called with the web page's own
// window id. From a side-panel document `WINDOW_ID_CURRENT` (-2) does not reliably resolve
// to that window, so a panel-local capture fails with VISUAL_CAPTURE_UNAVAILABLE even on an
// ordinary page. We therefore broker the capture through the background worker (which
// resolves the active tab reliably) and receive back ONLY the resulting PNG data URL, which
// the panel then rasterizes/crops locally. The data URL never leaves the device.
//
// The service's `captureViewport` dep is expected to RESOLVE with a data URL or THROW; the
// service turns a throw into a single structured `VISUAL_CAPTURE_UNAVAILABLE`. We throw an
// Error whose message is a short, non-sensitive diagnostic (a structured code or Chrome's
// own capture-failure string) so the real cause is visible in the trace — never pixels.

import {
  CAPTURE_VIEWPORT,
  SCROLL_VIEWPORT,
  type CaptureViewportResponse,
  type ScrollViewportResponse,
} from '../types/messages';

export async function captureViaBackground(): Promise<string> {
  const response: CaptureViewportResponse = await chrome.runtime.sendMessage({
    type: CAPTURE_VIEWPORT,
  });
  if (response?.dataUrl !== undefined) return response.dataUrl;
  // Restricted or errored: throw a short diagnostic (no pixels) for the service to surface.
  throw new Error(response?.restricted ? 'RESTRICTED' : (response?.error ?? 'CAPTURE_FAILED'));
}

/** Milliseconds allowed for a revealed band to paint (and lazy images to load). */
export const BAND_SETTLE_MS = 150;

/**
 * Scroll the active tab to document y `top` for bounded below-the-fold band capture, then
 * let layout/lazy content settle before the caller captures. Relayed through the background
 * worker; carries only an offset — never content. Injected into the M3 service, which
 * inspects ONLY the visible viewport when this dependency is absent (an honest limit, not a
 * silent gap). Throws a short diagnostic so the service degrades that band closed.
 */
export async function scrollViaBackground(top: number): Promise<void> {
  const response: ScrollViewportResponse = await chrome.runtime.sendMessage({
    type: SCROLL_VIEWPORT,
    top,
  });
  if (response?.error !== undefined) throw new Error(response.error);
  await new Promise((resolve) => setTimeout(resolve, BAND_SETTLE_MS));
}
