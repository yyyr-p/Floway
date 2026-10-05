import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo, UsageLimitReservationInput, UsageRecord } from '../../src/repo/types.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const backends: { name: string; make: () => Promise<Repo> }[] = [
  { name: 'sql', make: async () => new SqlRepo(await createSqliteTestDb()) },
  { name: 'memory', make: () => Promise.resolve(new InMemoryRepo()) },
];

const apiKey = (id: string, userId: number): ApiKey => ({
  id,
  userId,
  name: id,
  key: `raw-${id}`,
  serverSecret: String(userId).padStart(2, '0').repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
});

const usage = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'key-1',
  model: 'model',
  upstream: 'upstream',
  modelKey: 'model',
  hour: '2026-06-01T12',
  pricingSelector: {},
  requests: 1,
  metrics: [],
  ...overrides,
});

const reservation = (overrides: Partial<UsageLimitReservationInput> = {}): UsageLimitReservationInput => ({
  id: crypto.randomUUID(),
  keyId: 'key-1',
  userId: 1,
  now: '2026-06-01T12:30:00.000Z',
  expiresAt: '2026-06-02T12:30:00.000Z',
  inputTokens: 10,
  outputTokens: 20,
  maxUnitPriceUsd: null,
  ...overrides,
});

for (const backend of backends) {
  test(`[${backend.name}] usage limits admit multiple in-flight reservations atomically`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: 100, maxCostUsd: null });

    const requests = Array.from({ length: 4 }, (_, index) => reservation({ id: `request-${index}` }));
    const results = await Promise.all(requests.map(input => repo.usageLimits.reserve(input)));
    assertEquals(results.filter(result => result.ok).length, 3);
    assertEquals(results.filter(result => !result.ok), [{ ok: false, reason: 'tokens' }]);
  });

  test(`[${backend.name}] usage limits use UTC calendar windows and reset at month boundaries`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'month', maxTokens: 100, maxCostUsd: null });
    await repo.usage.record(usage({
      hour: '2026-06-30T23',
      metrics: [{ metric: 'input_tokens', quantity: '90', unitPrice: null }],
    }));

    const beforeReset = await repo.usageLimits.reserve(reservation({
      id: 'june-request', now: '2026-06-30T23:59:59.999Z', expiresAt: '2026-07-01T23:59:59.999Z',
      inputTokens: 10, outputTokens: 0,
    }));
    const afterReset = await repo.usageLimits.reserve(reservation({
      id: 'july-request', now: '2026-07-01T00:00:00.000Z', expiresAt: '2026-07-02T00:00:00.000Z',
      inputTokens: 100, outputTokens: 0,
    }));

    assertEquals(beforeReset, { ok: true, limited: true });
    assertEquals(afterReset, { ok: true, limited: true });
  });

  test(`[${backend.name}] cost limits fail closed for unpriced historical requests and metrics`, async () => {
    for (const previousUsage of [
      usage(),
      usage({ metrics: [{ metric: 'input_tokens', quantity: '10', unitPrice: null }] }),
    ]) {
      const repo = await backend.make();
      await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: null, maxCostUsd: '1' });
      await repo.usage.record(previousUsage);

      const result = await repo.usageLimits.reserve(reservation({ maxUnitPriceUsd: '0.000001' }));
      assertEquals(result, { ok: false, reason: 'historical-cost-unpriced' });
    }
  });

  test(`[${backend.name}] cost limits retain unmetered request counts beside priced metrics`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: null, maxCostUsd: '1' });
    await repo.usage.record(usage({ metrics: [{ metric: 'input_tokens', quantity: '10', unitPrice: '0.000001' }] }));
    await repo.usage.record(usage({ metrics: [] }));

    const [aggregate] = await repo.usage.query({ keyIds: ['key-1'], start: '2026-06-01T00', end: '2026-06-02T00' });
    assertEquals(aggregate?.requests, 2);
    assertEquals(aggregate?.unmeteredRequests, 1);
    assertEquals(aggregate?.metrics, [{ metric: 'input_tokens', quantity: '10', unitPrice: '0.000001' }]);
    assertEquals(await repo.usageLimits.reserve(reservation({ maxUnitPriceUsd: '0.000001' })), { ok: false, reason: 'historical-cost-unpriced' });
  });

  test(`[${backend.name}] usage rejects unmetered counts outside the request total`, async () => {
    const repo = await backend.make();
    await assertRejects(
      () => Promise.resolve().then(() => repo.usage.record(usage({ requests: 2, unmeteredRequests: 3 }))),
      RangeError,
      'usage unmeteredRequests must be null or a non-negative safe integer not exceeding requests',
    );
    assertEquals(await repo.usage.listAll(), []);
  });

  test(`[${backend.name}] token admission sums fractional usage metrics instead of truncating them`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: 3, maxCostUsd: null });
    await repo.usage.record(usage({
      metrics: [
        { metric: 'input_tokens', quantity: '0.6', unitPrice: null },
        { metric: 'output_tokens', quantity: '0.6', unitPrice: null },
      ],
    }));

    assertEquals(await repo.usageLimits.reserve(reservation({ id: 'fractional-fit', inputTokens: 1, outputTokens: 0 })), { ok: true, limited: true });
    assertEquals(await repo.usageLimits.reserve(reservation({ id: 'fractional-over', inputTokens: 2, outputTokens: 0 })), { ok: false, reason: 'tokens' });
  });

  test(`[${backend.name}] cost reservations are corrected to settled usage before another admission`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: null, maxCostUsd: '0.0001' });

    const first = reservation({ id: 'cost-first', maxUnitPriceUsd: '0.000001', inputTokens: 10, outputTokens: 50 });
    assertEquals(await repo.usageLimits.reserve(first), { ok: true, limited: true });
    assertEquals(await repo.usageLimits.reserve(reservation({ id: 'cost-second', maxUnitPriceUsd: '0.000001', inputTokens: 10, outputTokens: 50 })), { ok: false, reason: 'cost' });

    await repo.usage.record(usage({ metrics: [{ metric: 'input_tokens', quantity: '25', unitPrice: '0.000001' }] }));
    await repo.usageLimits.release(first.id);
    assertEquals(await repo.usageLimits.reserve(reservation({ id: 'cost-after-settlement', maxUnitPriceUsd: '0.000001', inputTokens: 10, outputTokens: 50 })), { ok: true, limited: true });
  });

  test(`[${backend.name}] cost reservations round sub-micro dollar prices upward`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: null, maxCostUsd: '0.000002' });
    const request = (id: string) => reservation({ id, inputTokens: 1, outputTokens: 0, maxUnitPriceUsd: '0.0000001' });

    assertEquals(await repo.usageLimits.reserve(request('sub-micro-first')), { ok: true, limited: true });
    assertEquals(await repo.usageLimits.reserve(request('sub-micro-second')), { ok: true, limited: true });
    assertEquals(await repo.usageLimits.reserve(request('sub-micro-third')), { ok: false, reason: 'cost' });
  });

  test(`[${backend.name}] configured cost limits retain micro-dollar precision`, async () => {
    const repo = await backend.make();
    await assertRejects(() => repo.usageLimits.save({
      principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: null, maxCostUsd: '0.0000001',
    }), TypeError, 'usage limit cost supports at most six fractional digits');
  });

  test(`[${backend.name}] missing output caps reserve remaining token and cost capacity`, async () => {
    const repo = await backend.make();
    await repo.usageLimits.save({ principalType: 'key', principalId: 'key-1', window: 'day', maxTokens: 100, maxCostUsd: '0.0001' });
    const request = (id: string) => reservation({ id, outputTokens: null, maxUnitPriceUsd: '0.000001' });

    assertEquals(await repo.usageLimits.reserve(request('uncapped-first')), { ok: true, limited: true });
    assertEquals(await repo.usageLimits.reserve(request('uncapped-second')), { ok: false, reason: 'tokens' });
  });

  test(`[${backend.name}] user limits aggregate only the user's API keys`, async () => {
    const repo = await backend.make();
    await repo.apiKeys.save(apiKey('key-1', 1));
    await repo.apiKeys.save(apiKey('key-2', 2));
    await repo.usageLimits.save({ principalType: 'user', principalId: 1, window: 'day', maxTokens: 10, maxCostUsd: null });

    const otherUser = await repo.usageLimits.reserve(reservation({ id: 'other-user', keyId: 'key-2', userId: 2 }));
    const limitedUser = await repo.usageLimits.reserve(reservation({ id: 'limited-user', keyId: 'key-1', userId: 1, outputTokens: 0 }));

    assertEquals(otherUser, { ok: true, limited: false });
    assertEquals(limitedUser, { ok: true, limited: true });
  });
}
