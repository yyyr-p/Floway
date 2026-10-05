// Antigravity Google OAuth: authorization-code flow with PKCE (S256), token
// exchange, and refresh — all against Google's standard OAuth endpoints. The
// client pair is the Antigravity IDE's own (see oauth-client.ts); scopes and
// redirect URI match what the desktop app requests so the grant fingerprint
// is indistinguishable.
//
// Wire reference — CLIProxyAPI's implementation:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
// and constants:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/antigravity/constants.go

import {
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_OAUTH_SCOPE,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_TOKEN_URL,
} from './constants.ts';
import { antigravityClientId, antigravityClientSecret } from './oauth-client.ts';
import { type Fetcher } from '@floway-dev/provider';

// Token response from Google's /token endpoint. Google rotates the refresh
// token on refresh round-trips only when it chooses to — the `refresh_token`
// key is absent from most refresh responses and present on exchanges, so
// every consumer must tolerate `undefined` and keep the previous value then.
export interface AntigravityOAuthTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

// Errors that mean the credential is dead — only a fresh operator sign-in
// recovers. Google's terminal refresh code is `invalid_grant` (covers both
// revoked and expired refresh tokens).
// https://developers.google.com/identity/protocols/oauth2/refresher-token
const REFRESH_TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export class AntigravityOAuthSessionTerminatedError extends Error {
  readonly code: string;
  readonly upstreamMessage: string;
  constructor(args: { code: string; message: string }) {
    super(`Antigravity OAuth session terminated: ${args.message}`);
    this.name = 'AntigravityOAuthSessionTerminatedError';
    this.code = args.code;
    this.upstreamMessage = args.message;
  }
}

// PKCE pair for the authorize step. The verifier rides the control-plane
// exchange body back; only the challenge goes on the authorize URL.
// https://developers.google.com/identity/protocols/oauth2/native-app
export interface AntigravityPkcePair {
  verifier: string;
  challenge: string;
}

export const buildAntigravityAuthorizeUrl = (args: { state: string; codeChallenge: string }): string => {
  const params = new URLSearchParams({
    client_id: antigravityClientId(),
    response_type: 'code',
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    scope: ANTIGRAVITY_OAUTH_SCOPE,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
    // The installed-app flow wants out-of-band-ish UX parity with the IDE:
    // consent re-auth is skipped for an already-granted client.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`;
};

const antigravityTokenRequest = async (
  body: Record<string, string>,
  terminalCodes: ReadonlySet<string>,
  fetcher: Fetcher,
): Promise<AntigravityOAuthTokenResponse> => {
  const response = await fetcher(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // Google's token endpoint is UA-agnostic; the real client's transport
      // is a Node google-api client. The literal match keeps the fingerprint
      // aligned with CLIProxyAPI's observation.
      'x-goog-api-client': 'gl-node/22.21.1',
    },
    body: new URLSearchParams(body).toString(),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch (cause) {
    throw new Error(
      `Antigravity OAuth /token returned ${response.status} with non-JSON body: ${rawText.slice(0, 256)}`,
      { cause },
    );
  }

  const root = (typeof parsed === 'object' && parsed !== null) ? (parsed as Record<string, unknown>) : null;

  if (!response.ok) {
    const code = typeof root?.error === 'string' ? root.error : null;
    // Google surfaces the human-readable detail in `error_description`.
    const message = (typeof root?.error_description === 'string' ? root.error_description : null)
      ?? code
      ?? rawText.slice(0, 256);
    if (code && terminalCodes.has(code)) {
      throw new AntigravityOAuthSessionTerminatedError({ code, message });
    }
    throw new Error(`Antigravity OAuth /token returned ${response.status}: ${message}`);
  }

  if (root === null) throw new Error('Antigravity OAuth /token response is not an object');
  if (typeof root.access_token !== 'string' || root.access_token === '') {
    throw new Error('Antigravity OAuth /token response missing access_token');
  }
  if (typeof root.expires_in !== 'number' || !Number.isFinite(root.expires_in)) {
    throw new Error('Antigravity OAuth /token response missing expires_in');
  }
  if (root.refresh_token !== undefined && (typeof root.refresh_token !== 'string' || root.refresh_token === '')) {
    throw new Error('Antigravity OAuth /token response carries non-string refresh_token');
  }
  if (typeof root.scope !== 'string') {
    throw new Error('Antigravity OAuth /token response missing scope');
  }
  if (typeof root.token_type !== 'string') {
    throw new Error('Antigravity OAuth /token response missing token_type');
  }
  return {
    access_token: root.access_token,
    expires_in: root.expires_in,
    refresh_token: typeof root.refresh_token === 'string' ? root.refresh_token : undefined,
    scope: root.scope,
    token_type: root.token_type,
  };
};

// Authorization-code exchange after the operator pastes the callback URL (or
// the local loopback listener catches it). Google's client credentials ride
// the body — this client is public (installed-app class), so no Basic auth.
export const exchangeAntigravityAuthorizationCode = async (opts: {
  code: string;
  codeVerifier: string;
  fetcher: Fetcher;
}): Promise<AntigravityOAuthTokenResponse> => {
  const body = {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: antigravityClientId(),
    client_secret: antigravityClientSecret(),
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    code_verifier: opts.codeVerifier,
  };
  return await antigravityTokenRequest(body, REFRESH_TERMINAL_OAUTH_CODES, opts.fetcher);
};

// Refresh round-trip. Google typically does NOT rotate the refresh token on
// refresh; when the response omits `refresh_token` the caller keeps the
// stored one.
export const refreshAntigravityAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
): Promise<AntigravityOAuthTokenResponse> => {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: antigravityClientId(),
    client_secret: antigravityClientSecret(),
  };
  return await antigravityTokenRequest(body, REFRESH_TERMINAL_OAUTH_CODES, fetcher);
};
