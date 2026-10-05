// Cloud Code project resolution: every antigravity data-plane call carries a
// `project` field — the `cloudaicompanionProject` Google binds the account
// to. Resolution is loadCodeAssist (probe) → onboardUser (provision, only
// when the probe shows no project) → persist through a CAS mutator.
//
// Wire reference — CLIProxyAPI's implementation:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
//
// loadCodeAssist goes to the PROD host (`https://cloudcode-pa.googleapis.com`)
// while every other call — onboardUser and the data plane — goes to the
// DAILY host (`https://daily-cloudcode-pa.googleapis.com`). This mirrors the
// real client's wiring.

import {
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_DAILY_BASE_URL,
  ANTIGRAVITY_FALLBACK_CLIENT_VERSION,
  ANTIGRAVITY_IDE_NAME,
  ANTIGRAVITY_IDE_TYPE,
  ANTIGRAVITY_PROD_BASE_URL,
  ANTIGRAVITY_X_GOOG_API_CLIENT,
} from './constants.ts';
import { logInfo, logWarn } from './log.ts';
import { readAntigravityUpstreamState, replaceSoleAccount } from './state.ts';
import { antigravityLongUserAgent, antigravityShortUserAgent } from './version.ts';
import { jsonRequestBody, type Fetcher, type UpstreamsRepoSlim } from '@floway-dev/provider';

const ONBOARD_ATTEMPTS = 5;
const ONBOARD_RETRY_GAP_MS = 2_000;

// The default tier when loadCodeAssist names none — Google's onboarding
// endpoint requires a tier id and every free account lands on the free
// tier.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
const DEFAULT_TIER_ID = 'free-tier';

interface LoadCodeAssistResponse {
  // Accepted spellings across client revisions: the canonical camelCase
  // field, the raw projectId shorthand, and a nested `{id}` object shape.
  cloudaicompanionProject?: unknown;
  projectId?: unknown;
  project?: unknown;
  currentTier?: { id?: unknown };
  allowedTiers?: Array<{ id?: unknown; isDefault?: unknown }>;
}

interface OnboardUserResponse {
  done?: unknown;
  response?: { cloudaicompanionProject?: unknown } | null;
}

const coalesceProject = (raw: unknown): string | null => {
  if (typeof raw === 'string' && raw !== '') return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
};

// Tier resolution order per CLIProxyAPI: the default-flagged entry of
// `allowedTiers`, then `currentTier.id`, then the `free-tier` fallback.
const tierFromLoadCodeAssist = (parsed: LoadCodeAssistResponse): string => {
  if (Array.isArray(parsed.allowedTiers)) {
    const defaulted = parsed.allowedTiers.find(tier => tier.isDefault === true);
    if (typeof defaulted?.id === 'string' && defaulted.id !== '') return defaulted.id;
  }
  if (typeof parsed.currentTier?.id === 'string' && parsed.currentTier.id !== '') return parsed.currentTier.id;
  return DEFAULT_TIER_ID;
};

const cloudCodePost = async (
  opts: { accessToken: string; fetcher: Fetcher; signal?: AbortSignal },
  call: { baseUrl: string; operation: string; body: Record<string, unknown>; userAgent: string },
): Promise<Response> => {
  const path = `/${ANTIGRAVITY_API_VERSION}:${call.operation}`;
  return await opts.fetcher(`${call.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.accessToken}`,
      'user-agent': call.userAgent,
      'x-goog-api-client': ANTIGRAVITY_X_GOOG_API_CLIENT,
    },
    body: jsonRequestBody(call.body),
    signal: opts.signal,
  });
};

export interface LoadCodeAssistOutcome {
  projectId: string | null;
  tierId: string;
}

