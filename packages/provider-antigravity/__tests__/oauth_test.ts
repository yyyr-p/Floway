import { afterEach, describe, expect, test, vi } from 'vitest';

import { ANTIGRAVITY_REDIRECT_URI } from '../src/constants.ts';
import {
  AntigravityOAuthSessionTerminatedError,
  buildAntigravityAuthorizeUrl,
  exchangeAntigravityAuthorizationCode,
  refreshAntigravityAccessToken,
} from '../src/oauth.ts';
import { directFetcher } from '@floway-dev/provider';

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const errorResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tokenBody = {
  access_token: 'at',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt',
  scope: 'https://www.googleapis.com/auth/cloud-platform',
};

afterEach(() => vi.restoreAllMocks());

describe('buildAntigravityAuthorizeUrl', () => {
  test('carries the PKCE challenge and consent parameters', () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      const url = new URL(buildAntigravityAuthorizeUrl({ state: 'STATE', codeChallenge: 'CHALLENGE' }));
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('client_id')).toBe('client-id');
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });
});

describe('exchangeAntigravityAuthorizationCode', () => {
  test('POSTs the form-encoded public-client body', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(tokenBody));
    try {
      const result = await exchangeAntigravityAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
      expect(result.access_token).toBe('at');
      expect(result.refresh_token).toBe('rt');
      expect(result.expires_in).toBe(3600);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      expect((init as RequestInit).method).toBe('POST');

      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(headers.get('x-goog-api-client')).toBe('gl-node/22.21.1');

      const body = new URLSearchParams((init as RequestInit).body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('CODE');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
      expect(body.get('redirect_uri')).toBe(ANTIGRAVITY_REDIRECT_URI);
      expect(body.get('code_verifier')).toBe('VER');
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('surfaces error_description from a non-JSON-parseable failure', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        errorResponse(400, { error: 'invalid_request', error_description: 'code was already redeemed' }),
      );
      await expect(exchangeAntigravityAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher }))
        .rejects.toThrow(/already redeemed/);
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('rethrows network failures unchanged', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      await expect(exchangeAntigravityAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher }))
        .rejects.toThrow('fetch failed');
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });
});

describe('refreshAntigravityAccessToken', () => {
  test('POSTs the refresh grant; empty refresh_token in response maps to undefined', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({
      access_token: 'at2',
      token_type: 'Bearer',
      expires_in: 1800,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    }));
    try {
      const result = await refreshAntigravityAccessToken('rt_old', directFetcher);
      expect(result.access_token).toBe('at2');
      // Google usually keeps the refresh token stable — absence means keep.
      expect(result.refresh_token).toBeUndefined();

      const body = new URLSearchParams((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('rt_old');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('invalid_grant → AntigravityOAuthSessionTerminatedError carrying the upstream message', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        errorResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      );
      const promise = refreshAntigravityAccessToken('rt_dead', directFetcher);
      await expect(promise).rejects.toBeInstanceOf(AntigravityOAuthSessionTerminatedError);
      await expect(promise).rejects.toMatchObject({ code: 'invalid_grant', upstreamMessage: 'Token has been expired or revoked.' });
      await expect(promise).rejects.toThrow(/^Antigravity OAuth session terminated: /);
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('unauthorized_client is terminal too', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        errorResponse(403, { error: 'unauthorized_client', error_description: 'client not allowed' }),
      );
      await expect(refreshAntigravityAccessToken('rt_dead', directFetcher))
        .rejects.toBeInstanceOf(AntigravityOAuthSessionTerminatedError);
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('invalid_request is NOT terminal (transient)', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'client-id';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'client-secret';
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        errorResponse(400, { error: 'invalid_request', error_description: 'missing client_secret' }),
      );
      const promise = refreshAntigravityAccessToken('rt', directFetcher);
      await expect(promise).rejects.not.toBeInstanceOf(AntigravityOAuthSessionTerminatedError);
      await expect(promise).rejects.toThrow(/missing client_secret/);
    } finally {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    }
  });

  test('unconfigured client credentials fail loudly with the source pointer', async () => {
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(refreshAntigravityAccessToken('rt', directFetcher))
      .rejects.toThrow(/ANTIGRAVITY_OAUTH_CLIENT_ID.*CLIProxyAPI\/blob\/main\/internal\/auth\/antigravity\/constants\.go/s);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
