import { GenericOidcProvider, type GenericOidcProviderConfig } from './generic-oidc.ts';
import type { OAuthProvider } from './provider.ts';
import { getEnvOptional } from '@floway-dev/platform';

// The registry is built once per process from FLOWAY_OAUTH_PROVIDERS_JSON.
// The lazy build lets test code override the env before the first read;
// production paths read the env once at boot.

let cached: Map<string, OAuthProvider> | null = null;

const parseConfigs = (raw: string): GenericOidcProviderConfig[] => {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(`FLOWAY_OAUTH_PROVIDERS_JSON is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('FLOWAY_OAUTH_PROVIDERS_JSON must be a JSON array');
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`FLOWAY_OAUTH_PROVIDERS_JSON[${i}] is not an object`);
    const e = entry as Record<string, unknown>;
    const require = (field: string): string => {
      const v = e[field];
      if (typeof v !== 'string' || v === '') throw new Error(`FLOWAY_OAUTH_PROVIDERS_JSON[${i}].${field} must be a non-empty string`);
      return v;
    };
    const scopes = e.scopes === undefined ? undefined : e.scopes;
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every(s => typeof s === 'string'))) {
      throw new Error(`FLOWAY_OAUTH_PROVIDERS_JSON[${i}].scopes must be a string array`);
    }
    return {
      id: require('id'),
      displayName: require('displayName'),
      issuer: require('issuer'),
      clientId: require('clientId'),
      clientSecret: require('clientSecret'),
      scopes: scopes as readonly string[] | undefined,
    };
  });
};

const build = (): Map<string, OAuthProvider> => {
  const raw = getEnvOptional('FLOWAY_OAUTH_PROVIDERS_JSON', '');
  const configs = parseConfigs(raw);
  const map = new Map<string, OAuthProvider>();
  for (const config of configs) {
    if (map.has(config.id)) throw new Error(`Duplicate OAuth provider id: ${config.id}`);
    map.set(config.id, new GenericOidcProvider(config));
  }
  return map;
};

export const listOAuthProviders = (): OAuthProvider[] => {
  cached ??= build();
  return [...cached.values()];
};

export const getOAuthProvider = (id: string): OAuthProvider | null => {
  cached ??= build();
  return cached.get(id) ?? null;
};

// Test-only hook: force a rebuild on the next read. Production code never
// invalidates because providers are boot-time config.
export const resetOAuthProviderRegistryForTesting = (): void => {
  cached = null;
};

// The public origin the OAuth server should redirect to. Kept separate
// from any request-Host inference: behind a reverse proxy the request
// origin is unreliable, and the redirect_uri MUST be byte-identical
// between authorize and token-exchange.
export const publicOrigin = (): string => {
  const value = getEnvOptional('FLOWAY_PUBLIC_ORIGIN', '');
  if (value === '') throw new Error('FLOWAY_PUBLIC_ORIGIN is required when OAuth providers are configured');
  return value.replace(/\/+$/, '');
};

export const redirectUriFor = (providerId: string): string => `${publicOrigin()}/auth/oauth/${encodeURIComponent(providerId)}/callback`;
