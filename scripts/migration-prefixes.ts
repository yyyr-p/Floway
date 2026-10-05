// Migration filenames must start with a unique NNNN_ prefix so lexical order
// agrees with `wrangler d1 migrations apply`. Two consumers share this guard —
// the runtime check script and the vitest suite — so the allowlist of
// historical collisions lives here once rather than drifting apart.
//
// These collisions predate the guard and are already applied in production, so
// renaming them would create new migration identities rather than repairing the
// old ones. Anything not on this list is a real collision and must be fixed.
export const KNOWN_DUPLICATE_MIGRATION_PREFIXES: ReadonlySet<string> = new Set(['0011', '0025']);

// The four-digit prefix alone — used as the uniqueness key.
const MIGRATION_PREFIX_CAPTURE = /^(\d{4})_/;

export interface MigrationPrefixReport {
  badNames: string[];
  collisions: string[][];
}

// Pure so the CLI script and the vitest suite can both call it without touching
// the filesystem differently.
export const reportMigrationPrefixes = (filenames: readonly string[]): MigrationPrefixReport => {
  const byPrefix = new Map<string, string[]>();
  const badNames: string[] = [];
  for (const filename of filenames) {
    const match = MIGRATION_PREFIX_CAPTURE.exec(filename);
    if (match === null) {
      badNames.push(filename);
      continue;
    }
    const prefix = match[1];
    const bucket = byPrefix.get(prefix) ?? [];
    bucket.push(filename);
    byPrefix.set(prefix, bucket);
  }
  const collisions = [...byPrefix.entries()]
    .filter(([prefix, bucket]) => bucket.length > 1 && !KNOWN_DUPLICATE_MIGRATION_PREFIXES.has(prefix))
    .map(([, bucket]) => bucket);
  return { badNames, collisions };
};
