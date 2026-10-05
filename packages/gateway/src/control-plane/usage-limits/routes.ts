import type { Context } from 'hono';

import { summarizeUsageLimit } from './aggregate.ts';
import { type CtxWithJson, type CtxWithParam } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageLimit } from '../../repo/types.ts';
import { usageLimitWindowBounds } from '../../repo/usage-limit-windows.ts';
import type { usageLimitBody, usageLimitDeleteParams } from '../schemas.ts';

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
    limits: limits.map(limit => summarizeUsageLimit(limit, records, userByKey, now)),
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
