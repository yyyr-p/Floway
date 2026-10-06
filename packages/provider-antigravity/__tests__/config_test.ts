import { describe, expect, test } from 'vitest';

import { assertAntigravityUpstreamRecord } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const identity = { email: 'op@example.com', projectId: 'proj-1', tierId: 'free-tier' };
const base = {
  id: 'up_1', name: 'n', enabled: true, sort_order: 0, created_at: '', updated_at: '',
  flag_overrides: {}, flag_defaults: {}, disabled_public_model_ids: [],
  proxy_fallback_list: [], model_prefix: null, hue: 0,
} as unknown as UpstreamRecord;

const record = (config: unknown): UpstreamRecord =>
  ({ ...base, kind: 'antigravity', config }) as UpstreamRecord;

describe('assertAntigravityUpstreamRecord', () => {
  test('accepts the stored one-account shape', () => {
    const candidate = record({ accounts: [identity] });
    assertAntigravityUpstreamRecord(candidate);
    expect(candidate.config.accounts[0]).toEqual(identity);
  });

  test('accepts baseUrl alongside the account', () => {
    const candidate = record({ accounts: [identity], baseUrl: 'https://mirror.example.com' });
    assertAntigravityUpstreamRecord(candidate);
    expect(candidate.config.baseUrl).toBe('https://mirror.example.com');
  });

  test('rejects a non-antigravity kind', () => {
    expect(() => assertAntigravityUpstreamRecord({ ...base, kind: 'copilot', config: {} } as UpstreamRecord)).toThrow(/antigravity/);
  });

  test('rejects zero and two accounts — v1 is a 1-tuple', () => {
    expect(() => assertAntigravityUpstreamRecord(record({ accounts: [] }))).toThrow(/exactly one/);
    expect(() => assertAntigravityUpstreamRecord(record({ accounts: [identity, identity] }))).toThrow(/exactly one/);
  });

  test('rejects unknown config keys', () => {
    expect(() => assertAntigravityUpstreamRecord(record({ accounts: [identity], apiKey: 'x' }))).toThrow(/unexpected key/);
  });

  test('rejects an identity with an unexpected key', () => {
    expect(() => assertAntigravityUpstreamRecord(record({ accounts: [{ ...identity, refreshToken: 'x' }] }))).toThrow(/unexpected key/);
  });

  test('rejects a blank baseUrl', () => {
    expect(() => assertAntigravityUpstreamRecord(record({ accounts: [identity], baseUrl: '' }))).toThrow(/baseUrl/);
  });

  test('accepts a null tierId from a half-finished import', () => {
    const candidate = record({ accounts: [{ ...identity, tierId: null }] });
    assertAntigravityUpstreamRecord(candidate);
    expect(candidate.config.accounts[0].tierId).toBeNull();
  });
});
