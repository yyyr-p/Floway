import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

const LOGO_MIGRATION_SUFFIX = '_upstream_logo_url.sql';

test('upstream logo migration adds a nullable HTTPS-only URL column', () => {
  const db = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename.endsWith(LOGO_MIGRATION_SUFFIX)) {
      db.prepare("INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue) VALUES ('legacy', 'custom', 'Legacy', '', '', '{}', 210)").run();
    }
    db.exec(sql);
  }

  const legacy = db.prepare("SELECT logo_url FROM upstreams WHERE id = 'legacy'").get() as { logo_url: string | null };
  assertEquals(legacy.logo_url, null);
  db.prepare("INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue, logo_url) VALUES ('branded', 'custom', 'Branded', '', '', '{}', 210, 'https://example.com/logo.png')").run();
  let rejectedScheme = false;
  try {
    db.prepare("INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, hue, logo_url) VALUES ('unsafe', 'custom', 'Unsafe', '', '', '{}', 210, 'data:image/png;base64,AA==')").run();
  } catch {
    rejectedScheme = true;
  }
  assertEquals(rejectedScheme, true);
  db.close();
});
