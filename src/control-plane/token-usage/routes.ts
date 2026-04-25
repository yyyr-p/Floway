// GET /api/token-usage — query per-key token usage records
//
// IMPORTANT DESIGN DECISION: Usage data is intentionally readable by ALL authenticated
// users (both admin and API key users), without scoping. Any authenticated user can view
// usage records for all keys. API keys themselves are only readable by their owner.

import type { Context } from "hono";
import { queryUsage } from "../../lib/usage-tracker.ts";
import { listApiKeys } from "../../lib/api-keys.ts";

const USAGE_KEY_COLOR_ORDER = [
  "46360b74-2457-4a38-a116-7afdb2894632",
  "4969165b-3412-436c-87d9-3fd4770164b5",
  "541128df-ee71-4fc1-9cc7-6855ca1e7fcc",
  "e694733c-370e-4b9a-9331-57eefd12a8cc",
  "5a4481c9-0230-481c-bd17-49fc2bda6f02",
  "future-1",
  "3f2fe5b9-2991-4bb8-bc04-2852f58150ca",
  "future-3",
  "future-2",
  "future-4",
];

export const tokenUsage = async (c: Context) => {
  const keyId = c.req.query("key_id") || undefined;
  const start = c.req.query("start") ?? "";
  const end = c.req.query("end") ?? "";
  const includeKeyMetadata = c.req.query("include_key_metadata") === "1";

  if (!start || !end) {
    return c.json({
      error: "start and end query parameters are required (e.g. 2026-03-09T00)",
    }, 400);
  }

  const [records, keys] = await Promise.all([
    queryUsage({ keyId, start, end }),
    listApiKeys(),
  ]);

  const keyMap = new Map(keys.map((k) => [k.id, k]));
  const recordsWithKeyMetadata = records.map((r) => ({
    ...r,
    keyName: keyMap.get(r.keyId)?.name ?? r.keyId.slice(0, 8),
    keyCreatedAt: keyMap.get(r.keyId)?.createdAt ?? null,
  }));

  if (!includeKeyMetadata) return c.json(recordsWithKeyMetadata);

  const keyMetadata = keys
    .map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
  });
};