// Probe prod for an existing Cloud Code project for this account. Returns
// the project when the account already has one; `null` means onboarding is
// required. Network/HTTP failures propagate — a lazy re-derive failure must
// fail the request so retry semantics stay with the caller.
export const probeCloudCodeProject = async (opts: {
  accessToken: string;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<LoadCodeAssistOutcome> => {
  const response = await cloudCodePost(opts, {
    baseUrl: ANTIGRAVITY_PROD_BASE_URL,
    operation: 'loadCodeAssist',
    body: { metadata: { ideType: ANTIGRAVITY_IDE_TYPE } },
    userAgent: antigravityShortUserAgent(),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`loadCodeAssist returned ${response.status}: ${bodyText.slice(0, 256)}`);
  }
  const parsed = await response.json() as LoadCodeAssistResponse;
  const projectId = coalesceProject(parsed.cloudaicompanionProject)
    ?? coalesceProject(parsed.projectId)
    ?? coalesceProject(parsed.project);
  return { projectId, tierId: tierFromLoadCodeAssist(parsed) };
};

// Provision a project for accounts that have none. Polls up to
// ONBOARD_ATTEMPTS times while `done` stays falsy — Google provisions
// asynchronously. The long UA + gl-node companion header are requirements
// of this call specifically (the google-api-nodejs transport stamps them).
// https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
export const onboardCloudCodeUser = async (opts: {
  tierId: string;
  ideVersion: string;
  accessToken: string;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<string> => {
  for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt++) {
    const response = await cloudCodePost(opts, {
      baseUrl: ANTIGRAVITY_DAILY_BASE_URL,
      operation: 'onboardUser',
      body: {
        tier_id: opts.tierId,
        metadata: {
          ide_type: ANTIGRAVITY_IDE_TYPE,
          ide_version: opts.ideVersion,
          ide_name: ANTIGRAVITY_IDE_NAME,
        },
      },
      userAgent: antigravityLongUserAgent(opts.ideVersion),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`onboardUser returned ${response.status}: ${bodyText.slice(0, 256)}`);
    }
    const parsed = await response.json() as OnboardUserResponse;
    const projectId = coalesceProject(parsed.response?.cloudaicompanionProject);
    if (projectId !== null) return projectId;
    if (parsed.done === true) {
      // done=true with no project id: the upstream considers onboarding
      // complete but did not hand one back — surface loudly rather than
      // loop pointlessly.
      throw new Error('onboardUser reported done without a cloudaicompanionProject');
    }
    if (attempt < ONBOARD_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, ONBOARD_RETRY_GAP_MS));
    }
  }
  throw new Error(`onboardUser did not produce a project after ${ONBOARD_ATTEMPTS} attempts`);
};

export interface EnsureAntigravityProjectIdArgs {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
  fetcher: Fetcher;
  accessToken: string;
  signal?: AbortSignal;
}

// Resolve and persist the project id for a state whose `projectId` is null.
// The write goes through the CAS mutator so a concurrent rotation or import
// wins nothing from us — the persisted value is only claimed when the row
// still shows a null project (a re-import landing one in between keeps
// theirs).
export const ensureAntigravityProjectId = async (args: EnsureAntigravityProjectIdArgs): Promise<string> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Antigravity upstream ${args.upstreamId} not found`);
  const state = readAntigravityUpstreamState(fresh.state);
  const stored = state.accounts[0].projectId;
  if (stored !== null) return stored;

  logInfo('antigravity_project_onboarding_started', { upstream_id: args.upstreamId });
  const probed = await probeCloudCodeProject({
    accessToken: args.accessToken,
    fetcher: args.fetcher,
    signal: args.signal,
  });

  let projectId: string;
  if (probed.projectId !== null) {
    projectId = probed.projectId;
  } else {
    logWarn('antigravity_project_onboarding_required', { upstream_id: args.upstreamId, tier_id: probed.tierId });
    projectId = await onboardCloudCodeUser({
      tierId: probed.tierId,
      ideVersion: ANTIGRAVITY_FALLBACK_CLIENT_VERSION,
      accessToken: args.accessToken,
      fetcher: args.fetcher,
      signal: args.signal,
    });
  }

  await args.repo.saveState(args.upstreamId, current =>
    replaceSoleAccount(readAntigravityUpstreamState(current), account => (
      account.projectId === null ? { ...account, projectId } : account
    )));
  logInfo('antigravity_project_persisted', { upstream_id: args.upstreamId });
  return projectId;
};
