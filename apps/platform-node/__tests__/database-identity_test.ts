import { test } from 'vitest';

import { databaseIdentityForPath } from '../src/database-identity.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('in-memory Node SQLite uses a per-process runtime identity', () => {
  const first = databaseIdentityForPath(':memory:');
  const second = databaseIdentityForPath(':memory:');
  if (first.kind !== 'runtime' || second.kind !== 'runtime') throw new Error('in-memory database did not receive a runtime identity');
  assertEquals(first.stable, true);
  assertEquals(first.target.startsWith('node:memory:'), true);
  assertEquals(first.target === second.target, false);
});
