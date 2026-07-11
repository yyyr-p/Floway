import { getOAuthProvider, listOAuthProviders, redirectUriFor } from './registry.ts';
import { signOauthState, verifyOauthState } from './state.ts';
import { getRepo } from '../../../repo/index.ts';
import type { UserOauthIdentity } from '../../../repo/types.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import type { CtxWithJson } from '../../../middleware/zod-validator.ts';
import type { oauthAuthorizeUrlBody } from '../../schemas.ts';
import { directFetcher } from '@floway-dev/provider';

// PKCE verifier — 43+ chars, base64url. Generated server-side and tucked into
// the signed state so the callback handler can present it during token
// exchange without any per-flow browser storage.
const generateCodeVerifier = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const deriveCodeChallenge = async (verifier: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const isSafeReturnPath = (returnTo: string): boolean => returnTo.startsWith('/') && !returnTo.startsWith('//');

export const listOAuthProvidersRoute = (c: AuthedContext) => {
  const providers = listOAuthProviders().map(p => ({ id: p.providerId, displayName: p.displayName }));
  return c.json({ providers });
};

export const oauthAuthorizeUrl = async (c: CtxWithJson<typeof oauthAuthorizeUrlBody>) => {
  const providerId = c.req.param('provider')!;
  const provider = getOAuthProvider(providerId);
  if (!provider) return c.json({ error: 'Unknown OAuth provider' }, 404);

  const { intent, returnTo } = c.req.valid('json');
  let linkUserId: number | null = null;
  if (intent === 'link') {
    const sessionToken = c.req.header('x-floway-session');
    if (!sessionToken) return c.json({ error: 'Link requires a session' }, 401);
    const session = await getRepo().sessions.getByIdAndTouch(sessionToken);
    if (!session) return c.json({ error: 'Invalid session' }, 401);
    linkUserId = session.userId;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);
  const safeReturnTo = returnTo && isSafeReturnPath(returnTo) ? returnTo : null;
  const { token: state } = await signOauthState({ providerId, intent, linkUserId, returnTo: safeReturnTo, codeVerifier });

  const redirectUri = redirectUriFor(providerId);
  const url = await provider.authorizeUrl({ state, codeChallenge, redirectUri });
  return c.json({ url });
};

const encodeHandoffFragment = (session: string, returnTo: string | null): string => {
  const params = new URLSearchParams({ session });
  if (returnTo) params.set('return_to', returnTo);
  return params.toString();
};

const redirectTo = (c: AuthedContext, url: string) => c.redirect(url, 302);

export const oauthCallback = async (c: AuthedContext) => {
  const providerId = c.req.param('provider')!;
  const url = new URL(c.req.url);
  const errParam = url.searchParams.get('error');
  if (errParam) return redirectTo(c, `/login?error=${encodeURIComponent(errParam)}`);

  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  if (!code || !stateToken) return redirectTo(c, '/login?error=missing-code');

  const stateResult = await verifyOauthState(stateToken);
  if (!stateResult.ok) return redirectTo(c, `/login?error=state-${stateResult.reason}`);
  const state = stateResult.payload;
  if (state.providerId !== providerId) return redirectTo(c, '/login?error=state-provider-mismatch');

  const provider = getOAuthProvider(providerId);
  if (!provider) return redirectTo(c, '/login?error=unknown-provider');

  const redirectUri = redirectUriFor(providerId);
  let identity: { subject: string; email: string | null };
  try {
    const tokens = await provider.exchangeCode({ code, codeVerifier: state.codeVerifier, redirectUri, fetcher: directFetcher });
    identity = await provider.fetchUserInfo({ accessToken: tokens.accessToken, idToken: tokens.idToken, fetcher: directFetcher });
  } catch {
    return redirectTo(c, '/login?error=oauth-exchange-failed');
  }

  const repo = getRepo();
  if (state.intent === 'login') {
    const link = await repo.userOauthIdentities.getBySubject(providerId, identity.subject);
    if (!link) return redirectTo(c, '/login?error=not-enrolled');
    const user = await repo.users.getById(link.userId);
    if (!user) return redirectTo(c, '/login?error=user-missing');
    const session = await repo.sessions.create(user.id);
    return redirectTo(c, `/oauth/handoff#${encodeHandoffFragment(session.id, state.returnTo)}`);
  }

  if (state.linkUserId === null) return redirectTo(c, '/login?error=state-missing-user');
  const currentSessionToken = c.req.header('x-floway-session');
  const currentSession = currentSessionToken ? await repo.sessions.getByIdAndTouch(currentSessionToken) : null;
  if (!currentSession || currentSession.userId !== state.linkUserId) {
    return redirectTo(c, '/login?error=link-session-lost');
  }
  const existing = await repo.userOauthIdentities.getBySubject(providerId, identity.subject);
  if (existing && existing.userId !== state.linkUserId) {
    return redirectTo(c, '/dashboard/settings/identities?error=already-linked');
  }
  if (!existing) {
    const row: UserOauthIdentity = {
      userId: state.linkUserId,
      providerId,
      subject: identity.subject,
      email: identity.email,
      linkedAt: new Date().toISOString(),
    };
    await repo.userOauthIdentities.link(row);
  }
  return redirectTo(c, `/dashboard/settings/identities?linked=${encodeURIComponent(providerId)}`);
};
