// The diagnostic tracer is the one place in the extension that writes to the console, so
// it is also the one place where a careless caller could put recognized text in front of
// a developer who has the panel console open on a real page (master §19). These tests
// pin the sanitizer, not the formatting.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ocrTrace } from '../../../extension/src/diag/ocr-trace';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Captures the `detail` object as the console actually received it. */
function captureInfo() {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  return () => spy.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
}

describe('ocrTrace detail sanitization', () => {
  it('passes short codes, counts and flags through untouched', () => {
    const lastDetail = captureInfo();
    ocrTrace('OCR_RESULT', { regionId: 'r3', analyzer: 'tesseract', lines: 4, ok: true });

    expect(lastDetail()).toEqual({ regionId: 'r3', analyzer: 'tesseract', lines: 4, ok: true });
  });

  it('replaces a capture data URL instead of truncating it', () => {
    const lastDetail = captureInfo();
    ocrTrace('PIXEL_DATA_VALID', { detail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' });

    // Truncation would still print a prefix of the payload; replacement prints none.
    expect(lastDetail()).toEqual({ detail: 'redacted_pixel_like' });
  });

  it('flags a bare base64 blob even without a data: prefix', () => {
    const lastDetail = captureInfo();
    ocrTrace('CAPTURE_SUCCESS', { detail: 'decoded base64 payload of 200KB' });

    expect(lastDetail()).toEqual({ detail: 'redacted_pixel_like' });
  });

  it('truncates long free text so recognized content cannot ride out whole', () => {
    const lastDetail = captureInfo();
    const recognized = `CANARY_EMAIL_001@example.test ${'x'.repeat(400)}`;
    ocrTrace('OCR_RESULT', { detail: recognized });

    const detail = lastDetail()?.['detail'];
    expect(typeof detail).toBe('string');
    expect(String(detail).length).toBeLessThan(recognized.length);
    expect(String(detail)).toContain('[truncated]');
  });

  it('routes degradations to warn, never to error (the smoke check asserts no errors)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    ocrTrace('VISION_MODEL_UNAVAILABLE', { reason: 'asset_missing' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});
