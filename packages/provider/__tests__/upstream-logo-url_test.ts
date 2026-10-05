import { describe, expect, it } from 'vitest';

import { normalizeUpstreamLogoUrl } from '../src/model.ts';

describe('normalizeUpstreamLogoUrl', () => {
  it('canonicalizes absolute HTTPS URLs and treats empty values as absent', () => {
    expect(normalizeUpstreamLogoUrl('  https://EXAMPLE.com/logo.svg  ')).toBe('https://example.com/logo.svg');
    expect(normalizeUpstreamLogoUrl('')).toBeNull();
    expect(normalizeUpstreamLogoUrl(null)).toBeNull();
    expect(normalizeUpstreamLogoUrl(undefined)).toBeNull();
  });

  it.each([
    'http://example.com/logo.png',
    'data:image/svg+xml,<svg/>',
    'blob:https://example.com/logo.png',
    'javascript:alert(1)',
    '/logo.png',
    'https://user:secret@example.com/logo.png',
    `https://example.com/${'a'.repeat(2040)}`,
    'https://example.com/logo name.png',
  ])('rejects unsafe or malformed value %j', value => {
    expect(() => normalizeUpstreamLogoUrl(value)).toThrow();
  });

  it('rejects non-string wire values', () => {
    expect(() => normalizeUpstreamLogoUrl({})).toThrow(/string or null/);
  });
});
