import { expect, test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('migration 0094 gives existing users and API keys an unrestricted model-access default', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0094_upstream_model_access.sql') break;
      db.run(sql);
    }
    db.run(`
      INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
      VALUES (2, 'legacy-user', NULL, 0, NULL, '2026-01-01T00:00:00.000Z', NULL)
    `);
    db.run(`
      INSERT INTO api_keys (id, user_id, name, key, created_at, last_used_at, upstream_ids, deleted_at,
        dump_retention_seconds, server_secret, responses_retention_seconds)
      VALUES ('legacy-key', 2, 'Legacy', 'raw-legacy', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL,
        '${'ab'.repeat(32)}', 0)
    `);

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0094_upstream_model_access.sql');
    expect(migration).toBeDefined();
    db.run(migration![1]);

    const users = db.exec('SELECT upstream_model_access FROM users ORDER BY id');
    const keys = db.exec('SELECT upstream_model_access FROM api_keys WHERE id = \'legacy-key\'');
    expect(users[0]?.values).toEqual([['[]'], ['[]']]);
    expect(keys[0]?.values).toEqual([['[]']]);
  } finally {
    db.close();
  }
});
