// Antigravity provider — Google's Cloud Code subscription surface (the
// Antigravity IDE's backing API). OAuth bearer auth, envelope-wrapped Gemini
// generateContent requests, and a `fetchAvailableModels` catalog probed live
// and intersected with a static table.
//
// Only the `geminiGenerateContent` endpoint is advertised: the wire speaks
// Gemini generateContent under the envelope, and reaching the other three
// chat protocols on this upstream is the translate package's job.
//
// Model id flow matches the gemini provider: the catalog id rides
// `ProviderModel.providerData` and is threaded to the URL/envelope on every
// call.

import { ensureAntigravityAccessToken, invalidateAntigravityAccessToken } from './access-token.ts';
import { assertAntigravityUpstreamRecord } from './config.ts';
import { ANTIGRAVITY_DEFAULT_FLAGS } from './defaults.ts';
import { buildAntigravityEnvelope } from './envelope.ts';
import { ANTIGRAVITY_STATIC_GEMINI_MODELS, fetchAntigravityCatalog, mergeAntigravityModels, type AntigravityRawModel } from './fetch-available-models.ts';
import { antigravityCountTokensPath, antigravityStreamGenerateContentPath, antigravityFetchInternal } from './fetch.ts';
import { logWarn } from './log.ts';
import { pricingForAntigravityModelId } from './pricing.ts';
import { parseAntigravityStream } from './stream.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { getProviderRepo, jsonRequestBody, resolveEffectiveFlags, streamingProviderCall, type FlagId, type Provider, type ProviderCallResult, type ProviderInstance, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

const ANTIGRAVITY_ENDPOINTS = { geminiGenerateContent: {} } as const;

const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

