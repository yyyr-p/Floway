import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { signOauthState, verifyOauthState } from './state.ts';
import { initEnv } from '@floway-dev/platform';

const SECRET = 'x'.repeat(64);

beforeEach(() => {
  initEnv(name => (name === 'SESSION_HMAC_SECRET' ? SECRET : undefined));
});

afterEach(() => {
  initEnv(() => undefined);
});

const validInput = () => ({
  providerId: 'corp',
  intent: 'login' as const,
  linkUserId: null,
  returnTo: '/dashboard',
  codeVerifier: 'v'.repeat(64),
});

describe('signOauthState / verifyOauthState', () => {
  test('round-trip recovers the payload verbatim', async () => {
    const { token, payload } = await signOauthState(validInput());
    const result = await verifyOauthState(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  test('two consecutive signs produce distinct nonces', async () => {
    const a = await signOauthState(validInput());
    const b = await signOauthState(validInput());
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.token).not.toBe(b.token);
  });

  test('tampering with the body invalidates the signature', async () => {
    const { token } = await signOauthState(validInput());
    const [body, sig] = token.split('.');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    decoded.intent = 'link';
    decoded.linkUserId = 99;
    const forgedBody = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const result = await verifyOauthState(`${forgedBody}.${sig}`);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('truncated signature rejected', async () => {
    const { token } = await signOauthState(validInput());
    const [body, sig] = token.split('.');
    const result = await verifyOauthState(`${body}.${sig.slice(0, sig.length - 4)}`);
    expect(result.ok).toBe(false);
  });

  test('expired payload rejected', async () => {
    const { token } = await signOauthState({ ...validInput(), ttlSeconds: -1 });
    const result = await verifyOauthState(token);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  test('malformed token rejected', async () => {
    expect(await verifyOauthState('not-a-token')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyOauthState('a.b.c')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyOauthState('')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('verification with a different key fails', async () => {
    const { token } = await signOauthState(validInput());
    initEnv(name => (name === 'SESSION_HMAC_SECRET' ? 'y'.repeat(64) : undefined));
    const result = await verifyOauthState(token);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('sign refuses a too-short secret', async () => {
    initEnv(name => (name === 'SESSION_HMAC_SECRET' ? 'short' : undefined));
    await expect(signOauthState(validInput())).rejects.toThrow(/at least 32/);
  });

  test('link intent preserves linkUserId', async () => {
    const { token } = await signOauthState({ ...validInput(), intent: 'link', linkUserId: 42 });
    const result = await verifyOauthState(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.intent).toBe('link');
      expect(result.payload.linkUserId).toBe(42);
    }
  });
});
