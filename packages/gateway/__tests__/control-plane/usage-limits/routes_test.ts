import { test, vi } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const jsonRequest = (session: string, method: string, body?: unknown) => requestApp('/api/usage-limits', {
  method,
  headers: { 'content-type': 'application/json', 'x-floway-session': session },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('admin can create, update, inspect current usage, and delete key limits', async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  const hour = new Date().toISOString().slice(0, 13);
  const dayStart = new Date(`${hour.slice(0, 10)}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const dayStamp = (date: Date) => date.toISOString().slice(0, 13);

  const created = await jsonRequest(adminSession, 'PUT', {
    principalType: 'key', principalId: apiKey.id, window: 'day', maxTokens: 100, maxCostUsd: '2',
  });
  assertEquals(created.status, 200);
  assertEquals((await created.json() as { ok: boolean }).ok, true);

  await repo.usage.record({
    keyId: apiKey.id,
    model: 'model',
    upstream: 'upstream',
    modelKey: 'model',
    hour,
    pricingSelector: {},
    requests: 1,
    metrics: [{ metric: 'input_tokens', quantity: '5', unitPrice: '0.01' }],
  });

  const snapshot = await requestApp('/api/usage-limits', { headers: { 'x-floway-session': adminSession } });
  assertEquals(snapshot.status, 200);
  const snapshotBody = await snapshot.json() as { limits: Array<{ usedTokens: number; usedCostUsd: string | null; maxTokens: number | null }> };
  assertEquals(snapshotBody.limits, [{
    principalType: 'key', principalId: apiKey.id, window: 'day', maxTokens: 100,
    maxCostUsd: '2', windowStart: dayStamp(dayStart), windowEnd: dayStamp(dayEnd),
    usedTokens: 5, usedCostUsd: '0.05',
  }]);

  const updated = await jsonRequest(adminSession, 'PUT', {
    principalType: 'key', principalId: apiKey.id, window: 'day', maxTokens: null, maxCostUsd: '0.5',
  });
  assertEquals(updated.status, 200);
  assertEquals(await repo.usageLimits.list(), [{
    principalType: 'key', principalId: apiKey.id, window: 'day', maxTokens: null, maxCostUsd: '0.5',
  }]);

  const removed = await requestApp(`/api/usage-limits/key/${apiKey.id}/day`, {
    method: 'DELETE', headers: { 'x-floway-session': adminSession },
  });
  assertEquals(removed.status, 200);
  assertEquals(await repo.usageLimits.list(), []);
});

test.each([1, null])('usage-limit summaries omit cost when unmetered requests are %s', async unmeteredRequests => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  await repo.usageLimits.save({
    principalType: 'key', principalId: apiKey.id, window: 'month', maxTokens: null, maxCostUsd: '2',
  });
  await repo.usage.record({
    keyId: apiKey.id,
    model: 'model',
    upstream: 'upstream',
    modelKey: 'model',
    hour,
    pricingSelector: {},
    requests: 2,
    unmeteredRequests,
    metrics: [{ metric: 'input_tokens', quantity: '5', unitPrice: '0.01' }],
  });

  const snapshot = await requestApp('/api/usage-limits', { headers: { 'x-floway-session': adminSession } });
  assertEquals(snapshot.status, 200);
  const body = await snapshot.json() as { limits: Array<{ usedCostUsd: string | null }> };
  assertEquals(body.limits[0]?.usedCostUsd, null);
});

test('usage-limit summaries keep zero-request cost at zero when the unmetered count is unknown', async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  const hour = new Date().toISOString().slice(0, 13);
  await repo.usageLimits.save({
    principalType: 'key', principalId: apiKey.id, window: 'month', maxTokens: null, maxCostUsd: '2',
  });
  await repo.usage.record({
    keyId: apiKey.id,
    model: 'model',
    upstream: 'upstream',
    modelKey: 'model',
    hour,
    pricingSelector: {},
    requests: 0,
    unmeteredRequests: null,
    metrics: [],
  });

  const snapshot = await requestApp('/api/usage-limits', { headers: { 'x-floway-session': adminSession } });
  assertEquals(snapshot.status, 200);
  const body = await snapshot.json() as { limits: Array<{ usedCostUsd: string | null }> };
  assertEquals(body.limits[0]?.usedCostUsd, '0');
});

test('usage-limit summaries use the queried UTC window across a month rollover', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-01-31T23:59:59.000Z'));
    const { adminSession, apiKey, repo } = await setupAppTest();
    await repo.usageLimits.save({
      principalType: 'key', principalId: apiKey.id, window: 'month', maxTokens: null, maxCostUsd: '2',
    });
    await repo.usage.record({
      keyId: apiKey.id,
      model: 'model',
      upstream: 'upstream',
      modelKey: 'model',
      hour: '2026-01-31T23',
      pricingSelector: {},
      requests: 1,
      metrics: [{ metric: 'input_tokens', quantity: '5', unitPrice: '0.01' }],
    });
    const query = repo.usage.query.bind(repo.usage);
    vi.spyOn(repo.usage, 'query').mockImplementation(async options => {
      vi.setSystemTime(new Date('2026-02-01T00:00:01.000Z'));
      return await query(options);
    });

    const snapshot = await requestApp('/api/usage-limits', { headers: { 'x-floway-session': adminSession } });
    assertEquals(snapshot.status, 200);
    const body = await snapshot.json() as { limits: Array<Record<string, unknown>> };
    assertEquals(body.limits, [{
      principalType: 'key', principalId: apiKey.id, window: 'month', maxTokens: null, maxCostUsd: '2',
      windowStart: '2026-01-01T00', windowEnd: '2026-02-01T00', usedTokens: 5, usedCostUsd: '0.05',
    }]);
  } finally {
    vi.useRealTimers();
  }
});

test('usage-limit admin routes reject non-admin callers, unknown principals, and empty policies', async () => {
  const { adminSession, apiKey } = await setupAppTest();

  const forbidden = await requestApp('/api/usage-limits', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(forbidden.status, 403);

  const unknown = await jsonRequest(adminSession, 'PUT', {
    principalType: 'key', principalId: 'key_unknown', window: 'day', maxTokens: 100, maxCostUsd: null,
  });
  assertEquals(unknown.status, 404);

  const empty = await jsonRequest(adminSession, 'PUT', {
    principalType: 'key', principalId: apiKey.id, window: 'day', maxTokens: null, maxCostUsd: null,
  });
  assertEquals(empty.status, 400);
});
