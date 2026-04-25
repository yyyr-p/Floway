// Data transfer routes — export/import all database data as JSON

import type { Context } from "hono";
import { normalizeSearchConfig } from "../../data-plane/tools/web-search/search-config.ts";
import { isWebSearchProviderName } from "../../lib/web-search-types.ts";
import { getRepo } from "../../repo/index.ts";
import type {
  ApiKey,
  GitHubAccount,
  SearchUsageRecord,
  UsageRecord,
} from "../../repo/types.ts";
import type { ExportPayload } from "./types.ts";

const SEARCH_USAGE_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

const parseSearchUsageRecords = (
  value: unknown,
):
  | { type: "ok"; records: SearchUsageRecord[] }
  | { type: "invalid"; index: number } => {
  if (!Array.isArray(value)) return { type: "ok", records: [] };

  const records: SearchUsageRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== "object") {
      return { type: "invalid", index: i };
    }

    const item = record as Record<string, unknown>;
    const provider = item.provider;
    const keyId = item.keyId;
    const hour = item.hour;
    const requests = item.requests;
    if (
      !isWebSearchProviderName(provider) ||
      typeof keyId !== "string" ||
      keyId.length === 0 ||
      typeof hour !== "string" ||
      !SEARCH_USAGE_HOUR_PATTERN.test(hour) ||
      typeof requests !== "number" ||
      !Number.isSafeInteger(requests) ||
      requests < 0
    ) {
      return { type: "invalid", index: i };
    }

    records.push({
      provider,
      keyId,
      hour,
      requests,
    });
  }

  return { type: "ok", records };
};

/** GET /api/export — dump all data as JSON */
export const exportData = async (c: Context) => {
  const repo = getRepo();

  const [
    apiKeys,
    githubAccounts,
    activeGithubAccountId,
    usage,
    searchUsage,
    rawSearchConfig,
  ] = await Promise.all([
    repo.apiKeys.list(),
    repo.github.listAccounts(),
    repo.github.getActiveId(),
    repo.usage.listAll(),
    repo.searchUsage.listAll(),
    repo.searchConfig.get(),
  ]);

  const payload: ExportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      apiKeys,
      githubAccounts,
      activeGithubAccountId,
      usage,
      searchUsage,
      searchConfig: normalizeSearchConfig(rawSearchConfig),
    },
  };

  return c.json(payload);
};

/** POST /api/import — import data with merge or replace mode */
export const importData = async (c: Context) => {
  // deno-lint-ignore no-explicit-any
  const body = await c.req.json<{ mode: string; data: any }>();
  const { mode, data } = body;

  if (mode !== "merge" && mode !== "replace") {
    return c.json({ error: "mode must be 'merge' or 'replace'" }, 400);
  }
  if (!data || typeof data !== "object") {
    return c.json({ error: "data is required" }, 400);
  }

  const repo = getRepo();
  const apiKeys: ApiKey[] = Array.isArray(data.apiKeys) ? data.apiKeys : [];
  const githubAccounts: GitHubAccount[] = Array.isArray(data.githubAccounts)
    ? data.githubAccounts
    : [];
  const usage: UsageRecord[] = Array.isArray(data.usage) ? data.usage : [];
  const searchUsageResult = parseSearchUsageRecords(data.searchUsage);
  if (searchUsageResult.type === "invalid") {
    return c.json({
      error: `invalid searchUsage record at index ${searchUsageResult.index}`,
    }, 400);
  }
  const searchUsage = searchUsageResult.records;
  const activeId: number | null = typeof data.activeGithubAccountId === "number"
    ? data.activeGithubAccountId
    : null;

  if (mode === "replace") {
    await Promise.all([
      repo.apiKeys.deleteAll(),
      repo.github.deleteAllAccounts(),
      repo.usage.deleteAll(),
      repo.searchUsage.deleteAll(),
    ]);
    await repo.searchConfig.save(normalizeSearchConfig(data.searchConfig));
  }

  // Import API keys
  for (const key of apiKeys) {
    await repo.apiKeys.save(key);
  }

  // Import GitHub accounts
  for (const account of githubAccounts) {
    await repo.github.saveAccount(account.user.id, account);
  }

  // Import usage records
  for (const record of usage) {
    await repo.usage.set(record);
  }

  // Import search usage records
  for (const record of searchUsage) {
    await repo.searchUsage.set(record);
  }

  // Set active GitHub account
  if (activeId != null) {
    if (mode === "replace") {
      await repo.github.setActiveId(activeId);
    } else {
      // Merge: only set if currently unset
      const current = await repo.github.getActiveId();
      if (current == null) {
        await repo.github.setActiveId(activeId);
      }
    }
  }

  if (
    mode !== "replace" &&
    typeof data.searchConfig === "object" &&
    data.searchConfig !== null
  ) {
    await repo.searchConfig.save(normalizeSearchConfig(data.searchConfig));
  }

  return c.json({
    ok: true,
    imported: {
      apiKeys: apiKeys.length,
      githubAccounts: githubAccounts.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
    },
  });
};
