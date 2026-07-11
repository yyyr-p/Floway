import { afterEach, describe, expect, test } from 'vitest';

import { GenericOidcProvider } from './generic-oidc.ts';
import { getOAuthProvider, listOAuthProviders, publicOrigin, redirectUriFor, resetOAuthProviderRegistryForTesting } from './registry.ts';
import { initEnv } from '@floway-dev/platform';

const configFor = (extras: Partial<Record<string, unknown>> = {}) => ({
  id: 'corp',
  displayName: 'Corp SSO',
  issuer: 'https://sso.example.com',
  clientId: 'floway',
  clientSecret: 'secret',
  ...extras,
});

const withEnv = (env: Record<string, string>) => {
  initEnv(name => env[name]);
  resetOAuthProviderRegistryForTesting();
};

afterEach(() => {
  initEnv(() => undefined);
  resetOAuthProviderRegistryForTesting();
});

describe('OAuth provider registry', () => {
  test('empty / unset FLOWAY_OAUTH_PROVIDERS_JSON yields empty registry', () => {
    withEnv({});
    expect(listOAuthProviders()).toEqual([]);
    expect(getOAuthProvider('anything')).toBeNull();
  });

  test('parses one provider entry into a GenericOidcProvider', () => {
    withEnv({ FLOWAY_OAUTH_PROVIDERS_JSON: JSON.stringify([configFor()]) });
    const providers = listOAuthProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(GenericOidcProvider);
    expect(providers[0].providerId).toBe('corp');
    expect(providers[0].displayName).toBe('Corp SSO');
    expect(getOAuthProvider('corp')).toBe(providers[0]);
  });

  test('rejects duplicate provider ids', () => {
    withEnv({ FLOWAY_OAUTH_PROVIDERS_JSON: JSON.stringify([configFor({ id: 'a' }), configFor({ id: 'a' })]) });
    expect(() => listOAuthProviders()).toThrow(/duplicate/i);
  });

  test('rejects missing required fields', () => {
    withEnv({ FLOWAY_OAUTH_PROVIDERS_JSON: JSON.stringify([{ id: 'a' }]) });
    expect(() => listOAuthProviders()).toThrow(/displayName/);
  });

  test('rejects non-array top level', () => {
    withEnv({ FLOWAY_OAUTH_PROVIDERS_JSON: '{}' });
    expect(() => listOAuthProviders()).toThrow(/array/);
  });

  test('rejects invalid JSON', () => {
    withEnv({ FLOWAY_OAUTH_PROVIDERS_JSON: 'not json' });
    expect(() => listOAuthProviders()).toThrow(/valid JSON/);
  });

  test('publicOrigin strips trailing slashes and requires the env', () => {
    withEnv({ FLOWAY_PUBLIC_ORIGIN: 'https://floway.example.com/' });
    expect(publicOrigin()).toBe('https://floway.example.com');

    withEnv({});
    expect(() => publicOrigin()).toThrow(/FLOWAY_PUBLIC_ORIGIN/);
  });

  test('redirectUriFor composes the fixed callback path', () => {
    withEnv({ FLOWAY_PUBLIC_ORIGIN: 'https://floway.example.com' });
    expect(redirectUriFor('corp')).toBe('https://floway.example.com/auth/oauth/corp/callback');
  });
});

describe('GenericOidcProvider', () => {
  const stubMetadata = {
    authorization_endpoint: 'https://sso.example.com/authorize',
    token_endpoint: 'https://sso.example.com/token',
    userinfo_endpoint: 'https://sso.example.com/userinfo',
  };

  const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

  test('authorizeUrl fetches discovery once and composes the S256 PKCE query', async () => {
    let discoveryCalls = 0;
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        discoveryCalls += 1;
        return jsonResponse(stubMetadata);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const p = new GenericOidcProvider(configFor() as never);
    const url = await p.authorizeUrl({ state: 'state-token', codeChallenge: 'challenge', redirectUri: 'https://floway.example.com/auth/oauth/corp/callback', fetcher } as never);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://sso.example.com/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('floway');
    expect(parsed.searchParams.get('state')).toBe('state-token');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('openid profile email');
    // Second call reuses the cached metadata.
    await p.authorizeUrl({ state: 's2', codeChallenge: 'c2', redirectUri: 'https://x', fetcher } as never);
    expect(discoveryCalls).toBe(1);
  });

  test('exchangeCode posts form-urlencoded and returns access_token/id_token', async () => {
    let capturedBody = '';
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(stubMetadata);
      if (url === stubMetadata.token_endpoint) {
        capturedBody = String(init.body);
        return jsonResponse({ access_token: 'at', id_token: 'it' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const p = new GenericOidcProvider(configFor());
    const result = await p.exchangeCode({ code: 'code-42', codeVerifier: 'v'.repeat(64), redirectUri: 'https://cb', fetcher });
    expect(result).toEqual({ accessToken: 'at', idToken: 'it' });
    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('code=code-42');
    expect(capturedBody).toContain('code_verifier=');
    expect(capturedBody).toContain('client_secret=secret');
  });

  test('exchangeCode surfaces non-2xx as an Error with body preview', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(stubMetadata);
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    };
    const p = new GenericOidcProvider(configFor());
    await expect(p.exchangeCode({ code: 'x', codeVerifier: 'v', redirectUri: 'https://cb', fetcher })).rejects.toThrow(/invalid_grant/);
  });

  test('fetchUserInfo returns subject + email from the userinfo endpoint', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(stubMetadata);
      if (url === stubMetadata.userinfo_endpoint) return jsonResponse({ sub: 'user-42', email: 'alice@example.com' });
      throw new Error(`unexpected fetch: ${url}`);
    };
    const p = new GenericOidcProvider(configFor());
    expect(await p.fetchUserInfo({ accessToken: 'at', fetcher })).toEqual({ subject: 'user-42', email: 'alice@example.com' });
  });

  test('fetchUserInfo falls back to id_token when discovery lacks userinfo_endpoint', async () => {
    const claims = { sub: 'from-jwt', email: 'jwt@example.com' };
    const b64 = (obj: unknown): string => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const idToken = `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse({ authorization_endpoint: stubMetadata.authorization_endpoint, token_endpoint: stubMetadata.token_endpoint });
      throw new Error(`unexpected fetch: ${url}`);
    };
    const p = new GenericOidcProvider(configFor());
    expect(await p.fetchUserInfo({ accessToken: 'at', idToken, fetcher })).toEqual({ subject: 'from-jwt', email: 'jwt@example.com' });
  });

  test('fetchUserInfo rejects empty sub', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(stubMetadata);
      return jsonResponse({ sub: '' });
    };
    const p = new GenericOidcProvider(configFor());
    await expect(p.fetchUserInfo({ accessToken: 'at', fetcher })).rejects.toThrow(/sub/);
  });
});
