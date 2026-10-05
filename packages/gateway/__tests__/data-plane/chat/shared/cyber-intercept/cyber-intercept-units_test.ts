import { describe, expect, test } from 'vitest';

import { stableStringify } from '../../../../../src/data-plane/chat/shared/cyber-intercept/stable-stringify.ts';
import { parseCyberInterceptVerdict } from '../../../../../src/data-plane/chat/shared/cyber-intercept/verdict.ts';
import { estimateMaxPayloadChars, FALLBACK_MAX_PAYLOAD_CHARS, serializePayload, truncateMiddle } from '../../../../../src/data-plane/chat/shared/cyber-intercept/payload.ts';

describe('stableStringify', () => {
  test('sorts object keys lexicographically so field order cannot change bytes', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test('sorts nested keys recursively', () => {
    expect(stableStringify({ outer: { z: 1, y: { c: 3, d: 4 } } })).toBe('{"outer":{"y":{"c":3,"d":4},"z":1}}');
  });

  test('preserves array order — messages are semantic', () => {
    // Array order survives; object keys inside each element are sorted
    // (content < role), which is the whole point of stability.
    expect(stableStringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]))
      .toBe('[{"content":"hi","role":"user"},{"content":"hello","role":"assistant"}]');
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  test('is compact — no whitespace, maximizing shared prefixes', () => {
    expect(stableStringify({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}');
  });

  test('round-trips through JSON.parse', () => {
    const value = { messages: [{ role: 'user', content: 'hi', nested: { b: 2, a: 1 } }], stream: false };
    expect(JSON.parse(stableStringify(value))).toEqual(value);
  });
});

describe('parseCyberInterceptVerdict', () => {
  test('parses a plain SAFE verdict as safe', () => {
    expect(parseCyberInterceptVerdict('<verdict>SAFE</verdict>')).toEqual({ unsafe: false, reason: '' });
  });

  test('parses SAFE with surrounding whitespace', () => {
    expect(parseCyberInterceptVerdict('prefix <verdict> SAFE </verdict> suffix')).toEqual({ unsafe: false, reason: '' });
  });

  test('SAFE ignores any present reason tag', () => {
    expect(parseCyberInterceptVerdict('<verdict>SAFE</verdict>\n<reason>ignored</reason>')).toEqual({ unsafe: false, reason: '' });
  });

  test('parses UNSAFE with its reason', () => {
    expect(parseCyberInterceptVerdict('<verdict>UNSAFE</verdict>\n<reason>cyber abuse - payload crafting</reason>'))
      .toEqual({ unsafe: true, reason: 'cyber abuse - payload crafting' });
  });

  test('UNSAFE without a reason falls back to the default text', () => {
    expect(parseCyberInterceptVerdict('<verdict>UNSAFE</verdict>')).toEqual({ unsafe: true, reason: 'unsafe content detected' });
    expect(parseCyberInterceptVerdict('<verdict>UNSAFE</verdict><reason>   </reason>')).toEqual({ unsafe: true, reason: 'unsafe content detected' });
  });

  test('a reason spanning lines is captured', () => {
    expect(parseCyberInterceptVerdict('<verdict>UNSAFE</verdict>\n<reason>line one\nline two</reason>'))
      .toEqual({ unsafe: true, reason: 'line one\nline two' });
  });

  test('missing verdict tag is fail-closed', () => {
    expect(parseCyberInterceptVerdict('The request looks fine to me.')).toEqual({
      unsafe: true,
      reason: 'judge output unparseable (fail-closed)',
    });
  });

  test('an unrecognized verdict value is fail-closed', () => {
    expect(parseCyberInterceptVerdict('<verdict>MAYBE</verdict>')).toEqual({
      unsafe: true,
      reason: 'judge output unparseable (fail-closed)',
    });
  });

  test('an empty output is fail-closed', () => {
    expect(parseCyberInterceptVerdict('')).toEqual({ unsafe: true, reason: 'judge output unparseable (fail-closed)' });
  });
});

describe('payload serialization', () => {
  test('under the cap the text is verbatim and not truncated', async () => {
    const serialized = await serializePayload({ a: 1 }, 1000);
    expect(serialized.text).toBe('{"a":1}');
    expect(serialized.truncated).toBe(false);
  });

  test('over the cap the middle is replaced and head+tail survive', async () => {
    const long = `${'x'.repeat(40)}${'y'.repeat(40)}`;
    // A string payload serializes to a JSON string literal, so the
    // serialized form gains outer quotes; truncation keeps the literal's
    // head (quote + leading x's) and tail (trailing y's + closing quote).
    const serialized = await serializePayload(long, 60);
    expect(serialized.truncated).toBe(true);
    expect(serialized.text).toContain('[...truncated ');
    expect(serialized.text.startsWith('"x')).toBe(true);
    expect(serialized.text.endsWith('y"')).toBe(true);
    // Head and tail are the serialized literal's own head and tail.
    const full = stableStringify(long);
    const head = serialized.text.split('[...')[0];
    const tail = serialized.text.split('...]').at(-1)!;
    expect(full.startsWith(head)).toBe(true);
    expect(full.endsWith(tail)).toBe(true);
  });

  test('the digest covers the pre-truncation text', async () => {
    const value = `${'a'.repeat(2000)}`;
    const serialized = await serializePayload(value, 100);
    expect(serialized.sha256).toBe((await serializePayload(value, 2000)).sha256);
  });
});

describe('truncateMiddle', () => {
  test('returns the input verbatim when within the cap', () => {
    expect(truncateMiddle('hello', 10)).toBe('hello');
  });

  test('splits evenly with a marker whose length eats into the budget', () => {
    const text = 'a'.repeat(100);
    const out = truncateMiddle(text, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toMatch(/^\[?\.{0}\]?/);  // no leading marker
    expect(out.includes('[...truncated 51 chars...]') || out.includes('[...truncated 50 chars...]')).toBe(true);
  });
});

describe('estimateMaxPayloadChars', () => {
  test('derives the absolute cap from the declared context window', () => {
    expect(estimateMaxPayloadChars(32000)).toBe(120000);
    expect(estimateMaxPayloadChars(128000)).toBe(504000);
    expect(estimateMaxPayloadChars(1_000_000)).toBe(3_992_000);
  });

  test('the fixed default floors small windows — the formula never starves the prompts', () => {
    expect(estimateMaxPayloadChars(8000)).toBe(FALLBACK_MAX_PAYLOAD_CHARS);
  });

  test('falls back to the fixed default when the limit is missing', () => {
    expect(estimateMaxPayloadChars(null)).toBe(FALLBACK_MAX_PAYLOAD_CHARS);
    expect(estimateMaxPayloadChars(undefined)).toBe(FALLBACK_MAX_PAYLOAD_CHARS);
    expect(estimateMaxPayloadChars(0)).toBe(FALLBACK_MAX_PAYLOAD_CHARS);
  });
});