import type { Context } from 'hono';

import { defaultCyberInterceptPrompts, loadCyberInterceptSettings, saveCyberInterceptSettings } from '../../data-plane/chat/shared/cyber-intercept/settings.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { cyberInterceptSettingsSchema } from '../schemas.ts';

// Read the effective settings: the stored document, with the built-in
// defaults surfaced for any field the operator has not customized — the
// dashboard edits what it sees, and a GET that returned nothing would erase
// the prompts on the next save.
export const getCyberInterceptSettingsRoute = async (c: Context) => c.json(await loadCyberInterceptSettings());

// The built-in default prompts, for the dashboard's "reset to defaults"
// affordance. Read-only; never stored.
export const getCyberInterceptDefaultsRoute = async (c: Context) => c.json(defaultCyberInterceptPrompts());

export const putCyberInterceptSettingsRoute = async (c: CtxWithJson<typeof cyberInterceptSettingsSchema>) =>
  c.json(await saveCyberInterceptSettings(c.req.valid('json')));

// Audit log read + purge. Entries are written by the data plane's
// cyber-intercept gate only; there is no create/update route.
export const listCyberInterceptAuditLogRoute = async (c: Context) => {
  const limitParam = c.req.query('limit');
  const offsetParam = c.req.query('offset');
  const limit = Math.min(200, Math.max(1, Number.parseInt(limitParam ?? '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(offsetParam ?? '0', 10) || 0);
  const records = await getRepo().cyberInterceptAuditLog.list({ limit, offset });
  return c.json(records);
};

export const deleteCyberInterceptAuditLogRoute = async (c: Context) => {
  await getRepo().cyberInterceptAuditLog.deleteAll();
  return c.json({ ok: true });
};
