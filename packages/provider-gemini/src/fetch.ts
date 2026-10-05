// HTTP transport for the Gemini AI Studio upstream. Every inference path is
// the v1beta generateContent family, addressed per-model:
//   POST {base}/v1beta/models/{id}:generateContent          — non-streaming
//   POST {base}/v1beta/models/{id}:streamGenerateContent?alt=sse
//   POST {base}/v1beta/models/{id}:countTokens
// Auth is the `x-goog-api-key` header — the AI Studio surface does not speak
// bearer tokens.
// https://ai.google.dev/api/generate-content

import type { GeminiUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

type GeminiFetchOptions = Pick<UpstreamFetchOptions, 'fetcher' | 'wrapUpstreamCall'>;

export const geminiFetchInternal = async (
  config: GeminiUpstreamConfig,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('x-goog-api-key', config.apiKey);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [k, v] of options.extraHeaders) headers.set(k, v);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

// The model id rides the URL path, not the body — the generateContent payload
// has no model field on this wire.
export const geminiGenerateContentPath = (modelId: string): string => `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
export const geminiStreamGenerateContentPath = (modelId: string): string => `/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
export const geminiCountTokensPath = (modelId: string): string => `/v1beta/models/${encodeURIComponent(modelId)}:countTokens`;
export const geminiListModelsPath = (): string => '/v1beta/models?pageSize=1000';
