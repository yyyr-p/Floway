import type { Fetcher } from '@floway-dev/provider';

export interface OAuthProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): Promise<string>;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; fetcher: Fetcher }): Promise<{ accessToken: string; idToken?: string }>;
  fetchUserInfo(input: { accessToken: string; idToken?: string; fetcher: Fetcher }): Promise<{ subject: string; email: string | null }>;
}

export interface OAuthProviderPublicInfo {
  id: string;
  displayName: string;
}

export const providerPublicInfo = (p: OAuthProvider): OAuthProviderPublicInfo => ({
  id: p.providerId,
  displayName: p.displayName,
});
