// Local-only opaque control handles. The remote planner never sees a selector,
// id, name, or element reference; this registry is owned by the content script.

import { isControlHandle, type AgentAction } from '../types/contracts';
import type { ExecuteActionResponse } from '../types/messages';

type TargetedAction = Extract<AgentAction, { target: string }>;

export interface LocalControlRegistry {
  beginObservation(): void;
  register(element: Element): string;
  resolve(handle: string): Element | undefined;
}

export function createLocalControlRegistry(): LocalControlRegistry {
  let next = 1;
  let controls = new Map<string, Element>();
  return {
    beginObservation(): void {
      next = 1;
      controls = new Map();
    },
    register(element: Element): string {
      const handle = `CONTROL_${next++}`;
      controls.set(handle, element);
      return handle;
    },
    resolve(handle: string): Element | undefined {
      return isControlHandle(handle) ? controls.get(handle) : undefined;
    },
  };
}

function isInteractable(element: Element): boolean {
  if (!element.isConnected) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Execute only an element resolved from the current observation's local registry. */
export function executeControlAction(
  action: TargetedAction,
  controls: LocalControlRegistry,
): ExecuteActionResponse {
  const element = controls.resolve(action.target);
  if (element === undefined) return { ok: false, code: 'CONTROL_UNKNOWN' };
  if (!isInteractable(element)) return { ok: false, code: 'NOT_VISIBLE' };
  if (action.action === 'CLICK') {
    if ((element as HTMLButtonElement).disabled) return { ok: false, code: 'DISABLED' };
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true, code: 'OK' };
  }
  if (action.action === 'TYPE') {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return { ok: false, code: 'UNSUPPORTED' };
    if (element.disabled || element.readOnly) return { ok: false, code: 'DISABLED' };
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.value = action.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, code: 'OK' };
  }
  if (action.action === 'SELECT') {
    if (!(element instanceof HTMLSelectElement)) return { ok: false, code: 'UNSUPPORTED' };
    if (element.disabled) return { ok: false, code: 'DISABLED' };
    if (!Array.from(element.options).some((candidate) => candidate.value === action.value)) return { ok: false, code: 'NO_SUCH_OPTION' };
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.value = action.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, code: 'OK' };
  }
  return { ok: false, code: 'UNSUPPORTED' };
}
