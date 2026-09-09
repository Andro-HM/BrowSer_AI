// Local-only opaque control handles for content-script action execution.
//
// A handle is generated from scan order only. It deliberately contains no page-derived
// data, and the reverse map never crosses the content-script boundary. A later
// observation replaces the map, which makes the lifetime explicit and leaves room for a
// future observation-bound/stale-target contract without pretending it exists today.

import type { AgentAction, ControlHandle } from '../types/contracts';
import type { ExecuteActionResponse } from '../types/messages';

export type TargetedAgentAction = Extract<AgentAction, { target: string }>;

const CONTROL_HANDLE_PATTERN = /^CONTROL_[1-9]\d*$/;

/** Runtime guard shared by the action policy and local executor. */
export function isControlHandle(value: unknown): value is ControlHandle {
  return typeof value === 'string' && CONTROL_HANDLE_PATTERN.test(value);
}

/**
 * Per-document map owned only by the content script. `beginObservation` intentionally
 * invalidates prior handles: a planner may only act on the current scan's controls.
 */
export interface LocalControlRegistry {
  beginObservation(): void;
  register(element: Element): ControlHandle;
  resolve(handle: string): Element | undefined;
}

export function createLocalControlRegistry(): LocalControlRegistry {
  let next = 1;
  let controls = new Map<ControlHandle, Element>();

  return {
    beginObservation(): void {
      next = 1;
      controls = new Map<ControlHandle, Element>();
    },
    register(element: Element): ControlHandle {
      const handle = `CONTROL_${next++}` as ControlHandle;
      controls.set(handle, element);
      return handle;
    },
    resolve(handle: string): Element | undefined {
      return isControlHandle(handle) ? controls.get(handle) : undefined;
    },
  };
}

/** True when the resolved element is attached, rendered, and interactable. */
function isInteractable(element: Element): boolean {
  if (!element.isConnected) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Execute a targeted action against an element obtained only from the local registry.
 * There is deliberately no CSS parsing or `querySelector` fallback here: an unknown
 * handle fails closed instead of becoming an arbitrary page-controlled selector.
 */
export function executeControlAction(
  action: TargetedAgentAction,
  controls: LocalControlRegistry,
): ExecuteActionResponse {
  const element = controls.resolve(action.target);
  if (!element) return { ok: false, code: 'CONTROL_UNKNOWN' };
  if (!isInteractable(element)) return { ok: false, code: 'NOT_VISIBLE' };

  if (action.action === 'CLICK') {
    if ((element as HTMLButtonElement).disabled) return { ok: false, code: 'DISABLED' };
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true, code: 'OK' };
  }

  if (action.action === 'TYPE') {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled || element.readOnly) return { ok: false, code: 'DISABLED' };
      element.scrollIntoView({ block: 'center', behavior: 'auto' });
      element.value = action.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, code: 'OK' };
    }
    return { ok: false, code: 'UNSUPPORTED' };
  }

  if (action.action === 'SELECT') {
    if (element instanceof HTMLSelectElement) {
      if (element.disabled) return { ok: false, code: 'DISABLED' };
      element.scrollIntoView({ block: 'center', behavior: 'auto' });
      const option = Array.from(element.options).find((candidate) => candidate.value === action.value);
      if (!option) return { ok: false, code: 'NO_SUCH_OPTION' };
      element.value = action.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, code: 'OK' };
    }
    return { ok: false, code: 'UNSUPPORTED' };
  }

  return { ok: false, code: 'UNSUPPORTED' };
}
