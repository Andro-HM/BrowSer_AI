// Indian PII detectors (SIH 2026): Aadhaar, PAN, UPI VPA.
// Pattern: detectPII() entities -> createSanitizer().sanitize() aliases.
// Every value is synthetic (CONTRIBUTING.md §13/§15).

import { describe, expect, it } from 'vitest';
import { createSanitizer } from '../../../extension/src/sanitizer';
import { detectPII } from '../../../extension/src/perception/pii';

async function sanitize(text: string) {
  const entities = detectPII(text);
  return createSanitizer().sanitize(entities, text);
}

describe('indian PII detectors', () => {
  it('detects a space-separated Aadhaar number', async () => {
    const result = await sanitize('My Aadhaar is 2345 6789 0123 for reference');
    expect(result.aliases).toContain('USER_AADHAAR_1');
    expect(result.text).toContain('USER_AADHAAR_1');
    expect(result.text).not.toContain('2345 6789 0123');
  });

  it('detects a hyphen-separated Aadhaar number', async () => {
    const result = await sanitize('Aadhaar: 2345-6789-0123');
    expect(result.aliases).toContain('USER_AADHAAR_1');
    expect(result.text).not.toContain('2345-6789-0123');
  });

  it('detects a PAN card number', async () => {
    const result = await sanitize('PAN ABCDE1234F submitted');
    expect(result.aliases).toContain('USER_PAN_1');
    expect(result.text).not.toContain('ABCDE1234F');
  });

  it('detects a UPI ID on a known handle', async () => {
    const result = await sanitize('Pay to 9876543210@okicici today');
    expect(result.aliases).toContain('USER_UPI_1');
    expect(result.text).not.toContain('9876543210@okicici');
  });

  it('does not flag safe text', async () => {
    const result = await sanitize('order 1234 confirmed');
    expect(result.aliases).toHaveLength(0);
    expect(result.text).toBe('order 1234 confirmed');
  });

  it('detects Aadhaar and email on the same page', async () => {
    const result = await sanitize('Mail user@example.test, Aadhaar 2345 6789 0123');
    expect(result.aliases).toContain('USER_AADHAAR_1');
    expect(result.aliases).toContain('USER_EMAIL_1');
    expect(result.text).not.toContain('2345 6789 0123');
    expect(result.text).not.toContain('user@example.test');
  });
});
