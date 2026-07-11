import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { Repo, UserOauthIdentity } from './types.ts';

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

const sample = (over: Partial<UserOauthIdentity> = {}): UserOauthIdentity => ({
  userId: 2,
  providerId: 'corp',
  subject: 'subject-1',
  email: 'alice@example.com',
  linkedAt: '2026-07-12T00:00:00.000Z',
  ...over,
});

describe.each(backends)('UserOauthIdentitiesRepo (%s)', (_label, makeRepo) => {
  test('link then getBySubject returns the row', async () => {
    const repo = await makeRepo();
    await repo.userOauthIdentities.link(sample());
    const found = await repo.userOauthIdentities.getBySubject('corp', 'subject-1');
    expect(found).toEqual(sample());
  });

  test('link twice for the same (providerId, subject) throws with a UNIQUE-shaped message', async () => {
    const repo = await makeRepo();
    await repo.userOauthIdentities.link(sample());
    await expect(repo.userOauthIdentities.link(sample({ userId: 3 }))).rejects.toThrow(/UNIQUE/);
  });

  test('one user can hold multiple distinct identities', async () => {
    const repo = await makeRepo();
    await repo.userOauthIdentities.link(sample({ providerId: 'corp', subject: 'a' }));
    await repo.userOauthIdentities.link(sample({ providerId: 'other', subject: 'b' }));
    const rows = await repo.userOauthIdentities.listByUserId(2);
    expect(rows.map(r => `${r.providerId}:${r.subject}`)).toEqual(['corp:a', 'other:b']);
  });

  test('listByUserId returns [] when the user has no identities', async () => {
    const repo = await makeRepo();
    expect(await repo.userOauthIdentities.listByUserId(42)).toEqual([]);
  });

  test('unlink removes only the targeted row and reports whether it changed anything', async () => {
    const repo = await makeRepo();
    await repo.userOauthIdentities.link(sample({ subject: 'a' }));
    await repo.userOauthIdentities.link(sample({ subject: 'b' }));
    expect(await repo.userOauthIdentities.unlink('corp', 'a')).toBe(true);
    expect(await repo.userOauthIdentities.unlink('corp', 'a')).toBe(false);
    expect((await repo.userOauthIdentities.listByUserId(2)).map(r => r.subject)).toEqual(['b']);
  });

  test('deleteByUserId removes every identity for the target user only', async () => {
    const repo = await makeRepo();
    await repo.userOauthIdentities.link(sample({ userId: 2, subject: 'a' }));
    await repo.userOauthIdentities.link(sample({ userId: 2, subject: 'b' }));
    await repo.userOauthIdentities.link(sample({ userId: 3, subject: 'c' }));
    expect(await repo.userOauthIdentities.deleteByUserId(2)).toBe(2);
    expect(await repo.userOauthIdentities.listByUserId(2)).toEqual([]);
    expect(await repo.userOauthIdentities.listByUserId(3)).toHaveLength(1);
  });

  test('email is nullable', async () => {
    const repo = await makeRepo();
    await repo.userOauthIdentities.link(sample({ email: null }));
    expect((await repo.userOauthIdentities.getBySubject('corp', 'subject-1'))!.email).toBeNull();
  });
});
