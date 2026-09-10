// Local-only opaque control handles. The remote planner never sees a selector,
// id, name, or element reference; this registry is owned by the content script.

import { isControlHandle, type AgentAction } from '../types/contracts';
import type { ExecuteActionResponse, ObservationContext } from '../types/messages';

type TargetedAction = Extract<AgentAction, { target: string }>;

export interface LocalControlRegistry {
  beginObservation(): ObservationContext;
  invalidate(): void;
  register(element: Element): string;
  validate(expected: ObservationContext): ExecuteActionResponse;
  resolve(handle: string, expected: ObservationContext): Element | undefined;
}

export interface LocalControlRegistryOptions {
  documentGeneration?: string;
  nextObservationEpoch?: () => string;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function createLocalControlRegistry(
  options: LocalControlRegistryOptions = {},
): LocalControlRegistry {
  const documentGeneration = options.documentGeneration ?? opaqueId('DOCUMENT');
  const nextObservationEpoch = options.nextObservationEpoch ?? (() => opaqueId('OBSERVATION'));
  let next = 1;
  let observationEpoch: string | undefined;
  let controls = new Map<string, { element: Element; observationEpoch: string }>();

  const validate = (expected: ObservationContext): ExecuteActionResponse => {
    if (expected.documentGeneration !== documentGeneration) {
      return { ok: false, code: 'DOCUMENT_CHANGED' };
    }
    if (observationEpoch === undefined || expected.observationEpoch !== observationEpoch) {
      return { ok: false, code: 'OBSERVATION_STALE' };
    }
    return { ok: true, code: 'OK' };
  };

  return {
    beginObservation(): ObservationContext {
      next = 1;
      controls = new Map();
      observationEpoch = nextObservationEpoch();
      return { observationEpoch, documentGeneration };
    },
    invalidate(): void {
      next = 1;
      controls = new Map();
      observationEpoch = undefined;
    },
    register(element: Element): string {
      if (observationEpoch === undefined) throw new Error('OBSERVATION_REQUIRED');
      const handle = `CONTROL_${next++}`;
      controls.set(handle, { element, observationEpoch });
      return handle;
    },
    validate,
    resolve(handle: string, expected: ObservationContext): Element | undefined {
      if (!validate(expected).ok || !isControlHandle(handle)) return undefined;
      const entry = controls.get(handle);
      return entry?.observationEpoch === expected.observationEpoch ? entry.element : undefined;
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
  expected: ObservationContext,
): ExecuteActionResponse {
  const validity = controls.validate(expected);
  if (!validity.ok) return validity;
  const element = controls.resolve(action.target, expected);
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
