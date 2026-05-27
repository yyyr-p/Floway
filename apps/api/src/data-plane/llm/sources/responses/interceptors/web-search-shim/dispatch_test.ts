import { test } from 'vitest';

import { findMatches, formatMatches, isUrlAllowed } from './dispatch.ts';
import { assertEquals } from '../../../../../../test-assert.ts';

test('isUrlAllowed returns true when no filters set', () => {
  assertEquals(isUrlAllowed('https://example.com', {}), true);
});

test('isUrlAllowed allowed_domains: exact host match passes', () => {
  assertEquals(isUrlAllowed('https://example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: subdomain suffix-matches', () => {
  assertEquals(isUrlAllowed('https://www.example.com/page', { allowedDomains: ['example.com'] }), true);
  assertEquals(isUrlAllowed('https://sub.example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: unrelated host is blocked', () => {
  assertEquals(isUrlAllowed('https://other.com', { allowedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains: exact match is blocked', () => {
  assertEquals(isUrlAllowed('https://example.com', { blockedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains: subdomain is blocked', () => {
  assertEquals(isUrlAllowed('https://www.example.com', { blockedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains takes precedence over allowed_domains', () => {
  assertEquals(
    isUrlAllowed('https://example.com', { allowedDomains: ['example.com'], blockedDomains: ['example.com'] }),
    false,
  );
});

test('isUrlAllowed invalid URL is blocked defensively', () => {
  assertEquals(isUrlAllowed('not-a-url', { allowedDomains: ['x.com'] }), false);
});

test('isUrlAllowed non-suffix substring match does NOT pass', () => {
  assertEquals(isUrlAllowed('https://evil-example.com', { allowedDomains: ['example.com'] }), false);
});

test('isUrlAllowed empty allowedDomains list behaves like no filter', () => {
  assertEquals(isUrlAllowed('https://example.com', { allowedDomains: [] }), true);
});

test('findMatches: case-insensitive substring matching', () => {
  const m = findMatches('Hello WORLD hello world HELLO', 'hello', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 3);
  assertEquals(m[0].matched, 'Hello');
  assertEquals(m[1].matched, 'hello');
  assertEquals(m[2].matched, 'HELLO');
});

test('findMatches: respects maxMatches cap', () => {
  const text = 'foo '.repeat(20);
  assertEquals(findMatches(text, 'foo', { maxMatches: 5, contextChars: 5 }).length, 5);
});

test('findMatches: empty array on no match', () => {
  assertEquals(findMatches('hello', 'xyz', { maxMatches: 10, contextChars: 5 }), []);
});

test('findMatches: empty pattern returns empty array', () => {
  assertEquals(findMatches('hello', '', { maxMatches: 10, contextChars: 5 }), []);
});

test('findMatches: contextChars trims around the match', () => {
  const m = findMatches('AAAAAAAAAAneedleBBBBBBBBBB', 'needle', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 1);
  assertEquals(m[0].before, 'AAAAA');
  assertEquals(m[0].matched, 'needle');
  assertEquals(m[0].after, 'BBBBB');
});

test('findMatches: pattern at string boundaries', () => {
  const m = findMatches('needleXXXX', 'needle', { maxMatches: 1, contextChars: 5 });
  assertEquals(m[0].before, '');
  assertEquals(m[0].after, 'XXXX');
});

test('findMatches: pattern at end of string', () => {
  const m = findMatches('XXXXneedle', 'needle', { maxMatches: 1, contextChars: 5 });
  assertEquals(m[0].before, 'XXXX');
  assertEquals(m[0].after, '');
});

test('findMatches: overlapping matches not double-counted (search resumes past match)', () => {
  const m = findMatches('aaaa', 'aa', { maxMatches: 10, contextChars: 0 });
  assertEquals(m.length, 2);
});

test('formatMatches: renders header + numbered matches with brackets', () => {
  const out = formatMatches('cat', 'https://x', [{ before: 'a ', matched: 'cat', after: ' on mat' }]);
  assertEquals(out.includes('1 match for pattern: `cat`'), true);
  assertEquals(out.includes('Match 1:'), true);
  assertEquals(out.includes('"...a [cat] on mat..."'), true);
});

test('formatMatches: empty matches returns no-matches phrase including URL', () => {
  assertEquals(formatMatches('cat', 'https://x', []), 'No matching `cat` found on https://x.');
});

test('formatMatches: multi-match output uses Match N: headers', () => {
  const out = formatMatches('cat', 'https://x', [
    { before: 'a ', matched: 'cat', after: ' b' },
    { before: 'c ', matched: 'cat', after: ' d' },
  ]);
  assertEquals(out.includes('2 matches for pattern: `cat`'), true);
  assertEquals(out.includes('Match 1:'), true);
  assertEquals(out.includes('Match 2:'), true);
});
