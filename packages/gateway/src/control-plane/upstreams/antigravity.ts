import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { antigravityOAuthAuthorizeUrlBody, antigravityOAuthExchangeBody, antigravityOAuthRefreshBody } from '../schemas.ts';
import { saveUpstream } from '../shared/save-upstreams.ts';
import { type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import {
  type AntigravityUpstreamConfig,
  type AntigravityUpstreamState,
  AntigravityOAuthSessionTerminatedError,
  buildAntigravityAuthorizeUrl,
  ensureAntigravityAccessToken,
  importAntigravityFromCallback,
  readAntigravityUpstreamState,
} from '@floway-dev/provider-antigravity';

// Antigravity OAuth endpoints under the unified record-body contract, the
// claude-code OAuth pair minus the setup-token alternative: Google grants
// no pastable credentials document for this surface, so the browser
// callback is the only import path. Create and edit share one endpoint
// each — `record.id !== ''` targets a persisted row, `''` merges into the
// front-end's draft.

export const antigravityOAuthAuthorizeUrl = async (c: CtxWithJson<typeof antigravityOAuthAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  const authorize_url = buildAntigravityAuthorizeUrl({ state, codeChallenge: challenge });
  return c.json({ authorize_url });
};

export const antigravityOAuthExchange = async (c: CtxWithJson<typeof antigravityOAuthExchangeBody>) => {
  const { record, callback } = c.req.valid('json');
  if (record.kind !== 'antigravity') return c.json({ error: 'Upstream is not an Antigravity upstream' }, 400);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  let ingestion: { config: AntigravityUpstreamConfig; state: AntigravityUpstreamState };
  try {
    ingestion = await importAntigravityFromCallback({ code: callback.code, pkceVerifier: callback.verifier, state: callback.state, fetcher });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'antigravity') return c.json({ error: 'Upstream is not an Antigravity upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await saveUpstream({ previous: dbRecord, next });
  }

  return c.json({ patch: { config: ingestion.config, state: ingestion.state } });
};

export const antigravityOAuthRefresh = async (c: CtxWithJson<typeof antigravityOAuthRefreshBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'antigravity') return c.json({ error: 'Upstream is not an Antigravity upstream' }, 400);
  // Refresh delegates to the data plane's `ensureAntigravityAccessToken`
  // with `force: true` so operator clicks and data-plane requests share
  // one rotation + race-recovery path. Create-state refresh has no target —
  // the just-completed exchange handed the client a refresh token that has
  // no reason to rotate yet.
  if (record.id === '') return c.json({ error: 'refresh requires a persisted upstream' }, 400);

  const parsedState = readAntigravityUpstreamState(record.state);
  if (parsedState.accounts[0].state !== 'active') {
    return c.json({ error: `Antigravity upstream is ${parsedState.accounts[0].state}; re-run OAuth exchange to recover` }, 400);
  }

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    // `ensureAntigravityAccessToken` handles the whole flow; this handler
    // contributes only the HTTP framing.
    await ensureAntigravityAccessToken({ upstreamId: record.id, repo: getRepo().upstreams, fetcher, force: true });
  } catch (err) {
    if (err instanceof AntigravityOAuthSessionTerminatedError) {
      return c.json({ error: `Antigravity refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
};
