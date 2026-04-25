// Auth routes — ADMIN_KEY validation + GitHub Device Flow OAuth (multi-account)
// Supports login with ADMIN_KEY (full dashboard access) or API key (restricted)
// No sessions, no cookies. All auth via key in every request.

import type { Context } from "hono";
import {
  addGithubAccount,
  getActiveGithubAccount,
  type GitHubUser,
  listGithubAccounts,
  removeGithubAccount,
  setActiveGithubAccount,
} from "../../lib/github.ts";
import { clearCopilotTokenCache } from "../../lib/copilot.ts";
import { getEnv } from "../../lib/env.ts";
import { validateApiKey } from "../../lib/api-keys.ts";
import { clearModelsCache } from "../../lib/models-cache.ts";
import {
  detectAccountType,
  fetchGitHubUser,
  pollGitHubDeviceFlow,
  startGitHubDeviceFlow,
} from "./github-device-flow.ts";

/** POST /auth/login — validate ADMIN_KEY or API key */
export const authLogin = async (c: Context) => {
  try {
    const body = await c.req.json<{ key: string }>();
    const adminKey = getEnv("ADMIN_KEY");

    // ADMIN_KEY login
    if (adminKey && body.key === adminKey) {
      return c.json({ ok: true, isAdmin: true });
    }

    // API key login
    const result = await validateApiKey(body.key);
    if (result) {
      return c.json({
        ok: true,
        isAdmin: false,
        keyId: result.id,
        keyName: result.name,
        keyHint: body.key.slice(-4),
      });
    }

    return c.json({ error: "Invalid key" }, 401);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
};

/** POST /auth/logout — no-op (client clears localStorage) */
export const authLogout = (_c: Context) => {
  // Nothing to clean up server-side; client clears its own localStorage
  return _c.json({ ok: true });
};

/** GET /auth/github — start GitHub Device Flow */
export const authGithub = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** POST /auth/github/poll — poll for device flow completion */
export const authGithubPoll = async (c: Context) => {
  try {
    const body = await c.req.json<{ device_code: string }>();

    const data = await pollGitHubDeviceFlow(body.device_code);

    if (data.error === "authorization_pending") {
      return c.json({ status: "pending" });
    }

    if (data.error === "slow_down") {
      return c.json({ status: "slow_down", interval: data.interval });
    }

    if (data.error) {
      return c.json(
        { status: "error", error: data.error_description ?? data.error },
        400,
      );
    }

    if (data.access_token) {
      const user = await fetchGitHubUser(data.access_token);

      // Store account and set as active
      const accountType = await detectAccountType(data.access_token);
      await addGithubAccount(data.access_token, user, accountType);
      await clearCopilotTokenCache();
      clearModelsCache();
      return c.json({ status: "complete", user });
    }

    return c.json({ status: "error", error: "Unknown response" }, 500);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** GET /auth/me — get all GitHub accounts + active account info */
export const authMe = async (c: Context) => {
  const accounts = await listGithubAccounts();
  const active = await getActiveGithubAccount();

  // If we have an active account but no user info cached, try to fetch it
  if (active && !active.user.login) {
    try {
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${active.token}`,
          accept: "application/json",
          "user-agent": "copilot-deno",
        },
      });
      if (userResp.ok) {
        active.user = (await userResp.json()) as GitHubUser;
        await addGithubAccount(active.token, active.user, active.accountType);
      }
    } catch {
      // Ignore — user just stays as-is
    }
  }

  return c.json({
    authenticated: true,
    github_connected: accounts.length > 0,
    accounts: accounts.map((a) => ({
      id: a.user.id,
      login: a.user.login,
      name: a.user.name,
      avatar_url: a.user.avatar_url,
      account_type: a.accountType,
      active: active?.user.id === a.user.id,
    })),
  });
};

/** DELETE /auth/github/:id — disconnect a specific GitHub account */
export const authGithubDisconnect = async (c: Context) => {
  const userId = Number(c.req.param("id"));
  if (!userId || isNaN(userId)) {
    return c.json({ error: "Invalid user ID" }, 400);
  }
  await removeGithubAccount(userId);
  await clearCopilotTokenCache();
  clearModelsCache();
  return c.json({ ok: true });
};

/** POST /auth/github/switch — switch active GitHub account */
export const authGithubSwitch = async (c: Context) => {
  const body = await c.req.json<{ user_id: number }>();
  if (!body.user_id) {
    return c.json({ error: "user_id is required" }, 400);
  }
  const ok = await setActiveGithubAccount(body.user_id);
  if (!ok) {
    return c.json({ error: "Account not found" }, 404);
  }
  await clearCopilotTokenCache();
  clearModelsCache();
  return c.json({ ok: true });
};
