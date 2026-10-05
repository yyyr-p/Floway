import { expect, test } from 'vitest';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from '../src/bootstrap.ts';

const env = (targetId?: string): CloudflareEnv => ({
  DB: {},
  FILES: {},
  IMAGES: {},
  KV: {},
  EXECUTION_DO: {},
  ...(targetId === undefined ? {} : { FLOWAY_DATABASE_TARGET_ID: targetId }),
}) as unknown as CloudflareEnv;

test('Cloudflare usage pricing identity is stable only with an explicit target ID', () => {
  expect(bootstrapCloudflarePlatform(env()).databaseIdentity).toEqual({
    kind: 'runtime',
    target: 'cloudflare:DB',
    stable: false,
  });
  expect(bootstrapCloudflarePlatform(env(' d1-database-id ')).databaseIdentity).toEqual({
    kind: 'runtime',
    target: 'd1-database-id',
    stable: true,
  });
});
