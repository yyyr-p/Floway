// OAuth2 domain types, separated from ../types.ts so fork's OAuth2 additions
// never share a file with upstream's type churn. The only cross-reference back
// into ../types.ts is a type-only import (`ApiKey`/`Session`/`User`), so the
// circular reference is erased at compile time and cannot become a runtime
// import cycle.

import type { ApiKey, Session, User } from '../types.ts';

export interface OAuth2Account {
  providerId: string;
  providerUserId: string;
  userId: number;
  providerLogin: string;
  createdAt: string;
  lastLoginAt: string;
}

export type OAuth2ClientAuthentication = 'client_secret_post' | 'client_secret_basic';

export type OAuth2AccessOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists';

export type OAuth2AccessCondition = {
  field: string;
  op: Exclude<OAuth2AccessOperator, 'exists' | 'not_exists'>;
  value: unknown;
} | {
  field: string;
  op: 'exists' | 'not_exists';
};

export interface OAuth2AccessPolicy {
  logic: 'and' | 'or';
  conditions: OAuth2AccessCondition[];
}

export interface OAuth2Provider {
  id: string;
  displayName: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  scopes: string[];
  clientAuthentication: OAuth2ClientAuthentication;
  userIdClaim: string | null;
  usernameClaim: string | null;
  authorizationParams: Record<string, string>;
  accessPolicy: OAuth2AccessPolicy;
  accessDeniedMessage: string;
  registrationUpstreamIds: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface OAuth2Settings {
  // Empty until an administrator configures the public dashboard origin.
  publicBaseUrl: string;
  updatedAt: string;
}

export interface OAuth2Authorization {
  providerId: string;
  codeVerifier: string;
  browserVerifierHash: string;
  userId: number | null;
  expiresAt: number;
}

export type OAuth2BindResult = 'bound' | 'user-not-found' | 'account-taken';
export type OAuth2UnlinkResult = 'deleted' | 'not-found' | 'last-login';

export interface OAuth2Handoff {
  tokenHash: string;
  providerId: string;
  providerUserId: string;
  providerLogin: string;
  userId: number | null;
  registrationUpstreamIds: string[] | null;
  createdAt: string;
  expiresAt: number;
}

export interface OAuth2RegistrationInput {
  tokenHash: string;
  username: string;
  createdAt: string;
  now: number;
  defaultKey: Omit<ApiKey, 'userId'>;
}

export type OAuth2RegistrationResult =
  | { status: 'created'; user: User; session: Session }
  | { status: 'missing' }
  | { status: 'username-taken' }
  | { status: 'account-taken' };

export interface OAuth2Repo {
  createAuthorization(stateHash: string, authorization: OAuth2Authorization): Promise<void>;
  takeAuthorization(stateHash: string, now: number): Promise<OAuth2Authorization | null>;
  findAccountAndTouch(providerId: string, providerUserId: string, providerLogin: string, now: string): Promise<OAuth2Account | null>;
  createHandoff(handoff: OAuth2Handoff): Promise<void>;
  getHandoff(tokenHash: string, now: number): Promise<OAuth2Handoff | null>;
  completeLogin(tokenHash: string, now: number): Promise<Session | null>;
  register(input: OAuth2RegistrationInput): Promise<OAuth2RegistrationResult>;
  listAccounts(): Promise<OAuth2Account[]>;
  listAccountsByUserId(userId: number): Promise<OAuth2Account[]>;
  bindAccount(account: OAuth2Account): Promise<OAuth2BindResult>;
  unlinkAccount(userId: number, providerId: string): Promise<OAuth2UnlinkResult>;
  saveAccount(account: OAuth2Account): Promise<void>;
  deleteByUserId(userId: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface OAuth2ConfigRepo {
  getSettings(): Promise<OAuth2Settings>;
  saveSettings(settings: OAuth2Settings): Promise<void>;
  listProviders(): Promise<OAuth2Provider[]>;
  getProviderById(id: string): Promise<OAuth2Provider | null>;
  insertProvider(provider: OAuth2Provider): Promise<boolean>;
  updateProvider(provider: OAuth2Provider): Promise<boolean>;
  saveProvider(provider: OAuth2Provider): Promise<void>;
  deleteProvider(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

// Fork's additions to upstream-owned interfaces: augment `Repo` with the
// OAuth2 sub-repos and `User` with the global-usage flag. Upstream keeps its
// own declarations in ../types.ts untouched — these merge at the type level.
declare module '../types.ts' {
  interface Repo {
    oauth2: OAuth2Repo;
    oauth2Config: OAuth2ConfigRepo;
  }
  interface User {
    canViewGlobalUsage: boolean;
  }
}
