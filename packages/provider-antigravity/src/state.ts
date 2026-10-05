// Gateway-managed Antigravity credential state, persisted in
// upstreams.state_json and written via UpstreamRepo.saveState (read-modify-CAS).
//
// Shape: the rotating refresh token + the cached short-lived access token +
// the Cloud Code project id. The project id lives in state rather than
// config because the data plane re-derives it lazily (loadCodeAssist /
// onboardUser) when an import finished before onboarding completed — a write
// the operator never performs by hand.

// Short-lived OAuth access token minted by the stored refresh token.
// `expiresAt` is unix ms; `refreshedAt` is ISO 8601.
export interface AntigravityAccessTokenEntry {
  token: string;
  expiresAt: number;
  refreshedAt: string;
}

// One account's gateway-written credential state. Antigravity has a single
// credential class (pure OAuth — no setup-token analog), so unlike the
// Claude Code shape there is no `tokenKind` axis.
export type AntigravityAccountCredential =
  & AntigravityAccountCredentialBase
  & AntigravityAccountCredentialHealth;

interface AntigravityAccountCredentialBase {
  // Correlates to config.accounts[0]; kept on the credential so log lines
  // and the dashboard carry identity even while health is degraded.
  email: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). Required on the wire.
  stateUpdatedAt: string;
  refreshToken: string;
  accessToken: AntigravityAccessTokenEntry | null;
  // The Cloud Code project id bound to data-plane calls. Re-derived lazily
  // by the access-token module when null (a half-finished import).
  projectId: string | null;
}

// `active` carries no message; terminal states carry the upstream's terminal
// message. Same axis model as the Claude Code credential: an OAuth refresh
// either works or the credential is dead (Google's terminal refresh code is
// `invalid_grant`), so the terminal bucket is one state.
type AntigravityAccountCredentialHealth =
  | { state: 'active'; stateMessage?: undefined }
  | { state: 'refresh_failed'; stateMessage: string };

export interface AntigravityUpstreamState {
  accounts: AntigravityAccountCredential[];
}

// Strict shape gate shared by every asserter in this file: rejects unknown
// keys so a stale field on disk surfaces loudly instead of silently shipping
// to the dashboard.
const assertOnlyKeys = (obj: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
};

const ACCESS_TOKEN_KEYS = ['token', 'expiresAt', 'refreshedAt'] as const;
const CREDENTIAL_KEYS = ['email', 'stateUpdatedAt', 'refreshToken', 'state', 'stateMessage', 'accessToken', 'projectId'] as const;
const STATE_KEYS = ['accounts'] as const;

const assertAntigravityAccessTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, ACCESS_TOKEN_KEYS, where);
  if (typeof obj.token !== 'string' || obj.token === '') {
    throw new TypeError(`${where}.token must be a non-empty string`);
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new TypeError(`${where}.expiresAt must be a finite number`);
  }
  if (typeof obj.refreshedAt !== 'string' || obj.refreshedAt === '') {
    throw new TypeError(`${where}.refreshedAt must be a non-empty string`);
  }
};

const assertAntigravityAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, CREDENTIAL_KEYS, where);
  if (typeof obj.email !== 'string' || obj.email === '') {
    throw new TypeError(`${where}.email must be a non-empty string`);
  }
  if (typeof obj.stateUpdatedAt !== 'string' || obj.stateUpdatedAt === '') {
    throw new TypeError(`${where}.stateUpdatedAt must be a non-empty ISO string`);
  }
  if (typeof obj.refreshToken !== 'string' || obj.refreshToken === '') {
    throw new TypeError(`${where}.refreshToken must be a non-empty string`);
  }
  if (obj.state !== 'active' && obj.state !== 'refresh_failed') {
    throw new TypeError(`${where}.state must be one of 'active' | 'refresh_failed', got ${String(obj.state)}`);
  }
  // Terminal states carry the upstream's terminal message; 'active' must not.
  if (obj.state === 'active') {
    if (obj.stateMessage !== undefined) {
      throw new TypeError(`${where}.stateMessage must be absent on active state`);
    }
  } else if (typeof obj.stateMessage !== 'string' || obj.stateMessage === '') {
    throw new TypeError(`${where}.stateMessage must be a non-empty string on terminal state`);
  }
  if (obj.accessToken !== null) {
    assertAntigravityAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
  if (obj.projectId !== null && (typeof obj.projectId !== 'string' || obj.projectId === '')) {
    throw new TypeError(`${where}.projectId must be null or a non-empty string`);
  }
};

export function assertAntigravityUpstreamState(value: unknown): asserts value is AntigravityUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('AntigravityUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, STATE_KEYS, 'AntigravityUpstreamState');
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('AntigravityUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`AntigravityUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertAntigravityAccountCredential(obj.accounts[i], `AntigravityUpstreamState.accounts[${i}]`);
  }
}

// Asserts the wire shape and returns the typed view. The asserter rejects
// absent `accessToken` / `projectId` keys (they must be explicit `null` when
// not populated). Every write supplies every field explicitly.
export const readAntigravityUpstreamState = (raw: unknown): AntigravityUpstreamState => {
  assertAntigravityUpstreamState(raw);
  return raw;
};

// Immutable patch helper: replace the sole account by running `patch` over
// it. The asserter pins `accounts` to exactly one entry, so this helper
// always rewrites index 0; encoding that invariant in the name keeps call
// sites free of a `0` literal whose meaning would otherwise have to be
// re-derived on every read.
export const replaceSoleAccount = (
  state: AntigravityUpstreamState,
  patch: (account: AntigravityAccountCredential) => AntigravityAccountCredential,
): AntigravityUpstreamState => ({
  ...state,
  accounts: [patch(state.accounts[0])],
});
