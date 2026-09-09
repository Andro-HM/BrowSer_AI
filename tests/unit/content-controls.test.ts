import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalControlRegistry,
  executeControlAction,
  isControlHandle,
} from '../../extension/src/content/controls';

class FakeElement {
  isConnected = true;
  disabled = false;
  dispatched: string[] = [];
  scrolled = false;

  getBoundingClientRect() {
    return { width: 120, height: 32 };
  }

  scrollIntoView() {
    this.scrolled = true;
  }

  dispatchEvent(event: { type: string }) {
    this.dispatched.push(event.type);
    return true;
  }
}

class FakeInput extends FakeElement {
  value = '';
  readOnly = false;
}

class FakeTextarea extends FakeInput {}

class FakeSelect extends FakeElement {
  value = '';
  options = [{ value: 'one' }, { value: 'two' }];
}

class FakeEvent {
  constructor(readonly type: string) {}
}

beforeEach(() => {
  vi.stubGlobal('window', {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextarea);
  vi.stubGlobal('HTMLSelectElement', FakeSelect);
  vi.stubGlobal('Event', FakeEvent);
  vi.stubGlobal('MouseEvent', FakeEvent);
});

afterEach(() => vi.unstubAllGlobals());

describe('local opaque control registry', () => {
  it('issues distinct scan-local handles with no page-derived grammar', () => {
    const controls = createLocalControlRegistry();
    const email = new FakeInput();
    const password = new FakeInput();
    controls.beginObservation();
    const first = controls.register(email as unknown as Element);
    const second = controls.register(password as unknown as Element);

    expect(first).toBe('CONTROL_1');
    expect(second).toBe('CONTROL_2');
    expect(first).not.toBe(second);
    expect(isControlHandle(first)).toBe(true);
    expect(isControlHandle('CONTROL_alice@example.test')).toBe(false);
    expect(isControlHandle('[name="CANARY_PASSWORD_001"]')).toBe(false);
    expect(controls.resolve(first)).toBe(email);
    expect(controls.resolve(second)).toBe(password);
  });

  it('replaces the mapping on the next observation', () => {
    const controls = createLocalControlRegistry();
    controls.beginObservation();
    const prior = controls.register(new FakeInput() as unknown as Element);
    controls.beginObservation();
    expect(controls.resolve(prior)).toBeUndefined();
  });

  it('clicks only the element resolved from the local handle', () => {
    const controls = createLocalControlRegistry();
    const button = new FakeElement();
    controls.beginObservation();
    const handle = controls.register(button as unknown as Element);

    expect(executeControlAction({ action: 'CLICK', target: handle }, controls)).toEqual({ ok: true, code: 'OK' });
    expect(button.scrolled).toBe(true);
    expect(button.dispatched).toEqual(['click']);
  });

  it('types only into the input resolved from the local handle', () => {
    const controls = createLocalControlRegistry();
    const input = new FakeInput();
    controls.beginObservation();
    const handle = controls.register(input as unknown as Element);

    expect(executeControlAction({ action: 'TYPE', target: handle, value: 'safe value' }, controls))
      .toEqual({ ok: true, code: 'OK' });
    expect(input.value).toBe('safe value');
    expect(input.dispatched).toEqual(['input', 'change']);
  });

  it('selects only in the select resolved from the local handle', () => {
    const controls = createLocalControlRegistry();
    const select = new FakeSelect();
    controls.beginObservation();
    const handle = controls.register(select as unknown as Element);

    expect(executeControlAction({ action: 'SELECT', target: handle, value: 'two' }, controls))
      .toEqual({ ok: true, code: 'OK' });
    expect(select.value).toBe('two');
    expect(select.dispatched).toEqual(['input', 'change']);
  });

  it('fails closed for an unknown or selector-like target', () => {
    const controls = createLocalControlRegistry();
    controls.beginObservation();
    expect(executeControlAction({ action: 'CLICK', target: 'CONTROL_99' }, controls))
      .toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
    expect(executeControlAction({ action: 'CLICK', target: '#submit' }, controls))
      .toEqual({ ok: false, code: 'CONTROL_UNKNOWN' });
  });
});
