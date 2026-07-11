import type { OAuthProvider } from './provider.ts';
import type { Fetcher } from '@floway-dev/provider';

// One instance of this class corresponds to one entry in
// FLOWAY_OAUTH_PROVIDERS_JSON. Endpoints come from the issuer's
// /.well-known/openid-configuration, fetched lazily on the first
// authorizeUrl / exchangeCode call and then cached for the lifetime of
// this instance.

export interface GenericOidcProviderConfig {
  id: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
}

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const;

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

export class GenericOidcProvider implements OAuthProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly issuer: string;
  private metadata: OidcMetadata | null = null;
  private metadataPromise: Promise<OidcMetadata> | null = null;

  constructor(config: GenericOidcProviderConfig) {
    this.providerId = config.id;
    this.displayName = config.displayName;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.scopes = config.scopes && config.scopes.length > 0 ? config.scopes : DEFAULT_SCOPES;
    this.issuer = trimSlash(config.issuer);
  }

  private async loadMetadata(fetcher: Fetcher): Promise<OidcMetadata> {
    if (this.metadata) return this.metadata;
    this.metadataPromise ??= (async () => {
      const res = await fetcher(`${this.issuer}/.well-known/openid-configuration`, { method: 'GET' });
      if (!res.ok) throw new Error(`OIDC discovery failed for ${this.providerId}: HTTP ${res.status}`);
      const body = (await res.json()) as Partial<OidcMetadata>;
      if (typeof body.authorization_endpoint !== 'string' || typeof body.token_endpoint !== 'string') {
        throw new Error(`OIDC discovery for ${this.providerId} is missing authorization_endpoint or token_endpoint`);
      }
      this.metadata = {
        authorization_endpoint: body.authorization_endpoint,
        token_endpoint: body.token_endpoint,
        userinfo_endpoint: body.userinfo_endpoint,
      };
      return this.metadata;
    })();
    try {
      return await this.metadataPromise;
    } finally {
      this.metadataPromise = null;
    }
  }

  async authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string; fetcher?: Fetcher }): Promise<string> {
    const fetcher = input.fetcher ?? ((url, init) => fetch(url, init));
    const md = await this.loadMetadata(fetcher);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      scope: this.scopes.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${md.authorization_endpoint}?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; fetcher: Fetcher }): Promise<{ accessToken: string; idToken?: string }> {
    const md = await this.loadMetadata(input.fetcher);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: input.codeVerifier,
    });
    const res = await input.fetcher(md.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`token exchange failed for ${this.providerId}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = (await res.json()) as { access_token?: string; id_token?: string };
    if (typeof parsed.access_token !== 'string') {
      throw new Error(`token exchange for ${this.providerId} returned no access_token`);
    }
    return { accessToken: parsed.access_token, idToken: typeof parsed.id_token === 'string' ? parsed.id_token : undefined };
  }

  async fetchUserInfo(input: { accessToken: string; idToken?: string; fetcher: Fetcher }): Promise<{ subject: string; email: string | null }> {
    const md = await this.loadMetadata(input.fetcher);
    if (!md.userinfo_endpoint) {
      // Fall back to the id_token, which OIDC providers are required to emit
      // for openid scope. Signature is trusted here (TLS to a configured
      // issuer, same posture as provider-codex/jwt.ts).
      if (!input.idToken) throw new Error(`provider ${this.providerId} has no userinfo endpoint and returned no id_token`);
      const claims = decodeIdToken(input.idToken);
      return { subject: claims.sub, email: claims.email ?? null };
    }
    const res = await input.fetcher(md.userinfo_endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`userinfo failed for ${this.providerId}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { sub?: string; email?: string };
    if (typeof body.sub !== 'string' || body.sub === '') {
      throw new Error(`userinfo for ${this.providerId} missing sub`);
    }
    return { subject: body.sub, email: typeof body.email === 'string' ? body.email : null };
  }
}

const decodeIdToken = (token: string): { sub: string; email?: string } => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('id_token is not a JWT');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)))) as { sub?: unknown; email?: unknown };
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('id_token missing sub');
  return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
};
