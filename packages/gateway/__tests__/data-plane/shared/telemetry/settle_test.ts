import { beforeEach, expect, test } from 'vitest';

import { settle, settleUnpricedReservation } from '../../../../src/data-plane/shared/telemetry/settle.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';
import { assertEquals, mockPerfTelemetryContext } from '@floway-dev/test-utils';

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw',
  pricing: null,
};

const testPerformanceContext = mockPerfTelemetryContext({
  keyId: '',
  model: 'claude-test',
  upstream: 'copilot:1',
  runtimeLocation: 'SJC',
});

let repo: InMemoryRepo;
let background: Promise<unknown>[];
const ctx = ({ firstOutputTokenAt = null, upstreamCallStartedAt = null }: {
  firstOutputTokenAt?: number | null;
  upstreamCallStartedAt?: number | null;
} = {}) => mockGatewayCtx({
  apiKeyId: 'key_a',
  backgroundScheduler: promise => { background.push(promise); },
  attempt: { timing: { firstOutputTokenAt, upstreamCallStartedAt }, telemetry: undefined },
});

beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
  background = [];
});

// ── settle ──

test('settle records a usage row when the figure carries a billable metric', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, { input: 10, output: 5 }, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].keyId, 'key_a');
  assertEquals(tokenCountsFromUsage(rows[0]), { input: 10, output: 5 });
  assertEquals(rows[0].requests, 1);
});

test('settle records the request without metrics when usage is null', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, null, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, []);
});

test('settle records the request when usage carries no billable metric', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, {}, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, []);
});

test('a failed stream settles partial token usage before releasing its reservation', async () => {
  await repo.usageLimits.save({ principalType: 'key', principalId: 'key_a', window: 'hour', maxTokens: 100, maxCostUsd: null });
  const now = new Date();
  assertEquals(await repo.usageLimits.reserve({
    id: 'partial-stream', keyId: 'key_a', userId: 1, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), inputTokens: 80,
    outputTokens: 20, maxUnitPriceUsd: null,
  }), { ok: true, limited: true });

  const gatewayCtx = ctx();
  gatewayCtx.usageLimitReservationId = 'partial-stream';
  settle(gatewayCtx, testPerformanceContext, testTelemetryModelIdentity, { input: 10, output: 5 }, true);
  await Promise.all(background);

  const afterSettlement = await repo.usageLimits.reserve({
    id: 'after-partial-stream', keyId: 'key_a', userId: 1, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), inputTokens: 85,
    outputTokens: 0, maxUnitPriceUsd: null,
  });
  assertEquals(afterSettlement, { ok: true, limited: true });
});

test('an unpriced stream ending releases capacity but fails future cost admission closed', async () => {
  await repo.usageLimits.save({ principalType: 'key', principalId: 'key_a', window: 'hour', maxTokens: null, maxCostUsd: '1' });
  const now = new Date();
  assertEquals(await repo.usageLimits.reserve({
    id: 'unpriced-stream', keyId: 'key_a', userId: 1, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), inputTokens: 10,
    outputTokens: 10, maxUnitPriceUsd: '0.000001',
  }), { ok: true, limited: true });

  const gatewayCtx = ctx();
  gatewayCtx.usageLimitReservationId = 'unpriced-stream';
  settleUnpricedReservation(gatewayCtx, testTelemetryModelIdentity);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].metrics, []);
  const afterUnpricedSettlement = await repo.usageLimits.reserve({
    id: 'after-unpriced-stream', keyId: 'key_a', userId: 1, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), inputTokens: 10,
    outputTokens: 10, maxUnitPriceUsd: '0.000001',
  });
  assertEquals(afterUnpricedSettlement, { ok: false, reason: 'historical-cost-unpriced' });
});

test('an unattributed pre-stream failure releases its reservation without inventing usage', async () => {
  await repo.usageLimits.save({ principalType: 'key', principalId: 'key_a', window: 'hour', maxTokens: 100, maxCostUsd: null });
  const now = new Date();
  assertEquals(await repo.usageLimits.reserve({
    id: 'unattributed', keyId: 'key_a', userId: 1, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), inputTokens: 10,
    outputTokens: 10, maxUnitPriceUsd: null,
  }), { ok: true, limited: true });

  const gatewayCtx = ctx();
  gatewayCtx.usageLimitReservationId = 'unattributed';
  settleUnpricedReservation(gatewayCtx, undefined);
  await Promise.all(background);

  assertEquals(await repo.usage.listAll(), []);
  assertEquals(await repo.usageLimits.reserve({
    id: 'after-unattributed', keyId: 'key_a', userId: 1, now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), inputTokens: 100,
    outputTokens: 0, maxUnitPriceUsd: null,
  }), { ok: true, limited: true });
});

// TPOT reflects the token stream, not the D1 write that follows it.
// `settle` fires the usage record through backgroundScheduler and records
// the perf sample synchronously — so a slow persistence path cannot leak
// its latency into `tpotUs`. Regressing this (turning the usage record
// back into an in-band await, or moving the perf record past the
// scheduler call) would fold persistence latency into every stream's
// per-token interval.
test('settle records the perf sample without waiting on the usage write', async () => {
  const originalRecord = repo.usage.record.bind(repo.usage);
  const persistenceDelayMs = 200;
  repo.usage.record = async row => {
    await new Promise(resolve => setTimeout(resolve, persistenceDelayMs));
    await originalRecord(row);
  };

  const beforeSettle = performance.now();
  const gatewayCtx = ctx({ upstreamCallStartedAt: beforeSettle - 10, firstOutputTokenAt: beforeSettle });

  settle(gatewayCtx, testPerformanceContext, testTelemetryModelIdentity, { input: 5, output: 3 }, false);
  await Promise.all(background);

  const rows = await repo.performance.listAll();
  assertEquals(rows.length, 1);
  // TPOT = (requestFinishedAt - firstOutputTokenAt) * 1000 / (outputTokens - 1).
  // Recorded synchronously at settle entry: tpotUs reflects only the
  // sub-millisecond gap between ctx construction and settle. Fold the
  // 200ms usage write into it (in-band await) and tpotUs would be
  // ~100_000us (200ms / 2). 50_000us fences the regression while
  // tolerating scheduler jitter.
  expect(rows[0].tpotUsSum).toBeLessThan(50_000);
});
