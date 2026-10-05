import type { Context } from 'hono';

import { type CtxWithJson, type CtxWithParam } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageLimit, UsageRecord } from '../../repo/types.ts';
import { usageLimitWindowBounds } from '../../repo/usage-limit-windows.ts';
import { usageUnmeteredRequests } from '../../repo/usage-metrics.ts';
import type { usageLimitBody, usageLimitDeleteParams } from '../schemas.ts';
import { addDecimalStrings, multiplyDecimalStrings } from '@floway-dev/protocols/common';

const TOKEN_METRICS = new Set([
  'input_tokens',
  'input_cache_read_tokens',
  'input_cache_write_tokens',
  'input_cache_write_1h_tokens',
  'input_image_tokens',
  'input_audio_tokens',
  'output_tokens',
  'output_image_tokens',
]);

const summarize = (
  limit: UsageLimit,
  records: readonly UsageRecord[],
  userByKey: ReadonlyMap<string, number>,
  now: Date,
) => {
  const { start, end } = usageLimitWindowBounds(now)[limit.window];
  const scoped = records.filter(record => record.hour >= start && record.hour < end && (
    limit.principalType === 'key'
      ? record.keyId === limit.principalId
      : userByKey.get(record.keyId) === limit.principalId
  ));
  let usedTokens = 0;
  let usedCostUsd = '0';
  let costIsPriced = true;
  for (const record of scoped) {
    if (record.requests > 0 && usageUnmeteredRequests(record) !== 0) costIsPriced = false;
    for (const metric of record.metrics) {
      if (TOKEN_METRICS.has(metric.metric)) usedTokens += Number(metric.quantity);
      if (metric.unitPrice === null) {
        if (Number(metric.quantity) > 0) costIsPriced = false;
        continue;
      }
      usedCostUsd = addDecimalStrings(usedCostUsd, multiplyDecimalStrings(metric.quantity, metric.unitPrice));
    }
  }
  return {
    ...limit,
    windowStart: start,
    windowEnd: end,
    usedTokens,
    usedCostUsd: costIsPriced ? usedCostUsd : null,
  };
};

export const getUsageLimits = async (c: Context) => {
  const repo = getRepo();
  const [limits, keys, users] = await Promise.all([
    repo.usageLimits.list(),
    repo.apiKeys.listIncludingDeleted(),
    repo.users.listIncludingDeleted(),
  ]);
  const now = new Date();
  const month = usageLimitWindowBounds(now).month;
  const records = await repo.usage.query({ start: month.start, end: month.end });
  const userByKey = new Map(keys.map(key => [key.id, key.userId]));
  return c.json({
    limits: limits.map(limit => summarize(limit, records, userByKey, now)),
    users: users.filter(user => user.deletedAt === null).map(({ id, username }) => ({ id, username })),
    keys: keys.filter(key => key.deletedAt === null).map(({ id, name, userId }) => ({ id, name, userId })),
  });
};

export const saveUsageLimit = async (c: CtxWithJson<typeof usageLimitBody>) => {
  const value = c.req.valid('json');
  const repo = getRepo();
  if (value.principalType === 'user') {
    const user = await repo.users.getById(Number(value.principalId));
    if (!user) return c.json({ error: 'Unknown user principalId' }, 404);
  } else {
    const key = await repo.apiKeys.getById(String(value.principalId));
    if (!key) return c.json({ error: 'Unknown API key principalId' }, 404);
  }
  const limit: UsageLimit = {
    principalType: value.principalType,
    principalId: value.principalId,
    window: value.window,
    maxTokens: value.maxTokens,
    maxCostUsd: value.maxCostUsd,
  };
  await repo.usageLimits.save(limit);
  return c.json({ ok: true, limit });
};

export const deleteUsageLimit = async (c: CtxWithParam<typeof usageLimitDeleteParams, '/usage-limits/:principalType/:principalId/:window'>) => {
  const value = c.req.valid('param');
  if (value.principalType === 'user') {
    const principalId = Number(value.principalId);
    if (!Number.isSafeInteger(principalId) || principalId <= 0) {
      return c.json({ error: 'user principalId must be a positive integer' }, 400);
    }
    const removed = await getRepo().usageLimits.delete('user', principalId, value.window);
    return c.json({ ok: true, removed });
  }
  const removed = await getRepo().usageLimits.delete('key', value.principalId, value.window);
  return c.json({ ok: true, removed });
};
