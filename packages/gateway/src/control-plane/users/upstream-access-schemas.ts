// Bulk per-user upstream access body, separated from ../schemas.ts so fork's
// users-domain additions never share a file with upstream's schema churn.

import { z } from 'zod';

export const updateUsersUpstreamAccessBody = z.object({
  userIds: z.array(z.number().int().positive()).min(1)
    .refine(ids => new Set(ids).size === ids.length, 'userIds contains duplicates'),
  changes: z.array(z.object({
    upstreamId: z.string().min(1),
    allowed: z.boolean(),
  }).strict()).min(1)
    .refine(changes => new Set(changes.map(change => change.upstreamId)).size === changes.length, 'changes contains duplicate upstreamId'),
}).strict();
