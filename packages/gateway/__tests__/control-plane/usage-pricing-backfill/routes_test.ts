import { test } from 'vitest';

import { verificationError, type BackfillIntent, type BackfillPlan } from '../../../src/usage-pricing-backfill/index.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { requestApp, setupAppTest, buildCustomUpstreamRecord } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const intent: BackfillIntent = {
  upstream: 'up_prices',
  model: 'public-model',
  modelKey: 'wire-model',
  startHour: '2026-06-01T00',
  endHour: '2026-06-01T01',
  timezone: 'Asia/Singapore',
  metrics: ['input_tokens'],
  mode: 'fill',
};

const authed = (sessionId: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const seedUsage = async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: intent.upstream,
    name: 'Price fixture',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      models: [{
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        upstreamModelId: intent.modelKey,
        pricing: { entries: [{ rates: { input_tokens: '0.03' } }] },
      }],
    },
  }));
  await repo.usage.set({
    keyId: apiKey.id,
    model: intent.model,
    upstream: intent.upstream,
    modelKey: intent.modelKey,
    hour: '2026-06-01T00',
    pricingSelector: {},
    requests: 1,
    metrics: [{ metric: 'input_tokens', quantity: '100', unitPrice: null }],
  });
  return { repo, adminSession, apiKey };
};

const createPlan = async (adminSession: string): Promise<BackfillPlan> => {
  const response = await requestApp('/api/usage-pricing-backfill/plan', authed(adminSession, intent));
  assertEquals(response.status, 200);
  return await response.json() as BackfillPlan;
};

test('usage pricing inspection is admin-only even for direct API callers', async () => {
  const { apiKey } = await seedUsage();
  const response = await requestApp('/api/usage-pricing-backfill/inspect', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
});

test('usage pricing apply requires the exact plan ID and rejects tampered plans', async () => {
  const { repo, adminSession } = await seedUsage();
  const plan = await createPlan(adminSession);

  const mismatch = await requestApp('/api/usage-pricing-backfill/apply', authed(adminSession, {
    plan,
    confirmationPlanId: `${plan.planId}-different`,
  }));
  assertEquals(mismatch.status, 400);

  const tamperedPlan = { ...plan, summary: { ...plan.summary, rowsToUpdate: plan.summary.rowsToUpdate + 1 } };
  const tampered = await requestApp('/api/usage-pricing-backfill/apply', authed(adminSession, {
    plan: tamperedPlan,
    confirmationPlanId: plan.planId,
  }));
  assertEquals(tampered.status, 409);
  assertEquals((await repo.usage.listAll())[0]?.metrics[0]?.unitPrice, null);

  const applied = await requestApp('/api/usage-pricing-backfill/apply', authed(adminSession, {
    plan,
    confirmationPlanId: plan.planId,
  }));
  assertEquals(applied.status, 200);
  assertEquals((await applied.json() as { rowsUpdated: number }).rowsUpdated, 1);
  assertEquals((await repo.usage.listAll())[0]?.metrics[0]?.unitPrice, '0.03');
});

test('usage pricing apply rejects a stale plan and an unidentified runtime target', async () => {
  const { repo, adminSession } = await seedUsage();
  const plan = await createPlan(adminSession);
  const current = (await repo.usage.listAll())[0]!;
  await repo.usage.set({
    ...current,
    metrics: [{ ...current.metrics[0]!, quantity: '101' }],
  });

  const stale = await requestApp('/api/usage-pricing-backfill/apply', authed(adminSession, {
    plan,
    confirmationPlanId: plan.planId,
  }));
  assertEquals(stale.status, 409);
  assertEquals((await repo.usage.listAll())[0]?.metrics[0]?.unitPrice, null);

  Object.defineProperty(repo.usagePricingBackfill, 'databaseIdentity', {
    value: { kind: 'runtime', target: 'cloudflare:DB', stable: false },
  });
  const inspection = await requestApp('/api/usage-pricing-backfill/inspect', authed(adminSession));
  assertEquals(inspection.status, 200);
  assertEquals((await inspection.json() as { database: { stable: boolean } }).database.stable, false);

  const unidentifiedPlan = await requestApp('/api/usage-pricing-backfill/plan', authed(adminSession, intent));
  assertEquals(unidentifiedPlan.status, 409);
  const unidentifiedApply = await requestApp('/api/usage-pricing-backfill/apply', authed(adminSession, {
    plan,
    confirmationPlanId: plan.planId,
  }));
  assertEquals(unidentifiedApply.status, 409);
});

test('internal usage pricing verification errors retain the app stack response', async () => {
  const { repo, adminSession } = await seedUsage();
  const plan = await createPlan(adminSession);
  Object.defineProperty(repo.usagePricingBackfill, 'apply', {
    value: async () => { throw verificationError('verification-fixture', 'verification fixture failure'); },
  });

  const response = await requestApp('/api/usage-pricing-backfill/apply', authed(adminSession, {
    plan,
    confirmationPlanId: plan.planId,
  }));
  assertEquals(response.status, 500);
  const body = await response.json() as { error: { message: string; stack: string } };
  assertEquals(body.error.message, 'verification fixture failure');
  assertEquals(body.error.stack.includes('verification fixture failure'), true);
});
