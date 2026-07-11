import { afterEach, describe, expect, test } from 'vitest';

import { resetOAuthProviderRegistryForTesting } from './registry.ts';
import { requestApp, setupAppTest } from '../../../test-helpers.ts';
import { initEnv } from '@floway-dev/platform';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const HMAC_SECRET = 'x'.repeat(64);
const PUBLIC_ORIGIN = 'https://floway.example.com';
const ISSUER = 'https://sso.example.com';

const providerConfig = () => JSON.stringify([{
  id: 'corp',
  displayName: 'Corp SSO',
  issuer: ISSUER,
  clientId: 'floway',
  clientSecret: 'secret',
}]);

const setupOauthEnv = (adminKey: string) => {
  initEnv(name => {
    if (name === 'ADMIN_KEY') return adminKey;
    if (name === 'SESSION_HMAC_SECRET') return HMAC_SECRET;
    if (name === 'FLOWAY_PUBLIC_ORIGIN') return PUBLIC_ORIGIN;
    if (name === 'FLOWAY_OAUTH_PROVIDERS_JSON') return providerConfig();
    return undefined;
  });
  resetOAuthProviderRegistryForTesting();
};

afterEach(() => {
  initEnv(() => undefined);
  resetOAuthProviderRegistryForTesting();
});

const stubDiscoveryHandler = (r: Request): Response | null => {
  if (r.url.endsWith('/.well-known/openid-configuration')) {
    return jsonResponse({
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
    });
  }
  return null;
};

describe('GET /auth/oauth/providers', () => {
  test('lists configured providers', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    const res = await requestApp('/auth/oauth/providers', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [{ id: 'corp', displayName: 'Corp SSO' }] });
  });

  test('returns [] when nothing is configured', async () => {
    await setupAppTest();
    const res = await requestApp('/auth/oauth/providers', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });
});

