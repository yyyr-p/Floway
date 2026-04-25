import type { SearchConfig } from "../../data-plane/tools/web-search/types.ts";
import type {
  ApiKey,
  GitHubAccount,
  SearchUsageRecord,
  UsageRecord,
} from "../../repo/types.ts";

export interface ExportPayload {
  version: 1;
  exportedAt: string;
  data: {
    apiKeys: ApiKey[];
    githubAccounts: GitHubAccount[];
    activeGithubAccountId: number | null;
    usage: UsageRecord[];
    searchUsage: SearchUsageRecord[];
    searchConfig: SearchConfig;
  };
}
