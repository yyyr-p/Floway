// GET /api/token-usage — query per-key token usage records
//
// IMPORTANT DESIGN DECISION: Usage data is intentionally readable by ALL authenticated
// users (both admin and API key users), without scoping. Any authenticated user can view
// usage records for all keys. API keys themselves are only readable by their owner.

import type { Context } from "hono";
import { queryUsage } from "../../lib/usage-tracker.ts";
import { listApiKeys } from "../../lib/api-keys.ts";

export const tokenUsage = async (c: Context) => {
  const keyId = c.req.query("key_id") || undefined;
  const start = c.req.query("start") ?? "";
  const end = c.req.query("end") ?? "";

  if (!start || !end) {
    return c.json({
      error: "start and end query parameters are required (e.g. 2026-03-09T00)",
    }, 400);
  }

  const [records, keys] = await Promise.all([
    queryUsage({ keyId, start, end }),
    listApiKeys(),
  ]);

  const nameMap = new Map(keys.map((k) => [k.id, k.name]));
  return c.json(records.map((r) => ({
    ...r,
    keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
  })));
};
