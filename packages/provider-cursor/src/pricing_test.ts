import { describe, expect, test } from 'vitest';

import { pricingForCursorModelKey } from './pricing.ts';

describe('pricingForCursorModelKey', () => {
  test('matches claude-3.7-sonnet', () => {
    expect(pricingForCursorModelKey('claude-3.7-sonnet')?.input).toBe(3);
    expect(pricingForCursorModelKey('claude-3.7-sonnet')?.output).toBe(15);
  });

  test('matches composer-* (notional)', () => {
    expect(pricingForCursorModelKey('composer-2.5')?.input).toBe(3);
  });

  test('matches gpt-5.4 but not gpt-5.4-mini as the base rate', () => {
    expect(pricingForCursorModelKey('gpt-5.4')?.input).toBe(2.5);
    expect(pricingForCursorModelKey('gpt-5.4-mini')?.input).toBe(0.75);
  });

  test('matches gemini-2.5-pro', () => {
    expect(pricingForCursorModelKey('gemini-2.5-pro')?.input).toBe(1.25);
  });

  test('matches auto', () => {
    expect(pricingForCursorModelKey('auto')?.input).toBe(3);
  });

  test('returns null for an unknown model', () => {
    expect(pricingForCursorModelKey('some-unknown-model')).toBeNull();
  });
});
