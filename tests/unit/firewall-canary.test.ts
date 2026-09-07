// Master §11/§19 — firewall canary matrix.
//
// One synthetic canary per protected-data class is pushed at the SINGLE egress boundary,
// and the boundary must refuse it. The canaries are deliberately fake constants
// (CANARY_*), so a hit anywhere downstream is unambiguous evidence of a leak rather than
// a coincidence — and so these tests never depend on a real user's data.
//
// The positive control matters as much as the negatives: if SANITIZED_CONTEXT were also
// blocked, the matrix would "pass" while the product did nothing.

import { describe, expect, it } from 'vitest';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { DEFAULT_PRIVACY_MODE } from '../../extension/src/policy/modes';
import type { RemoteAgentRequest } from '../../extension/src/types/contracts';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';
const CANARY_PASSWORD = 'CANARY_PASSWORD_001';
const CANARY_CARD = '4111 1111 1111 1111';
const CANARY_PHONE = '555-123-4567';
/** A real (tiny) PNG data URL — the shape a `captureVisibleTab` result actually has. */
const CANARY_SCREENSHOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** A well-formed, genuinely sanitized request: the positive control. */
function sanitizedRequest(): RemoteAgentRequest {
  return {
    taskObjective: 'fill the checkout form and continue',
    pageOrigin: 'https://shop.example.test',
    sanitizedPageStructure: [
      { tag: 'input', selector: '#email', inputType: 'email', label: 'Email', filled: false, disabled: false },
      { tag: 'button', selector: '#pay', label: 'Pay now', filled: false, disabled: false },
    ],
    sanitizedVisibleText: 'Checkout. Email: USER_EMAIL_1. Card: USER_PAYMENT_1. Total 42.00',
    aliases: [
      { alias: 'USER_EMAIL_1', category: 'EMAIL' },
      { alias: 'USER_PAYMENT_1', category: 'PAYMENT' },
    ],
    availableActions: ['TYPE', 'CLICK', 'SCROLL'],
    policy: { privacyMode: DEFAULT_PRIVACY_MODE, navigationAllowlist: ['https://shop.example.test'] },
  };
}

const firewall = createPrivacyFirewall();

describe('firewall canary matrix (master §11)', () => {
  it('ALLOWS a genuinely sanitized context (positive control)', async () => {
    const verdict = await firewall.inspect(sanitizedRequest());
    expect(verdict).toEqual({ allowed: true, reason: 'OK' });
  });

  it('BLOCKS RAW_EMAIL in the visible text', async () => {
    const request = { ...sanitizedRequest(), sanitizedVisibleText: `Signed in as ${CANARY_EMAIL}` };
    const verdict = await firewall.inspect(request);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('FIREWALL_PII_DETECTED');
  });

  it('BLOCKS RAW_PHONE in the visible text', async () => {
    const request = { ...sanitizedRequest(), sanitizedVisibleText: `Call ${CANARY_PHONE}` };
    expect((await firewall.inspect(request)).allowed).toBe(false);
  });

  it('BLOCKS RAW_CREDENTIAL (a labelled password) in the visible text', async () => {
    const request = {
      ...sanitizedRequest(),
      sanitizedVisibleText: `Password: ${CANARY_PASSWORD}`,
    };
    expect((await firewall.inspect(request)).allowed).toBe(false);
  });

  it('BLOCKS RAW_PAYMENT in the visible text', async () => {
    const request = { ...sanitizedRequest(), sanitizedVisibleText: `Card ${CANARY_CARD}` };
    expect((await firewall.inspect(request)).allowed).toBe(false);
  });

  it('BLOCKS RAW_OCR_PII — recognized text is scanned like any other string', async () => {
    // The leak this guards against is upstream code copying an OCR finding's `text` into
    // the payload. To the firewall it is just a string, and that is the point.
    const request = {
      ...sanitizedRequest(),
      sanitizedVisibleText: `OCR read: ${CANARY_EMAIL} on the ID card image`,
    };
    expect((await firewall.inspect(request)).allowed).toBe(false);
  });

  it('BLOCKS RAW_EMAIL smuggled through a node label', async () => {
    const request = sanitizedRequest();
    request.sanitizedPageStructure[0]!.label = CANARY_EMAIL;
    expect((await firewall.inspect(request)).allowed).toBe(false);
  });

  it('BLOCKS RAW_SCREENSHOT in an extra field', async () => {
    const request = { ...sanitizedRequest(), screenshot: CANARY_SCREENSHOT };
    const verdict = await firewall.inspect(request as RemoteAgentRequest);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('FIREWALL_UNEXPECTED_FIELD');
  });

  it('BLOCKS RAW_SCREENSHOT smuggled into the visible text', async () => {
    // No PII pattern matches base64, so the content scan cannot catch this one — the
    // pixel-payload check must. Without it, a capture rides out through a legal field.
    const request = {
      ...sanitizedRequest(),
      sanitizedVisibleText: `Checkout page. ${CANARY_SCREENSHOT}`,
    };
    const verdict = await firewall.inspect(request);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('FIREWALL_PIXEL_PAYLOAD');
  });

  it('BLOCKS RAW_SCREENSHOT smuggled into the task objective', async () => {
    const request = { ...sanitizedRequest(), taskObjective: `describe ${CANARY_SCREENSHOT}` };
    expect((await firewall.inspect(request)).reason).toBe('FIREWALL_PIXEL_PAYLOAD');
  });

  it('BLOCKS RAW_SCREENSHOT smuggled into a node label', async () => {
    const request = sanitizedRequest();
    request.sanitizedPageStructure[1]!.label = CANARY_SCREENSHOT;
    expect((await firewall.inspect(request)).reason).toBe('FIREWALL_PIXEL_PAYLOAD');
  });

  it('does not mistake ordinary prose for a pixel payload', async () => {
    // The pixel check must not become a second, sloppier PII filter: talking ABOUT an
    // image is not shipping one.
    const request = {
      ...sanitizedRequest(),
      taskObjective: 'click the base64 decoder image on the data page',
    };
    expect((await firewall.inspect(request)).allowed).toBe(true);
  });

  it('BLOCKS a value-shaped alias (an alias must be a TYPE, never a value)', async () => {
    const request = {
      ...sanitizedRequest(),
      aliases: [{ alias: CANARY_EMAIL, category: 'EMAIL' as const }],
    };
    const verdict = await firewall.inspect(request);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('FIREWALL_BAD_ALIAS');
  });
});
