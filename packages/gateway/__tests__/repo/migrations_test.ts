import { test } from 'vitest';

import { migrationSqlByFilename } from './test-sqlite.ts';
import { reportMigrationPrefixes } from '../../../../scripts/migration-prefixes.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('every migration file has a unique numeric prefix', () => {
  const { badNames, collisions } = reportMigrationPrefixes(migrationSqlByFilename.map(([filename]) => filename));
  assertEquals(badNames, [], `migration filename must start with NNNN_: ${JSON.stringify(badNames)}`);
  assertEquals(collisions, [], `duplicate migration numbers: ${JSON.stringify(collisions)}`);
});
