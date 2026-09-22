import { expect, test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('global usage migration defaults existing and future users to no grant and rejects non-boolean values', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0089_global_usage_permission.sql') {
      db.run("INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at) VALUES (2, 'existing', NULL, 0, NULL, '', NULL)");
    }
    db.run(sql);
  }
  db.run("INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at) VALUES (3, 'new', NULL, 0, NULL, '', NULL)");
  expect(db.exec('SELECT can_view_global_usage FROM users ORDER BY id')[0].values).toEqual([[0], [0], [0]]);
  expect(() => db.run('UPDATE users SET can_view_global_usage = 2 WHERE id = 2')).toThrow();
  db.close();
});
