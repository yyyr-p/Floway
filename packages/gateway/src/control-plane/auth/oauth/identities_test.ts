import { afterEach, expect, test } from 'vitest';

import { requestApp, setupAppTest } from '../../../test-helpers.ts';
import { initEnv } from '@floway-dev/platform';

afterEach(() => {
  initEnv(() => undefined);
});

test('GET /api/users/me/identities lists the caller identities', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 1, providerId: 'corp', subject: 'sub-admin', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/me/identities', {
    method: 'GET',
    headers: { 'x-floway-session': adminSession },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { identities: { providerId: string; subject: string }[] };
  expect(body.identities.map(i => `${i.providerId}:${i.subject}`)).toEqual(['corp:sub-admin']);
});

test('GET /api/users/me/identities without a session is rejected', async () => {
  await setupAppTest();
  const res = await requestApp('/api/users/me/identities', { method: 'GET' });
  expect(res.status).toBe(401);
});

test('self-unlink removes a caller-owned identity', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 1, providerId: 'corp', subject: 'sub-a', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/me/identities/corp/sub-a/unlink', {
    method: 'POST',
    headers: { 'x-floway-session': adminSession },
  });
  expect(res.status).toBe(200);
  expect(await repo.userOauthIdentities.listByUserId(1)).toEqual([]);
});

test('self-unlink of an identity owned by someone else is 404', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'sub-other', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/me/identities/corp/sub-other/unlink', {
    method: 'POST',
    headers: { 'x-floway-session': adminSession },
  });
  expect(res.status).toBe(404);
});

test('self-unlink refuses to strip a passwordless user of their last credential', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'oauth-only',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-07-12T00:00:00.000Z',
    deletedAt: null,
  });
  await repo.userOauthIdentities.link({ userId: 3, providerId: 'corp', subject: 'sub-last', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const session = await repo.sessions.create(3);
  const res = await requestApp('/api/users/me/identities/corp/sub-last/unlink', {
    method: 'POST',
    headers: { 'x-floway-session': session.id },
  });
  expect(res.status).toBe(400);
  expect(await repo.userOauthIdentities.listByUserId(3)).toHaveLength(1);
});

test('admin can pre-link an identity to a user', async () => {
  const { repo, adminSession } = await setupAppTest();
  const res = await requestApp('/api/users/2/identities', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ providerId: 'corp', subject: 'sub-alice', email: 'a@b' }),
  });
  expect(res.status).toBe(201);
  expect(await repo.userOauthIdentities.listByUserId(2)).toHaveLength(1);
});

test('admin pre-link is idempotent for the same target user', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'sub-x', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/2/identities', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ providerId: 'corp', subject: 'sub-x' }),
  });
  expect(res.status).toBe(200);
});

test('admin pre-link rejects subject already bound to a different user', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'taken', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/1/identities', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ providerId: 'corp', subject: 'taken' }),
  });
  expect(res.status).toBe(409);
});

test('admin identity endpoints require admin', async () => {
  const { repo } = await setupAppTest();
  const session = await repo.sessions.create(2);
  const res = await requestApp('/api/users/2/identities', {
    method: 'GET',
    headers: { 'x-floway-session': session.id },
  });
  expect(res.status).toBe(403);
});

test('admin unlink removes a user identity', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'sub-a', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/2/identities/corp/sub-a', {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  expect(res.status).toBe(200);
  expect(await repo.userOauthIdentities.listByUserId(2)).toEqual([]);
});

test('deleteUser cascades identities', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.userOauthIdentities.link({ userId: 2, providerId: 'corp', subject: 'sub-a', email: null, linkedAt: '2026-07-12T00:00:00.000Z' });
  const res = await requestApp('/api/users/2', {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  expect(res.status).toBe(200);
  expect(await repo.userOauthIdentities.listByUserId(2)).toEqual([]);
});
