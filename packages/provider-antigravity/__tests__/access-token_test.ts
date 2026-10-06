import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureAntigravityAccessToken,
  invalidateAntigravityAccessToken,
} from '../src/access-token.ts';
import type { AntigravityAccessTokenEntry, AntigravityUpstreamState } from '../src/state.ts';
import { directFetcher } from '@floway-dev/provider';
import type { UpstreamRecord, UpstreamsRepoSlim } from '@floway-dev/provider';

const fakeState = (overrides: Partial<{ refreshToken: string; accessToken: AntigravityAccessTokenEntry | null; state: 'active' | 'refresh_failed'; stateMessage: string; projectId: string | null }>): unknown => ({
  accounts: [{
    email: 'op@example.com',
    stateUpdatedAt: '2026-01-01T00:00:00.000Z',
    refreshToken: 'rt',
    accessToken: null,
    projectId: 'proj-1',
    state: 'active',
    ...overrides,
  }],
});

const record = (rawState: unknown): UpstreamRecord =>
  ({
    id: 'up_1', kind: 'antigravity', name: 'n', enabled: true, config: { accounts: [{ email: 'op@example.com', projectId: 'proj-1', tierId: 'free-tier' }] }, state: rawState,
  }) as unknown as UpstreamRecord;

// saveState hands the mutator the raw stored state document and takes back
// the replacement; capture what the mutator produced so tests can inspect
// the write.
const repo = (state: unknown) => {
  const saved: { produced: unknown }[] = [];
  const repoSlim: UpstreamsRepoSlim = {
    getById: vi.fn(async () => record(state)),
    saveState: vi.fn(async (_id: string, mutator: (current: unknown) => unknown) => {
      saved.push({ produced: mutator(state) });
    }),
  } as unknown as UpstreamsRepoSlim;
  return { repo: repoSlim, saved };
};

afterEach(() => vi.restoreAllMocks());

describe('ensureAntigravityAccessToken', () => {
  test('returns the cached entry without a /token round-trip while fresh', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      const entry: AntigravityAccessTokenEntry = { token: 'cached', expiresAt: Date.now() + 3600_000, refreshedAt: '2026-01-01T00:00:00.000Z' };
      const { repo: repoWithCache } = repo(fakeState({ accessToken: entry }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const ensured = await ensureAntigravityAccessToken({ upstreamId: 'up_1', repo: repoWithCache, fetcher: directFetcher });
      expect(ensured.entry.token).toBe('cached');
      expect(ensured.projectId).toBe('proj-1');
      expect(ensured.freshlyMinted).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('force skips the cache and rotates the token through /token', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      const entry: AntigravityAccessTokenEntry = { token: 'cached', expiresAt: Date.now() + 3600_000, refreshedAt: '2026-01-01T00:00:00.000Z' };
      const state = fakeState({ accessToken: entry });
      const { repo: repoWithCache, saved } = repo(state);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        access_token: 'fresh',
        token_type: 'Bearer',
        expires_in: 1800,
        scope: 'cloud-platform',
      }), { status: 200 }));
      const ensured = await ensureAntigravityAccessToken({ upstreamId: 'up_1', repo: repoWithCache, fetcher: directFetcher, force: true });
      expect(ensured.entry.token).toBe('fresh');
      expect(ensured.freshlyMinted).toBe(true);
      // The write keeps the refresh token verbatim (Google did not rotate it).
      const written = saved[0].produced as AntigravityUpstreamState;
      expect(written.accounts[0].refreshToken).toBe('rt');
      expect(written.accounts[0].accessToken?.token).toBe('fresh');
      const body = new URLSearchParams((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('rt');
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('a terminal stored state throws before any network call', async () => {
    const { repo: terminalRepo } = repo(fakeState({ state: 'refresh_failed', stateMessage: 'Token has been expired or revoked.', accessToken: null }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const promise = ensureAntigravityAccessToken({ upstreamId: 'up_1', repo: terminalRepo, fetcher: directFetcher });
    await expect(promise).rejects.toMatchObject({ code: 'refresh_failed', upstreamMessage: 'Token has been expired or revoked.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('invalidateAntigravityAccessToken', () => {
  test('clears only the cached token, keeping the refresh token', async () => {
    const { repo: repoWithCache, saved } = repo(fakeState({
      accessToken: { token: 'cached', expiresAt: Date.now() + 3600_000, refreshedAt: '2026-01-01T00:00:00.000Z' },
    }));
    await invalidateAntigravityAccessToken({ upstreamId: 'up_1', repo: repoWithCache });
    const written = saved[0].produced as AntigravityUpstreamState;
    expect(written.accounts[0].accessToken).toBeNull();
    expect(written.accounts[0].refreshToken).toBe('rt');
    expect(written.accounts[0].state).toBe('active');
  });

  test('an already-empty slot leaves the state unchanged', async () => {
    const original = fakeState({ accessToken: null });
    const { repo: repoEmpty, saved } = repo(original);
    await invalidateAntigravityAccessToken({ upstreamId: 'up_1', repo: repoEmpty });
    expect(saved[0].produced).toEqual(original);
  });
});
