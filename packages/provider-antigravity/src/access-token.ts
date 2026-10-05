import { logInfo, logWarn } from './log.ts';
import {
  AntigravityOAuthSessionTerminatedError,
  refreshAntigravityAccessToken,
} from './oauth.ts';
import { ensureAntigravityProjectId } from './project.ts';
import {
  readAntigravityUpstreamState,
  replaceSoleAccount,
  type AntigravityAccessTokenEntry,
  type AntigravityAccountCredential,
} from './state.ts';
import type { Fetcher, UpstreamsRepoSlim } from '@floway-dev/provider';

export type { AntigravityAccessTokenEntry };

export interface EnsuredAntigravityAccessToken {
  entry: AntigravityAccessTokenEntry;
  projectId: string;
  // True when this call shared in a real /token round-trip (drove the mint
  // or coalesced onto an in-flight one) and false when a cached entry was
  // returned. The data-plane call uses it only for diagnostics; unlike the
  // Claude Code provider there is no 401-retry branch — Google surfaces
  // auth failures as 401 with a Google-RPC error body and the retry costs
  // one extra refresh at most, so the hot path simply invalidates and
  // re-enters once.
  freshlyMinted: boolean;
}

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches the Claude Code provider's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: AntigravityAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

export interface EnsureAntigravityAccessTokenArgs {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
  fetcher: Fetcher;
  // Skip the cached-token fast-path and always call the OAuth refresh
  // endpoint — the dashboard's Refresh button sets it so the operator sees
  // the row's tokens actually rotate. Coalescing keys on `(upstreamId,
  // force)` so a force call never returns a lazy call's cache-hit result.
  force?: boolean;
}

// Process-local coalescing of concurrent ensure calls, mirroring the Claude
// Code provider: on a cold start N requests on the same isolate would each
// see a stale cache and each fire a /token POST. Scope is per-isolate only —
// cross-isolate races fall to Google's token-endpoint tolerance (it serves
// the same access token for repeated refreshes within its rotation window
// rather than hard-invalidating, so a losing sibling's token still works).
// https://developers.google.com/identity/protocols/oauth2/refresher-token
const inFlightEnsures = new Map<string, Promise<EnsuredAntigravityAccessToken>>();

export const ensureAntigravityAccessToken = async (
  args: EnsureAntigravityAccessTokenArgs,
): Promise<EnsuredAntigravityAccessToken> => {
  const key = `${args.upstreamId}:${args.force ? 'force' : 'lazy'}`;
  const existing = inFlightEnsures.get(key);
  if (existing) return await existing;
  const promise = ensureAntigravityAccessTokenInner(args);
  inFlightEnsures.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightEnsures.delete(key);
  }
};

// Reads, refreshes, and persists. The (possible) new refresh token and the
// fresh cached access token commit together in a single state write; the
// repo applies our mutator to whatever state it finds, so a concurrent
// write costs nothing. Google rarely rotates on refresh — the common case
// keeps the stored refresh token verbatim.
const ensureAntigravityAccessTokenInner = async (
  args: EnsureAntigravityAccessTokenArgs,
): Promise<EnsuredAntigravityAccessToken> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Antigravity upstream ${args.upstreamId} not found`);
  const state = readAntigravityUpstreamState(fresh.state);

  const account = state.accounts[0];
  if (account.state !== 'active') {
    // Surface the stored health state as the `code` so a caller
    // distinguishing by code reflects the persisted reason, not a synthetic
    // OAuth code.
    throw new AntigravityOAuthSessionTerminatedError({ code: account.state, message: account.stateMessage });
  }

  if (account.accessToken && isAccessTokenFresh(account.accessToken) && !args.force && account.projectId !== null) {
    return { entry: account.accessToken, projectId: account.projectId, freshlyMinted: false };
  }

  let refreshed;
  try {
    refreshed = await refreshAntigravityAccessToken(account.refreshToken, args.fetcher);
  } catch (error) {
    if (error instanceof AntigravityOAuthSessionTerminatedError) {
      await persistTerminalState(args.repo, args.upstreamId, account, {
        message: error.upstreamMessage,
        oauthCode: error.code,
      });
    }
    throw error;
  }

  const now = new Date().toISOString();
  const newAccessTokenEntry: AntigravityAccessTokenEntry = {
    token: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshedAt: now,
  };

  // Google usually keeps the refresh token stable across refreshes; only
  // persist a rotation when the response actually carried a new one. The
  // write lands on whatever account the repo hands us — a re-import that
  // swapped the credential in the meantime leaves nothing to rotate.
  const rotatedRefreshToken = refreshed.refresh_token;
  await args.repo.saveState(args.upstreamId, current =>
    replaceSoleAccount(readAntigravityUpstreamState(current), stored => (
      rotatedRefreshToken !== undefined && typeof stored.refreshToken === 'string' && rotatedRefreshToken !== ''
        ? { ...stored, refreshToken: rotatedRefreshToken, accessToken: newAccessTokenEntry }
        : { ...stored, accessToken: newAccessTokenEntry }
    )));
  logInfo('antigravity_access_token_refreshed', {
    upstream_id: args.upstreamId,
    email: account.email,
    expires_in_seconds: refreshed.expires_in,
    refreshed_at: now,
    refresh_token_rotated: rotatedRefreshToken !== undefined,
  });

  // Project id: imported rows normally carry one; a row imported before
  // onboarding completed (or whose onboarding raced) self-heals here.
  let projectId = account.projectId;
  projectId ??= await ensureAntigravityProjectId({
    upstreamId: args.upstreamId,
    repo: args.repo,
    fetcher: args.fetcher,
    accessToken: refreshed.access_token,
  });
  return { entry: newAccessTokenEntry, projectId, freshlyMinted: true };
};

// Terminal flip from the oauth-error path. The mutator is replayed on a
// lost race and must return the same document each time, so `flippedAt` is
// stamped before the write.
const persistTerminalState = async (
  repo: UpstreamsRepoSlim,
  upstreamId: string,
  previousAccount: AntigravityAccountCredential,
  fields: {
    message: string;
    oauthCode: string;
  },
): Promise<void> => {
  const flippedAt = new Date().toISOString();
  await repo.saveState(upstreamId, current =>
    replaceSoleAccount(readAntigravityUpstreamState(current), account => ({
      ...account,
      state: 'refresh_failed',
      stateMessage: fields.message,
      stateUpdatedAt: flippedAt,
      accessToken: null,
    })));
  logWarn('antigravity_account_state_flip', {
    upstream_id: upstreamId,
    email: previousAccount.email,
    from_state: previousAccount.state,
    to_state: 'refresh_failed',
    oauth_code: fields.oauthCode,
    message: fields.message,
  });
};

// Used on a data-plane 401: clear the cached access token without touching
// the refresh token, so the next call mints a fresh one. An account whose
// slot is already empty is returned untouched, which the repo reads as
// "nothing to do".
export const invalidateAntigravityAccessToken = async (args: {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
}): Promise<void> => {
  await args.repo.saveState(args.upstreamId, current => {
    const state = readAntigravityUpstreamState(current);
    if (state.accounts[0].accessToken === null) return state;
    return replaceSoleAccount(state, account => ({ ...account, accessToken: null }));
  });
};
