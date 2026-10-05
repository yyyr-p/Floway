// HTTP transport for the Antigravity (Cloud Code) upstream. Every data-plane
// path lives on `/v1internal:<operation>` against the configured base (which
// defaults to the daily host):
//   POST {base}/v1internal:generateContent                  — non-streaming
//   POST {base}/v1internal:streamGenerateContent?alt=sse
//   POST {base}/v1internal:countTokens
//   POST {base}/v1internal:fetchAvailableModels             — catalog probe
// Auth is the OAuth bearer; the UA mirrors the Antigravity IDE client.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/executor/antigravity_executor_request.go

import type { AntigravityUpstreamConfig } from './config.ts';
import { ANTIGRAVITY_API_VERSION, ANTIGRAVITY_DAILY_BASE_URL } from './constants.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

export const antigravityFetchInternal = async (
  config: AntigravityUpstreamConfig,
  bearerToken: string,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${bearerToken}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [k, v] of options.extraHeaders) headers.set(k, v);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl ?? ANTIGRAVITY_DAILY_BASE_URL, path), { ...init, headers }));
};

// Operations on the /v1internal resource family. Kept as functions (not
// constants) for symmetry with the gemini provider's path helpers.
export const antigravityGenerateContentPath = (): string => `/${ANTIGRAVITY_API_VERSION}:generateContent`;
export const antigravityStreamGenerateContentPath = (): string => `/${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`;
export const antigravityCountTokensPath = (): string => `/${ANTIGRAVITY_API_VERSION}:countTokens`;
export const antigravityFetchAvailableModelsPath = (): string => `/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
