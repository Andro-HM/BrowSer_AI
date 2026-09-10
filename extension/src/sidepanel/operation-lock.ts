import { useSyncExternalStore } from 'react';

export type PanelOperation = 'agent' | 'scan' | 'visual';

let activeOperation: PanelOperation | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function tryAcquirePanelOperation(operation: PanelOperation): (() => void) | null {
  if (activeOperation !== null) return null;
  activeOperation = operation;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeOperation === operation) {
      activeOperation = null;
      emit();
    }
  };
}

export function getActivePanelOperation(): PanelOperation | null {
  return activeOperation;
}

export function subscribePanelOperation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelOperationBusy(): boolean {
  return useSyncExternalStore(
    subscribePanelOperation,
    () => getActivePanelOperation() !== null,
    () => false,
  );
}
