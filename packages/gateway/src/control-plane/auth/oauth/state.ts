// HMAC-SHA256-signed OAuth state parameter.
//
// The state carries every piece of context the callback handler needs to
// resume the flow without any server-side pending table: the intent
// (login vs link), the target user for a link, the PKCE verifier the
// authorize step generated, an expiry, and a nonce. The signature closes
// the loop against tampering, and the exp bounds replay.

import { getEnv } from '@floway-dev/platform';

const HMAC_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const;
const DEFAULT_TTL_SECONDS = 10 * 60;
const NONCE_BYTES = 16;

export interface OauthStatePayload {
  nonce: string;
  providerId: string;
  intent: 'login' | 'link';
  linkUserId: number | null;
  returnTo: string | null;
  codeVerifier: string;
  exp: number;
}

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value: string): Uint8Array | null => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

const importKey = async (): Promise<CryptoKey> => {
  const secret = getEnv('SESSION_HMAC_SECRET');
  if (secret.length < 32) {
    throw new Error('SESSION_HMAC_SECRET must be at least 32 characters');
  }
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), HMAC_ALGORITHM, false, ['sign', 'verify']);
};

export const randomNonce = (): string => {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

export const signOauthState = async (input: Omit<OauthStatePayload, 'exp' | 'nonce'> & { ttlSeconds?: number }): Promise<{ token: string; payload: OauthStatePayload }> => {
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const payload: OauthStatePayload = {
    nonce: randomNonce(),
    providerId: input.providerId,
    intent: input.intent,
    linkUserId: input.linkUserId,
    returnTo: input.returnTo,
    codeVerifier: input.codeVerifier,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importKey();
  const sig = new Uint8Array(await crypto.subtle.sign(HMAC_ALGORITHM, key, new TextEncoder().encode(body)));
  return { token: `${body}.${bytesToBase64Url(sig)}`, payload };
};

export type OauthStateVerifyResult =
  | { ok: true; payload: OauthStatePayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export const verifyOauthState = async (token: string): Promise<OauthStateVerifyResult> => {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const sig = base64UrlToBytes(sigB64);
  if (!sig) return { ok: false, reason: 'malformed' };

  const key = await importKey();
  const expected = new Uint8Array(await crypto.subtle.sign(HMAC_ALGORITHM, key, new TextEncoder().encode(body)));
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: 'bad-signature' };

  const decoded = base64UrlToBytes(body);
  if (!decoded) return { ok: false, reason: 'malformed' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayload(parsed)) return { ok: false, reason: 'malformed' };
  if (parsed.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed };
};

const isPayload = (value: unknown): value is OauthStatePayload => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nonce === 'string' &&
    typeof v.providerId === 'string' &&
    (v.intent === 'login' || v.intent === 'link') &&
    (v.linkUserId === null || typeof v.linkUserId === 'number') &&
    (v.returnTo === null || typeof v.returnTo === 'string') &&
    typeof v.codeVerifier === 'string' &&
    typeof v.exp === 'number'
  );
};
