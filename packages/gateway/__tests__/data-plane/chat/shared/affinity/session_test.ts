import { expect, test } from 'vitest';

import { AffinityRequestContext, defineAffinityRequest } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { SqlRepo } from '../../../../../src/repo/sql.ts';
import { createSqliteTestDb } from '../../../../repo/test-sqlite.ts';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const candidate = (upstreamId: string, group = 0) => {
  const base = stubModelCandidate();
  return {
    ...stubModelCandidate({ provider: { ...base.provider, upstreamId }, model: { id: 'model' } }),
    rules: {}, aliasRouting: { id: 'alias-stable', group, preserveOpaque: false },
  };
};
const a = candidate('up-a');
const b = candidate('up-b', 1);
const analysis = defineAffinityRequest([], () => ({ kind: 'accepted', degrades: false, materialize: () => undefined }));
const context = (key = 'key-a', id = 'session') => new AffinityRequestContext('22'.repeat(32), { apiKeyId: key, id });

const install = async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  for (const id of ['key-a', 'key-b']) await repo.apiKeys.save({
    id, userId: 1, name: id, key: `raw-${id}`, serverSecret: (id === 'key-a' ? '22' : '33').repeat(32),
    createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null,
    dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 86400,
  });
  initRepo(repo);
  return { db, repo };
};

const order = async (ctx: AffinityRequestContext, model = 'alias', values: readonly ModelCandidate[] = [a, b], snapshot?: { upstreamId: string; modelId: string }) => {
  const selected = await ctx.candidates(model, values, analysis, snapshot);
  if ('kind' in selected) throw new Error(selected.message);
  return selected.candidates;
};

test('SQL session binding follows each success and survives quota reset and new repository instances', async () => {
  const { db } = await install();
  const first = context();
  expect(await order(first)).toEqual([a, b]);
  first.select(a);
  await first.commitSuccess();
  const failover = context();
  expect(await order(failover)).toEqual([a, b]);
  // A quota failure itself writes nothing; B is the next successful route.
  failover.select(b);
  await failover.commitSuccess();
  initRepo(new SqlRepo(db));
  const recovered = context();
  expect(await order(recovered)).toEqual([b, a]);
  expect(await order(context(), 'renamed-alias')).toEqual([b, a]);
  expect(await order(context('key-b'))).toEqual([a, b]);
  expect(await order(context('key-a', 'another-session'))).toEqual([a, b]);
  const direct = [a, b].map(({ aliasRouting: _alias, ...value }) => value);
  expect(await order(context(), 'model', direct)).toEqual(direct);
});

test('explicit branch snapshot precedes session binding and concurrent successes use commit order', async () => {
  const { repo } = await install();
  const earlier = context();
  const later = context();
  await order(earlier);
  await order(later);
  earlier.select(a);
  later.select(b);
  await later.commitSuccess();
  await earlier.commitSuccess();
  expect(await order(context())).toEqual([a, b]);
  expect(await order(context(), 'alias', [a, b], { upstreamId: 'up-b', modelId: 'model' })).toEqual([b, a]);
  expect(await repo.conversationRoutes.lookup('key-a', 'session', 'alias:alias-stable')).toEqual({ upstreamId: 'up-a', modelId: 'model', rules: {} });
});