describe('POST /auth/oauth/:provider/authorize-url', () => {
  test('login intent produces a valid authorize URL with S256 challenge', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    await withMockedFetch(
      r => stubDiscoveryHandler(r) ?? new Response('', { status: 404 }),
      async () => {
        const res = await requestApp('/auth/oauth/corp/authorize-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intent: 'login' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string };
        const url = new URL(body.url);
        expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/oauth/corp/callback`);
        expect(url.searchParams.get('state')).toBeTruthy();
      },
    );
  });

  test('unknown provider is 404', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    const res = await requestApp('/auth/oauth/unknown/authorize-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'login' }),
    });
    expect(res.status).toBe(404);
  });

  test('link intent without a session is rejected', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    const res = await requestApp('/auth/oauth/corp/authorize-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'link' }),
    });
    expect(res.status).toBe(401);
  });

  test('link intent with a valid session succeeds', async () => {
    const { repo, adminSession, adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    expect(await repo.sessions.getByIdAndTouch(adminSession)).not.toBeNull();
    await withMockedFetch(
      r => stubDiscoveryHandler(r) ?? new Response('', { status: 404 }),
      async () => {
        const res = await requestApp('/auth/oauth/corp/authorize-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
          body: JSON.stringify({ intent: 'link' }),
        });
        expect(res.status).toBe(200);
      },
    );
  });
});

describe('GET /auth/oauth/:provider/callback', () => {
  const captureAuthorizeState = async (extraHeaders: HeadersInit = {}, body: Record<string, unknown> = { intent: 'login' }): Promise<string> => {
    const res = await requestApp('/auth/oauth/corp/authorize-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const authorizeUrl = new URL(((await res.json()) as { url: string }).url);
    const state = authorizeUrl.searchParams.get('state');
    if (!state) throw new Error('authorize-url did not return a state');
    return state;
  };

  const tokenAndUserinfoHandler = (userinfo: { sub: string; email?: string }) => (r: Request): Response => {
    if (r.url.endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
      });
    }
    if (r.url === `${ISSUER}/token`) return jsonResponse({ access_token: 'at' });
    if (r.url === `${ISSUER}/userinfo`) return jsonResponse(userinfo);
    return new Response('', { status: 404 });
  };

  test('login with a pre-linked subject issues a session in the handoff fragment', async () => {
    const { repo, adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'sub-alice', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });

    await withMockedFetch(tokenAndUserinfoHandler({ sub: 'sub-alice' }), async () => {
      const state = await captureAuthorizeState();
      const res = await requestApp(`/auth/oauth/corp/callback?code=xyz&state=${encodeURIComponent(state)}`, { method: 'GET' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location')!;
      expect(location).toMatch(/^\/oauth\/handoff#/);
      const fragment = location.split('#')[1];
      const params = new URLSearchParams(fragment);
      const token = params.get('session')!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const session = await repo.sessions.getByIdAndTouch(token);
      expect(session?.userId).toBe(2);
    });
  });

  test('login with a subject that is not enrolled redirects to /login?error=not-enrolled', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    await withMockedFetch(tokenAndUserinfoHandler({ sub: 'stranger' }), async () => {
      const state = await captureAuthorizeState();
      const res = await requestApp(`/auth/oauth/corp/callback?code=xyz&state=${encodeURIComponent(state)}`, { method: 'GET' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?error=not-enrolled');
    });
  });

  test('tampered state is rejected', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    await withMockedFetch(tokenAndUserinfoHandler({ sub: 'sub-alice' }), async () => {
      const state = await captureAuthorizeState();
      const [body, sig] = state.split('.');
      const forged = `${body}${'X'}.${sig}`;
      const res = await requestApp(`/auth/oauth/corp/callback?code=xyz&state=${encodeURIComponent(forged)}`, { method: 'GET' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/state-/);
    });
  });

  test('state minted for provider A is rejected on provider B', async () => {
    const { adminKey } = await setupAppTest();
    initEnv(name => {
      if (name === 'ADMIN_KEY') return adminKey;
      if (name === 'SESSION_HMAC_SECRET') return HMAC_SECRET;
      if (name === 'FLOWAY_PUBLIC_ORIGIN') return PUBLIC_ORIGIN;
      if (name === 'FLOWAY_OAUTH_PROVIDERS_JSON') return JSON.stringify([
        { id: 'corp', displayName: 'Corp', issuer: ISSUER, clientId: 'a', clientSecret: 'a' },
        { id: 'other', displayName: 'Other', issuer: ISSUER, clientId: 'b', clientSecret: 'b' },
      ]);
      return undefined;
    });
    resetOAuthProviderRegistryForTesting();
    await withMockedFetch(tokenAndUserinfoHandler({ sub: 'sub-alice' }), async () => {
      const state = await captureAuthorizeState();
      const res = await requestApp(`/auth/oauth/other/callback?code=xyz&state=${encodeURIComponent(state)}`, { method: 'GET' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('state-provider-mismatch');
    });
  });

  test('link callback binds the subject to the session user', async () => {
    const { repo, adminSession, adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    await withMockedFetch(tokenAndUserinfoHandler({ sub: 'sub-admin' }), async () => {
      const state = await captureAuthorizeState({ 'x-floway-session': adminSession }, { intent: 'link' });
      const res = await requestApp(`/auth/oauth/corp/callback?code=xyz&state=${encodeURIComponent(state)}`, {
        method: 'GET',
        headers: { 'x-floway-session': adminSession },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/settings/identities?linked=corp');
      const rows = await repo.userOauthIdentities.listByUserId(1);
      expect(rows.map(r => r.subject)).toEqual(['sub-admin']);
    });
  });

  test('link callback rejects a subject already bound to a different user', async () => {
    const { repo, adminSession, adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'sub-taken', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
    await withMockedFetch(tokenAndUserinfoHandler({ sub: 'sub-taken' }), async () => {
      const state = await captureAuthorizeState({ 'x-floway-session': adminSession }, { intent: 'link' });
      const res = await requestApp(`/auth/oauth/corp/callback?code=xyz&state=${encodeURIComponent(state)}`, {
        method: 'GET',
        headers: { 'x-floway-session': adminSession },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/settings/identities?error=already-linked');
    });
  });

  test('missing code or state redirects to /login', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    const res = await requestApp('/auth/oauth/corp/callback', { method: 'GET' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=missing-code');
  });

  test('IdP-supplied error is passed through the redirect', async () => {
    const { adminKey } = await setupAppTest();
    setupOauthEnv(adminKey);
    const res = await requestApp('/auth/oauth/corp/callback?error=access_denied', { method: 'GET' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=access_denied');
  });
});
