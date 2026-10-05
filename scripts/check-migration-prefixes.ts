// Runtime guard for migration filename numbering. Fork and upstream both append
// NNNN_*.sql files to packages/gateway/migrations, and a collision only shows up
// in `wrangler d1 migrations apply` after deploy. This check surfaces a collision
// the moment a merge resolves, instead of waiting for a full test run.

import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reportMigrationPrefixes } from './migration-prefixes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = resolve(ROOT, 'packages/gateway/migrations');

const entries = await readdir(MIGRATIONS_DIR);
const sqlFiles = entries.filter(name => name.endsWith('.sql')).toSorted();

const { badNames, collisions } = reportMigrationPrefixes(sqlFiles);

if (badNames.length > 0) {
  console.error(`migration filenames must start with NNNN_: ${badNames.join(', ')}`);
}
if (collisions.length > 0) {
  console.error(`duplicate migration numbers: ${collisions.map(bucket => bucket.join(' + ')).join('; ')}`);
}
if (badNames.length > 0 || collisions.length > 0) {
  console.error('Renumber the newer migration past the existing fork-maintained range (0092+) or add its prefix to KNOWN_DUPLICATE_MIGRATION_PREFIXES in scripts/migration-prefixes.ts if it is an intentional historical collision.');
  process.exit(1);
}
console.log(`migration prefixes OK (${sqlFiles.length} files)`);
