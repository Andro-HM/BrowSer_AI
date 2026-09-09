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
    const controls = createLocalControlRegistry();
    controls.beginObservation();
    const first = controls.register(new FakeInput() as unknown as Element);
    const second = controls.register(new FakeInput() as unknown as Element);
    expect([first, second]).toEqual(['CONTROL_1', 'CONTROL_2']);
    expect(JSON.stringify([first, second])).not.toContain('example.test');
  });

  it('executes a current observed control and rejects invented or stale handles', () => {
    const controls = createLocalControlRegistry();
    const input = new FakeInput();
    controls.beginObservation();
    const handle = controls.register(input as unknown as Element);
    expect(executeControlAction({ action: 'TYPE', target: handle, value: 'safe' }, controls)).toEqual({ ok: true, code: 'OK' });
    expect(input.value).toBe('safe');
    expect(executeControlAction({ action: 'CLICK', target: 'CONTROL_999' }, controls)).toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
    expect(executeControlAction({ action: 'CLICK', target: '[name="CANARY_EMAIL_001@example.test"]' }, controls)).toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
    controls.beginObservation();
    expect(executeControlAction({ action: 'CLICK', target: handle }, controls)).toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
  });
});