const finalizeAntigravityModels = (
  catalog: readonly AntigravityRawModel[],
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => catalog.map(raw => {
  const pricing = pricingForAntigravityModelId(raw.id) ?? undefined;
  return {
    id: raw.id,
    upstreamModelId: raw.id,
    owned_by: 'google',
    limits: {},
    kind: 'chat' as const,
    endpoints: ANTIGRAVITY_ENDPOINTS,
    providerData: raw.id,
    enabledFlags,
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    ...(raw.displayName !== undefined ? { display_name: raw.displayName } : {}),
    ...(pricing ? { pricing } : {}),
  } satisfies ProviderModel;
});

export const createAntigravityProvider = (record: UpstreamRecord): Provider => {
  assertAntigravityUpstreamRecord(record);
  const config = record.config;
  const enabledFlags = resolveEffectiveFlags([ANTIGRAVITY_DEFAULT_FLAGS, record.flagOverrides]);
  const upstreamId = record.id;
  const repo = () => getProviderRepo().upstreams;

  const instance: ProviderInstance = {
    callAlphaSearch: () => Promise.reject(new Error('Antigravity provider does not support callAlphaSearch')),
    getProvidedModels: async fetcher => {
      // Catalog refresh mints an access token (and lazily completes project
      // onboarding when the import stopped short) before probing
      // fetchAvailableModels. A terminated credential throws — the catalog
      // cache records the failure and surfaces it on the dashboard.
      const access = await ensureAntigravityAccessToken({
        upstreamId,
        repo: repo(),
        fetcher,
      });
      const live = await fetchAntigravityCatalog({
        config, bearerToken: access.entry.token, fetcher,
      }).catch(error => {
        logWarn('antigravity_catalog_probe_failed', { upstream_id: upstreamId, error: String(error) });
        return [] as AntigravityRawModel[];
      });
      // The static table is the floor (the ids are pinned to the wire
      // contract); live ids the table predates surface alongside it.
      const merged = mergeAntigravityModels(ANTIGRAVITY_STATIC_GEMINI_MODELS, live);
      return finalizeAntigravityModels(merged, enabledFlags);
    },
    callGeminiGenerateContent: async (model, payload, signal, opts) => {
      const rawModelId = rawModelIdOf(model);
      const access = await ensureAntigravityAccessToken({
        upstreamId,
        repo: repo(),
        fetcher: opts.fetcher,
      });
      const envelope = await buildAntigravityEnvelope({ projectId: access.projectId, model: rawModelId, payload });
      const result = await streamingProviderCall(
        antigravityFetchInternal(
          config,
          access.entry.token,
          antigravityStreamGenerateContentPath(),
          { method: 'POST', body: jsonRequestBody(envelope), signal },
          { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        ),
        (body, parserOptions) => parseAntigravityStream(body, { ...parserOptions, model: rawModelId }),
        rawModelId,
        signal,
      );
      if (!result.ok && result.response.status === 401) {
        // Cached token rejected — invalidate so the next call mints fresh.
        // One retry with a guaranteed-fresh mint; a second 401 surfaces
        // verbatim.
        await invalidateAntigravityAccessToken({ upstreamId, repo: repo() });
        const fresh = await ensureAntigravityAccessToken({
          upstreamId, repo: repo(), fetcher: opts.fetcher, force: true,
        });
        const retryEnvelope = await buildAntigravityEnvelope({ projectId: fresh.projectId, model: rawModelId, payload });
        return await streamingProviderCall(
          antigravityFetchInternal(
            config,
            fresh.entry.token,
            antigravityStreamGenerateContentPath(),
            { method: 'POST', body: jsonRequestBody(retryEnvelope), signal },
            { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
          ),
          (body, parserOptions) => parseAntigravityStream(body, { ...parserOptions, model: rawModelId }),
          rawModelId,
          signal,
        );
      }
      return result;
    },
    callGeminiGenerateContentCountTokens: async (model, payload, signal, opts): Promise<ProviderCallResult> => {
      const rawModelId = rawModelIdOf(model);
      // countTokens does not wrap in the antigravity envelope and skips the
      // project/model fields — a flat Gemini generateContent shape on the
      // same /v1internal resource.
      // https://github.com/router-for-me/CLIProxyAPI/blob/main/executor/antigravity_executor_request.go
      const cleaned: GeminiGenerateContentPayload = structuredClone(payload);
      delete (cleaned as Record<string, unknown>).safetySettings;
      const access = await ensureAntigravityAccessToken({
        upstreamId,
        repo: repo(),
        fetcher: opts.fetcher,
      });
      const response = await antigravityFetchInternal(
        config,
        access.entry.token,
        antigravityCountTokensPath(),
        { method: 'POST', body: jsonRequestBody(cleaned), signal },
        { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      );
      return { response, modelKey: rawModelId };
    },
    callAnthropicMessages: () => Promise.reject(new Error('Antigravity provider does not support callAnthropicMessages')),
    callAnthropicMessagesCountTokens: () => Promise.reject(new Error('Antigravity provider does not support callAnthropicMessagesCountTokens')),
    callOpenAICompletions: () => Promise.reject(new Error('Antigravity provider does not support callOpenAICompletions')),
    callOpenAIChatCompletions: () => Promise.reject(new Error('Antigravity provider does not support callOpenAIChatCompletions')),
    callOpenAIResponses: () => Promise.reject(new Error('Antigravity provider does not support callOpenAIResponses')),
    callOpenAIEmbeddings: () => Promise.reject(new Error('Antigravity provider does not support callOpenAIEmbeddings')),
    callOpenAIImagesGenerations: () => Promise.reject(new Error('Antigravity provider does not support callOpenAIImagesGenerations')),
    callOpenAIImagesEdits: () => Promise.reject(new Error('Antigravity provider does not support callOpenAIImagesEdits')),
    callOpenAIAudioTranscriptions: () => Promise.reject(new Error('Antigravity provider does not support callOpenAIAudioTranscriptions')),
    callRerank: () => Promise.reject(new Error('Antigravity provider does not support callRerank')),
  };

  return {
    upstreamId,
    kind: 'antigravity',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
