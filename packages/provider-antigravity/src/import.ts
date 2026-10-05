// Antigravity import: turn an OAuth callback (code + PKCE verifier) into a
// complete config + state pair. Flow mirrors the claude-code import —
// exchange, then derive identity, then build the record — with the Cloud
// Code project step folded in: the project id comes from loadCodeAssist /
// onboardUser and lands directly in the imported config, so the first
// data-plane call does not have to re-derive it.
//
// Wire reference — CLIProxyAPI's sign-in flow:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go

import type { AntigravityUpstreamConfig } from './config.ts';
import {
  ANTIGRAVITY_FALLBACK_CLIENT_VERSION,
  ANTIGRAVITY_USERINFO_URL,
} from './constants.ts';
import { logWarn } from './log.ts';
import { exchangeAntigravityAuthorizationCode } from './oauth.ts';
import { onboardCloudCodeUser, probeCloudCodeProject } from './project.ts';
import type { AntigravityUpstreamState } from './state.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface AntigravityImportResult {
  config: AntigravityUpstreamConfig;
  state: AntigravityUpstreamState;
}

// The scope set includes `userinfo.email`, so the identity call normally
// succeeds; a refusal still imports with a null email rather than failing —
// the email is display metadata, not credential material.
export const fetchAntigravityAccountEmail = async (
  accessToken: string,
  fetcher: Fetcher,
): Promise<string | null> => {
  const response = await fetcher(ANTIGRAVITY_USERINFO_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    logWarn('antigravity_identity_fetch_failed', {
      status: response.status,
      body: bodyText.slice(0, 128),
    });
    return null;
  }
  const parsed = await response.json() as { email?: unknown };
  return typeof parsed.email === 'string' && parsed.email !== '' ? parsed.email : null;
};

// The exchange and every identity / project round-trip run through the
// caller-supplied `fetcher` — the import runs before the upstream record
// exists, so the control-plane route builds the fetcher from the operator's
// in-flight proxy override. Pass `directFetcher` for direct egress.
//
// The project probe runs here rather than lazily on the first data-plane
// call because a brand-new account must go through onboardUser (a polling,
// multi-second step) — doing that inside a chat request would stall it.
// A transient probe failure only degrades the import to a null project;
// the access-token module re-derives lazily in that case.
export const importAntigravityFromCallback = async (opts: {
  code: string;
  pkceVerifier: string;
  state: string;
  fetcher: Fetcher;
}): Promise<AntigravityImportResult> => {
  const tokens = await exchangeAntigravityAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
    fetcher: opts.fetcher,
  });
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token === '') {
    throw new Error('Antigravity OAuth /token response missing refresh_token (request access_type=offline)');
  }

  const accessToken = tokens.access_token;
  const email = await fetchAntigravityAccountEmail(accessToken, opts.fetcher);

  let projectId: string | null = null;
  let tierId: string | null = null;
  try {
    const probed = await probeCloudCodeProject({ accessToken, fetcher: opts.fetcher });
    tierId = probed.tierId;
    if (probed.projectId !== null) {
      projectId = probed.projectId;
    } else {
      projectId = await onboardCloudCodeUser({
        tierId: probed.tierId,
        ideVersion: ANTIGRAVITY_FALLBACK_CLIENT_VERSION,
        accessToken,
        fetcher: opts.fetcher,
      });
    }
  } catch (err) {
    logWarn('antigravity_project_derivation_failed_at_import', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const now = new Date().toISOString();
  return {
    config: {
      accounts: [{ email, projectId, tierId }],
    },
    state: {
      accounts: [{
        email: email ?? '',
        state: 'active',
        stateUpdatedAt: now,
        refreshToken: tokens.refresh_token,
        accessToken: {
          token: accessToken,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          refreshedAt: now,
        },
        projectId,
      }],
    },
  };
};
