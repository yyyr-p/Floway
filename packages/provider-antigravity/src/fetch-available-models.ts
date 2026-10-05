// Antigravity model catalog. Two sources merge:
//
// 1. A static table of the Gemini-family model ids Cloud Code serves —
//    pinned at implementation time so the catalog renders even when the
//    fetchAvailableModels probe is unavailable. Tier-suffix ids
//    (`-low` / `-high`) are the ids the wire exposes (CLIProxyAPI issue
//    #3643/#3699 documented the suffixes as tier aliases upstream serves
//    verbatim).
// 2. The live `POST {base}/v1internal:fetchAvailableModels` probe
//    (`{"project": "<id>"}` body), intersected with the static table so an
//    upstream-side retirement drops out instead of serving 404s.
//
// Claude / GPT-OSS ids the upstream also lists are deliberately excluded:
// they ride a separate request translator (executeClaudeNonStream in
// CLIProxyAPI) Floway has not implemented — a v1 gap tracked for follow-up.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/executor/antigravity_executor.go

import type { AntigravityUpstreamConfig } from './config.ts';
import { antigravityFetchAvailableModelsPath, antigravityFetchInternal } from './fetch.ts';
import { fetchUpstreamModels, identityWrapUpstreamCall, type Fetcher } from '@floway-dev/provider';

export interface AntigravityRawModel {
  id: string;
  displayName?: string;
}

// Static Gemini-family ids (tier aliases included). Display names render on
// the dashboard; context windows are not probed in v1 (limits stay empty).
export const ANTIGRAVITY_STATIC_GEMINI_MODELS: readonly AntigravityRawModel[] = [
  { id: 'gemini-3-flash' },
  { id: 'gemini-3.1-pro-low' },
  { id: 'gemini-3.1-flash-lite' },
  { id: 'gemini-3.5-flash-lite' },
  { id: 'gemini-3.6-flash-high' },
  { id: 'gemini-3.7-flash-high' },
  { id: 'gemini-3.8-flash-high' },
  { id: 'gemini-pro-agent' },
];

export const fetchAntigravityCatalog = async (opts: {
  config: AntigravityUpstreamConfig;
  bearerToken: string;
  fetcher: Fetcher;
}): Promise<AntigravityRawModel[]> =>
  await fetchUpstreamModels(
    () => antigravityFetchInternal(
      opts.config,
      opts.bearerToken,
      antigravityFetchAvailableModelsPath(),
      { method: 'POST', body: JSON.stringify({ project: opts.config.accounts[0].projectId }) },
      { fetcher: opts.fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
    ),
    parseAntigravityModelsResponse,
  );

// `{"webSearchModelIds":[...], "models":{<id>: {...}}}`. The per-model
// values vary across revisions; only presence in the `models` map matters
// for the intersection — capability details ride probing Floway has not
// implemented.
const parseAntigravityModelsResponse = (value: unknown): AntigravityRawModel[] | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const models = (value as { models?: unknown }).models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return null;
  return Object.keys(models)
    .filter(id => isGeminiFamilyId(id))
    .map(id => ({ id }));
};

export const isGeminiFamilyId = (id: string): boolean => id.startsWith('gemini');

// Intersect the static table with the live listing. When the live probe is
// empty (endpoint unavailable, project not yet onboarded) the static table
// stands alone — the ids are pinned to the wire contract, so serving them
// is better than an empty catalog.
export const mergeAntigravityModels = (staticModels: readonly AntigravityRawModel[], live: readonly AntigravityRawModel[]): AntigravityRawModel[] => {
  if (live.length === 0) return [...staticModels];
  const liveIds = new Set(live.map(model => model.id));
  const merged = staticModels.filter(model => liveIds.has(model.id));
  // The live listing may carry ids the static table predates — surface them
  // so a newly released tier model is usable without a Floway release.
  for (const model of live) {
    if (!merged.some(known => known.id === model.id)) merged.push(model);
  }
  return merged;
};
