import { getRepo } from "../repo/index.ts";

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

interface GithubCredentials {
  token: string;
  accountType: string;
}

export function listGithubAccounts() {
  return getRepo().github.listAccounts();
}

export async function addGithubAccount(
  token: string,
  user: GitHubUser,
  accountType: string,
): Promise<void> {
  await getRepo().github.saveAccount(user.id, { token, accountType, user });
}

export async function removeGithubAccount(userId: number): Promise<void> {
  await getRepo().github.deleteAccount(userId);
}

export async function setGithubAccountOrder(
  userIds: number[],
): Promise<boolean> {
  const repo = getRepo().github;
  const accounts = await repo.listAccounts();
  const accountIds = new Set(accounts.map((account) => account.user.id));
  const requestedIds = new Set(userIds);
  if (
    userIds.length !== accounts.length ||
    requestedIds.size !== userIds.length ||
    userIds.some((id) => !accountIds.has(id))
  ) {
    return false;
  }

  await repo.setOrder(userIds);
  return true;
}

export async function getGithubCredentials(
  userId?: number,
): Promise<GithubCredentials> {
  const repo = getRepo().github;
  const account = userId === undefined
    ? (await repo.listAccounts())[0] ?? null
    : await repo.getAccount(userId);
  if (!account) {
    throw new Error(userId === undefined
      ? "No GitHub account connected — add one via the dashboard"
      : "GitHub account not found");
  }
  return { token: account.token, accountType: account.accountType };
}
