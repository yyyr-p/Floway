import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';

import type { DatabaseIdentityNode, DatabaseIdentityRuntime } from '@floway-dev/gateway/usage-pricing-backfill';

export const databaseIdentityForPath = (dbPath: string): DatabaseIdentityNode | DatabaseIdentityRuntime => {
  if (dbPath === ':memory:') return { kind: 'runtime', target: `node:memory:${randomUUID()}`, stable: true };
  const path = realpathSync(dbPath);
  const databaseStat = statSync(path);
  return { kind: 'node', device: Number(databaseStat.dev), inode: Number(databaseStat.ino), path };
};
