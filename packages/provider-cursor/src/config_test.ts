import { describe, expect, test } from 'vitest';

import { assertCursorUpstreamRecord } from './config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = { email: 'a@b.com', userId: 'u1' };
const good = { accounts: [goodAccount] };

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up',
  provider: 'cursor',
  name: 'n',
  enabled: true,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  config: config as UpstreamRecord['config'],
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

describe('assertCursorUpstreamRecord (config validation)', () => {
  test('accepts a complete config', () => {
    expect(() => assertCursorUpstreamRecord(wrap(good))).not.toThrow();
  });

  test('rejects the wrong provider', () => {
    expect(() => assertCursorUpstreamRecord({ ...wrap(good), provider: 'codex' })).toThrow("Expected provider 'cursor'");
  });

  test.each([
    ['email empty', { accounts: [{ ...goodAccount, email: '' }] }],
    ['email type', { accounts: [{ ...goodAccount, email: 123 }] }],
    ['userId missing', { accounts: [{ ...goodAccount, userId: undefined }] }],
    ['extra field on account', { accounts: [{ ...goodAccount, extra: 1 }] }],
    ['extra top-level field', { ...good, extra: 1 }],
    ['accounts not an array', { accounts: goodAccount }],
    ['empty accounts array', { accounts: [] }],
    ['two accounts (v1 invariant)', { accounts: [goodAccount, { ...goodAccount, userId: 'u2' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertCursorUpstreamRecord(wrap(value))).toThrow();
  });
});
