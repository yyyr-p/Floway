import { type AuthedContext, userFromContext } from '../../../middleware/auth.ts';
import type { CtxWithJson } from '../../../middleware/zod-validator.ts';
import { getRepo } from '../../../repo/index.ts';
import type { oauthAdminLinkBody } from '../../schemas.ts';

const parseUserId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const identityToWire = (row: { userId: number; providerId: string; subject: string; email: string | null; linkedAt: string }) => ({
  userId: row.userId,
  providerId: row.providerId,
  subject: row.subject,
  email: row.email,
  linkedAt: row.linkedAt,
});

// A user must always retain at least one login credential. This guard
// applies to identity removal (self-unlink or admin unlink of a non-self
// target). User id 1 is exempt because ADMIN_KEY always resolves to it.
const wouldLockOut = async (userId: number, providerId: string, subject: string): Promise<boolean> => {
  if (userId === 1) return false;
  const repo = getRepo();
  const user = await repo.users.getById(userId);
  if (!user) return false;
  if (user.passwordHash !== null) return false;
  const identities = await repo.userOauthIdentities.listByUserId(userId);
  const remaining = identities.filter(i => !(i.providerId === providerId && i.subject === subject));
  return remaining.length === 0;
};

export const listOwnIdentities = async (c: AuthedContext) => {
  const user = userFromContext(c);
  const rows = await getRepo().userOauthIdentities.listByUserId(user.id);
  return c.json({ identities: rows.map(identityToWire) });
};

export const unlinkOwnIdentity = async (c: AuthedContext) => {
  const user = userFromContext(c);
  const providerId = c.req.param('providerId')!;
  const subject = c.req.param('subject')!;
  const repo = getRepo();
  const existing = await repo.userOauthIdentities.getBySubject(providerId, subject);
  if (!existing || existing.userId !== user.id) {
    return c.json({ error: 'Identity not found' }, 404);
  }
  if (await wouldLockOut(user.id, providerId, subject)) {
    return c.json({ error: 'Cannot remove the last credential from an account without a password' }, 400);
  }
  await repo.userOauthIdentities.unlink(providerId, subject);
  return c.json({ ok: true });
};

export const listUserIdentitiesAdmin = async (c: AuthedContext) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const repo = getRepo();
  if (!(await repo.users.getById(id))) return c.json({ error: 'user not found' }, 404);
  const rows = await repo.userOauthIdentities.listByUserId(id);
  return c.json({ identities: rows.map(identityToWire) });
};

export const linkUserIdentityAdmin = async (c: CtxWithJson<typeof oauthAdminLinkBody>) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const body = c.req.valid('json');
  const repo = getRepo();
  if (!(await repo.users.getById(id))) return c.json({ error: 'user not found' }, 404);
  const existing = await repo.userOauthIdentities.getBySubject(body.providerId, body.subject);
  if (existing) {
    if (existing.userId === id) return c.json({ identity: identityToWire(existing) });
    return c.json({ error: 'This identity is already linked to another user' }, 409);
  }
  const row = {
    userId: id,
    providerId: body.providerId,
    subject: body.subject,
    email: body.email ?? null,
    linkedAt: new Date().toISOString(),
  };
  await repo.userOauthIdentities.link(row);
  return c.json({ identity: identityToWire(row) }, 201);
};

export const unlinkUserIdentityAdmin = async (c: AuthedContext) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const providerId = c.req.param('providerId')!;
  const subject = c.req.param('subject')!;
  const repo = getRepo();
  const existing = await repo.userOauthIdentities.getBySubject(providerId, subject);
  if (existing?.userId !== id) {
    return c.json({ error: 'Identity not found for that user' }, 404);
  }
  // Admin unlink is exempt from the lockout guard: an admin who intentionally
  // strips a user's only credential can also reset their password.
  await repo.userOauthIdentities.unlink(providerId, subject);
  return c.json({ ok: true });
};
