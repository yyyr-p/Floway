import { test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { BackfillIntent, DatabaseIdentityRuntime } from '../../src/usage-pricing-backfill/index.ts';
import { buildCustomUpstreamRecord } from '../test-utils/app.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const intent: BackfillIntent = {
  upstream: 'up_sql_prices',
  model: 'public-model',
  modelKey: 'wire-model',
  startHour: '2026-06-01T00',
  endHour: '2026-06-01T01',
  timezone: 'Asia/Singapore',
  metrics: ['input_tokens'],
  mode: 'fill',
};

const seedSqlUsage = async (repo: SqlRepo) => {
  const base = buildCustomUpstreamRecord();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: intent.upstream,
    name: 'SQL price fixture',
    config: {
      ...(base.config as Record<string, unknown>),
      models: [{
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        upstreamModelId: intent.modelKey,
        pricing: { entries: [{ rates: { input_tokens: '0.03' } }] },
      }],
    },
  }));
  await repo.usage.set({
    keyId: 'key_sql_prices',
    model: intent.model,
    upstream: intent.upstream,
    modelKey: intent.modelKey,
    hour: '2026-06-01T00',
    pricingSelector: {},
    requests: 1,
    metrics: [{ metric: 'input_tokens', quantity: '100', unitPrice: null }],
  });
};

test('SQL usage pricing repo plans, applies, and reads back verified prices', async () => {
  const db = await createSqliteTestDb();
  const identity: DatabaseIdentityRuntime = { kind: 'runtime', target: 'sql-backfill-test', stable: true };
  const repo = new SqlRepo(db, identity);
  await seedSqlUsage(repo);

  const inspection = await repo.usagePricingBackfill.inspect();
  assertEquals(inspection.nullPriceSlices.length, 1);
  assertEquals(inspection.nullPriceSlices[0]?.rows, 1);

  const plan = await repo.usagePricingBackfill.plan(intent);
  assertEquals(plan.operations[0]?.proposedUnitPrice, '0.03');
  assertEquals(plan.summary.rowsToUpdate, 1);
  const result = await repo.usagePricingBackfill.apply(plan);
  assertEquals(result.rowsUpdated, 1);
  assertEquals(result.summary.remainingNullRows, 0);
  assertEquals((await repo.usage.listAll())[0]?.metrics[0]?.unitPrice, '0.03');
});

test('SQL usage pricing repo rejects an unidentified or different runtime database', async () => {
  const db = await createSqliteTestDb();
  const identified: DatabaseIdentityRuntime = { kind: 'runtime', target: 'd1-instance-a', stable: true };
  const repoA = new SqlRepo(db, identified);
  await seedSqlUsage(repoA);
  const plan = await repoA.usagePricingBackfill.plan(intent);

  const unidentified = new SqlRepo(db, { kind: 'runtime', target: 'cloudflare:DB', stable: false });
  const inspection = await unidentified.usagePricingBackfill.inspect();
  if (inspection.database.kind !== 'runtime') throw new Error('expected runtime database identity');
  assertEquals(inspection.database.stable, false);
  await assertRejects(() => unidentified.usagePricingBackfill.plan(intent), Error, 'unique runtime database target');
  await assertRejects(() => unidentified.usagePricingBackfill.apply(plan), Error, 'unique runtime database target');

  const instanceB = new SqlRepo(db, { kind: 'runtime', target: 'd1-instance-b', stable: true });
  await assertRejects(() => instanceB.usagePricingBackfill.apply(plan), Error, 'database does not match the plan target');
  assertEquals((await repoA.usage.listAll())[0]?.metrics[0]?.unitPrice, null);
});

test('SQL usage pricing repo refuses to overwrite NULL values added after planning', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db, { kind: 'runtime', target: 'sql-backfill-stale-test', stable: true });
  await seedSqlUsage(repo);
  const plan = await repo.usagePricingBackfill.plan(intent);
  await repo.usage.set({
    ...(await repo.usage.listAll())[0]!,
    metrics: [{ metric: 'input_tokens', quantity: '101', unitPrice: null }],
  });

  await assertRejects(() => repo.usagePricingBackfill.apply(plan), Error, 'changed after the plan was created');
  assertEquals((await repo.usage.listAll())[0]?.metrics[0]?.unitPrice, null);
});
