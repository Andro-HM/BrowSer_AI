import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalControlRegistry, executeControlAction } from '../../extension/src/content/controls';

class FakeElement {
  isConnected = true;
  disabled = false;
  scrolled = false;
  events: string[] = [];
  getBoundingClientRect() { return { width: 100, height: 32 }; }
  scrollIntoView() { this.scrolled = true; }
  dispatchEvent(event: { type: string }) { this.events.push(event.type); return true; }
}
class FakeInput extends FakeElement { value = ''; readOnly = false; }
class FakeEvent { constructor(readonly type: string) {} }

beforeEach(() => {
  vi.stubGlobal('window', { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLTextAreaElement', FakeInput);
  vi.stubGlobal('HTMLSelectElement', class {});
  vi.stubGlobal('Event', FakeEvent);
  vi.stubGlobal('MouseEvent', FakeEvent);
});
afterEach(() => vi.unstubAllGlobals());

describe('opaque local control handles', () => {
  it('issues scan-local handles without page-derived text', () => {
    const controls = createLocalControlRegistry({
      documentGeneration: 'document-1',
      nextObservationEpoch: () => 'observation-1',
    });
    const observation = controls.beginObservation();
    const first = controls.register(new FakeInput() as unknown as Element);
    const second = controls.register(new FakeInput() as unknown as Element);
    expect([first, second]).toEqual(['CONTROL_1', 'CONTROL_2']);
    expect(observation).toEqual({
      observationEpoch: 'observation-1',
      documentGeneration: 'document-1',
    });
    expect(JSON.stringify([first, second])).not.toContain('example.test');
  });

  it('executes a current observed control and rejects invented or stale handles', () => {
    let epoch = 0;
    const controls = createLocalControlRegistry({
      documentGeneration: 'document-1',
      nextObservationEpoch: () => `observation-${++epoch}`,
    });
    const input = new FakeInput();
    const firstObservation = controls.beginObservation();
    const handle = controls.register(input as unknown as Element);
    expect(executeControlAction(
      { action: 'TYPE', target: handle, value: 'safe' },
      controls,
      firstObservation,
    )).toEqual({ ok: true, code: 'OK' });
    expect(input.value).toBe('safe');
    expect(executeControlAction(
      { action: 'CLICK', target: handle },
      controls,
      firstObservation,
    )).toEqual({ ok: true, code: 'OK' });
    expect(input.events).toContain('click');
    expect(executeControlAction({ action: 'CLICK', target: 'CONTROL_999' }, controls, firstObservation)).toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
    expect(executeControlAction({ action: 'CLICK', target: '[name="CANARY_EMAIL_001@example.test"]' }, controls, firstObservation)).toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
    controls.beginObservation();
    expect(executeControlAction({ action: 'CLICK', target: handle }, controls, firstObservation)).toEqual({ ok: false, code: 'OBSERVATION_STALE' });
  });

  it('invalidates on registry reset and rejects handles from a navigated/new document', () => {
    const controls = createLocalControlRegistry({
      documentGeneration: 'document-1',
      nextObservationEpoch: () => 'observation-1',
    });
    const observation = controls.beginObservation();
    const handle = controls.register(new FakeInput() as unknown as Element);

    controls.invalidate();
    expect(executeControlAction({ action: 'CLICK', target: handle }, controls, observation)).toEqual({ ok: false, code: 'OBSERVATION_STALE' });

    const newDocument = createLocalControlRegistry({
      documentGeneration: 'document-2',
      nextObservationEpoch: () => 'observation-2',
    });
    newDocument.beginObservation();
    expect(executeControlAction({ action: 'CLICK', target: handle }, newDocument, observation)).toEqual({ ok: false, code: 'DOCUMENT_CHANGED' });
  });
});
