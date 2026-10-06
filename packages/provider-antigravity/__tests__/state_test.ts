import { describe, expect, test } from 'vitest';

import {
  assertAntigravityUpstreamState,
  readAntigravityUpstreamState,
  replaceSoleAccount,
  type AntigravityAccessTokenEntry,
  type AntigravityUpstreamState,
} from '../src/state.ts';

const accessToken: AntigravityAccessTokenEntry = {
  token: 'at',
  expiresAt: 1000,
  refreshedAt: '2026-01-01T00:00:00.000Z',
};

const activeAccount = {
  email: 'op@example.com',
  stateUpdatedAt: '2026-01-01T00:00:00.000Z',
  refreshToken: 'rt',
  accessToken,
  projectId: 'proj-1',
  state: 'active' as const,
};

const state = (accounts: unknown[]): AntigravityUpstreamState =>
  ({ accounts }) as unknown as AntigravityUpstreamState;

describe('assertAntigravityUpstreamState', () => {
  test('accepts an active account', () => {
    assertAntigravityUpstreamState(state([activeAccount]));
    expect(readAntigravityUpstreamState(state([activeAccount])).accounts[0]).toEqual(activeAccount);
  });

  test('accepts a terminal account with its message', () => {
    const credential = { ...activeAccount, state: 'refresh_failed', stateMessage: 'Token has been expired or revoked.', accessToken: null };
    assertAntigravityUpstreamState(state([credential]));
    expect(readAntigravityUpstreamState(state([credential])).accounts[0].state).toBe('refresh_failed');
  });

  test('rejects a stateMessage on the active state', () => {
    expect(() => assertAntigravityUpstreamState(state([{ ...activeAccount, stateMessage: 'healthy' }]))).toThrow(/must be absent on active/);
  });

  test('rejects a terminal state without a message', () => {
    expect(() => assertAntigravityUpstreamState(state([{ ...activeAccount, state: 'refresh_failed' }]))).toThrow(/terminal state/);
  });

  test('rejects an unknown state value', () => {
    expect(() => assertAntigravityUpstreamState(state([{ ...activeAccount, state: 'paused' }]))).toThrow(/got paused/);
  });

  test('rejects unknown state keys', () => {
    expect(() => assertAntigravityUpstreamState({ ...state([activeAccount]), apiKey: 'x' })).toThrow(/unexpected key/);
  });

  test('rejects an access-token entry with unknown keys', () => {
    expect(() => assertAntigravityUpstreamState(state([{
      ...activeAccount,
      accessToken: { ...accessToken, rotated: true },
    }]))).toThrow(/unexpected key/);
  });

  test('rejects zero and two accounts', () => {
    expect(() => assertAntigravityUpstreamState(state([]))).toThrow(/exactly one/);
    const account = { ...activeAccount, email: 'other@example.com' };
    expect(() => assertAntigravityUpstreamState(state([activeAccount, account]))).toThrow(/exactly one/);
  });
});

describe('replaceSoleAccount', () => {
  test('patches index 0 and keeps the outer shape', () => {
    const patched = replaceSoleAccount(
      readAntigravityUpstreamState(state([activeAccount])),
      account => ({ ...account, projectId: 'proj-2' }),
    );
    expect(patched.accounts[0].projectId).toBe('proj-2');
    expect(patched.accounts).toHaveLength(1);
    expect(patched.accounts[0].email).toBe('op@example.com');
  });

  test('does not mutate the input state', () => {
    const original = readAntigravityUpstreamState(state([activeAccount]));
    replaceSoleAccount(original, account => ({ ...account, projectId: 'proj-2' }));
    expect(original.accounts[0].projectId).toBe('proj-1');
  });
});
