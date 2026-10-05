// Gemini AI Studio provider. Talks the v1beta generateContent family
// directly — generate, streamGenerateContent (SSE), and countTokens — with
// `x-goog-api-key` auth. The catalog comes from `{base}/v1beta/models`,
// filtered to entries the generateContent family can serve (fetch-models.ts).
// Only the `geminiGenerateContent` endpoint is advertised: reaching the other
// three chat protocols on this wire is the translate package's job, not this
// provider's.
//
// The model id rides the URL path, never the body — the generateContent
// payload has no model field on this wire, and the gateway threads the raw
// catalog id through `ProviderModel.providerData`.

import { assertGeminiUpstreamRecord, type GeminiUpstreamConfig } from './config.ts';
import { GEMINI_DEFAULT_FLAGS } from './defaults.ts';
import { fetchGeminiCatalog, type GeminiRawModel } from './fetch-models.ts';
import { geminiCountTokensPath, geminiStreamGenerateContentPath, geminiFetchInternal } from './fetch.ts';
import { pricingForGeminiModelKey } from './pricing.ts';
import { type ModelEndpoints } from '@floway-dev/protocols/common';
import { parseGeminiGenerateContentStream } from '@floway-dev/protocols/gemini-generate-content';
import { jsonRequestBody, publicModelId, resolveEffectiveFlags, streamingProviderCall, type Fetcher, type FlagId, type HttpHeaderLines, type Provider, type ProviderInstance, type ProviderModel, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

const GEMINI_ENDPOINTS: ModelEndpoints = { geminiGenerateContent: {} };

const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

const finalizeGeminiModels = (
  catalog: readonly GeminiRawModel[],
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => catalog.map(raw => {
  const pricing = pricingForGeminiModelKey(raw.id);
  return {
    id: raw.id,
    upstreamModelId: raw.id,
    owned_by: 'google',
    limits: { ...(raw.contextLength !== undefined ? { max_context_window_tokens: raw.contextLength } : {}) },
    kind: 'chat' as const,
    endpoints: GEMINI_ENDPOINTS,
    providerData: raw.id,
    enabledFlags,
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    ...(raw.displayName !== undefined ? { display_name: raw.displayName } : {}),
    ...(pricing ? { pricing } : {}),
  } satisfies ProviderModel;
});

const geminiCall = (
  config: GeminiUpstreamConfig,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  headers: HttpHeaderLines,
  opts: UpstreamCallOptions,
): Promise<Response> =>
  geminiFetchInternal(config, path, { method: 'POST', body: jsonRequestBody(body), signal }, { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });

export const createGeminiProvider = (record: UpstreamRecord): Provider => {
  const config = assertGeminiUpstreamRecord(record).config;
  const upstreamFlags = resolveEffectiveFlags([GEMINI_DEFAULT_FLAGS, record.flagOverrides]);

  const overriddenIds = new Set(config.models.map(entry => entry.upstreamModelId));

  const instance: ProviderInstance = {
    callAlphaSearch: () => Promise.reject(new Error('Gemini provider does not support callAlphaSearch')),
    getProvidedModels: async (fetcher: Fetcher) => {
      const catalog = await fetchGeminiCatalog(config, fetcher);
      const auto = finalizeGeminiModels(catalog.filter(raw => !overriddenIds.has(raw.id)), upstreamFlags);
      // Manual entries are projected straight through their config row: the
      // operator picked the endpoints, so the catalog listing cannot override
      // them.
      const manual = config.models.map(entry => {
        const pricing = entry.pricing ?? pricingForGeminiModelKey(entry.upstreamModelId);
        return {
          id: publicModelId(entry),
          upstreamModelId: entry.upstreamModelId,
          owned_by: 'google',
          limits: { ...(entry.limits ?? {}) },
          kind: entry.kind,
          endpoints: entry.endpoints,
          providerData: entry.upstreamModelId,
          enabledFlags: upstreamFlags,
          opaqueBlobCompatibilityScope: entry.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
          ...(entry.display_name !== undefined ? { display_name: entry.display_name } : {}),
          ...(pricing ? { pricing } : {}),
        } satisfies ProviderModel;
      });
      return [...manual, ...auto] as ProviderModel[];
    },
    callOpenAICompletions: () => Promise.reject(new Error('Gemini provider does not support callOpenAICompletions')),
    callOpenAIChatCompletions: () => Promise.reject(new Error('Gemini provider does not support callOpenAIChatCompletions')),
    callOpenAIResponses: () => Promise.reject(new Error('Gemini provider does not support callOpenAIResponses')),
    callAnthropicMessages: () => Promise.reject(new Error('Gemini provider does not support callAnthropicMessages')),
    callAnthropicMessagesCountTokens: () => Promise.reject(new Error('Gemini provider does not support callAnthropicMessagesCountTokens')),
    callGeminiGenerateContent: (model, body, signal, opts) => {
      const rawModelId = rawModelIdOf(model);
      return streamingProviderCall(
        geminiCall(config, geminiStreamGenerateContentPath(rawModelId), body, signal, [...opts.headers], opts),
        parseGeminiGenerateContentStream,
        rawModelId,
        signal,
      );
    },
    callGeminiGenerateContentCountTokens: async (model, body, signal, opts) => {
      const rawModelId = rawModelIdOf(model);
      const response = await geminiCall(config, geminiCountTokensPath(rawModelId), body, signal, [...opts.headers], opts);
      return { response, modelKey: rawModelId };
    },
    callOpenAIEmbeddings: () => Promise.reject(new Error('Gemini provider does not support callOpenAIEmbeddings')),
    callOpenAIImagesGenerations: () => Promise.reject(new Error('Gemini provider does not support callOpenAIImagesGenerations')),
    callOpenAIImagesEdits: () => Promise.reject(new Error('Gemini provider does not support callOpenAIImagesEdits')),
    callOpenAIAudioTranscriptions: () => Promise.reject(new Error('Gemini provider does not support callOpenAIAudioTranscriptions')),
    callRerank: () => Promise.reject(new Error('Gemini provider does not support callRerank')),
  };

  return {
    upstreamId: record.id,
    kind: 'gemini',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
