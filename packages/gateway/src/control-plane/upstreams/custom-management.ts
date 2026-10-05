import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { customActionExecuteBody, customUsageProbeBody } from '../schemas.ts';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  assertCustomUpstreamRecord,
  executeCustomOperationalAction,
  fetchCustomUsageProbe,
  type CustomUpstreamConfig,
} from '@floway-dev/provider-custom';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const customUsageProbe = async (c: CtxWithJson<typeof customUsageProbeBody>) => {
  const { record: requestRecord } = c.req.valid('json');
  if (requestRecord.kind !== 'custom') return c.json({ error: 'Upstream is not a custom upstream' }, 400);

  let resolved: { config: CustomUpstreamConfig; fetcher: Fetcher } | null = null;
  try {
    let config = requestRecord.config;
    if (requestRecord.id !== '' && isRecord(config)) {
      const saved = await getRepo().upstreams.getById(requestRecord.id);
      if (saved?.kind === 'custom' && isRecord(saved.config) && isRecord(config)) {
        const sameBaseUrl = typeof config.baseUrl === 'string'
          && typeof saved.config.baseUrl === 'string'
          && config.baseUrl.trim() === saved.config.baseUrl;
        const suppliedKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
        if (sameBaseUrl && suppliedKey === '' && typeof saved.config.apiKey === 'string') {
          config = { ...config, apiKey: saved.config.apiKey };
        }
      }
    }
    const validatedConfig = assertCustomUpstreamRecord({ ...requestRecord, config } as UpstreamRecord).config;
    const fetcher = await resolveControlPlaneFetcher({
      override: requestRecord.proxy_fallback_list,
      upstreamId: requestRecord.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
    resolved = { config: validatedConfig, fetcher };
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    if (resolved === null) return c.json({ error: 'Custom usage probe could not be prepared' }, 400);
    const observation = await fetchCustomUsageProbe(resolved.config, resolved.fetcher);
    return c.json({ observation });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 502);
  }
};

export const customActionExecute = async (c: CtxWithJson<typeof customActionExecuteBody>) => {
  const { upstreamId, actionId } = c.req.valid('json');
  const stored = await getRepo().upstreams.getById(upstreamId);
  if (stored === null) return c.json({ error: 'Custom upstream not found' }, 404);
  if (stored.kind !== 'custom') return c.json({ error: 'Upstream is not a custom upstream' }, 400);

  let config: CustomUpstreamConfig;
  let fetcher: Fetcher;
  try {
    config = assertCustomUpstreamRecord(stored).config;
    if (!config.actions?.some(action => action.id === actionId)) {
      return c.json({ error: 'Configured custom action not found' }, 404);
    }
    fetcher = await resolveControlPlaneFetcher({
      override: stored.proxyFallbackList,
      upstreamId: stored.id,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    const result = await executeCustomOperationalAction(config, actionId, fetcher);
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 502);
  }
};
