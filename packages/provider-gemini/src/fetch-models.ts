// Gemini AI Studio catalog discovery from `GET {base}/v1beta/models`. The
// response is a flat `{ models: [...] }` list where each entry carries
// `name` (`models/<id>`), a `supportedGenerationMethods` array of method
// names, and display/context metadata. Only entries that list a
// generateContent-family method can serve the chat routes — embedding and
// a9t models carry different method sets and drop out here.
// https://ai.google.dev/api/models#method-models-list

import type { GeminiUpstreamConfig } from './config.ts';
import { geminiFetchInternal, geminiListModelsPath } from './fetch.ts';
import { fetchUpstreamModels, type Fetcher, identityWrapUpstreamCall } from '@floway-dev/provider';

export interface GeminiRawModel {
  // The id minus the `models/` prefix — the value the gateway puts in the
  // generateContent URL path on every inference call.
  id: string;
  displayName?: string;
  description?: string;
  contextLength?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Any one of the three method names means the model speaks the family; the
// listing is not required to name all of them.
const GEMINI_GENERATE_CONTENT_SERVING_METHODS = new Set(['generateContent', 'streamGenerateContent', 'countTokens']);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);

const optionalStringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const parseModelsResponse = (value: unknown): GeminiRawModel[] | null => {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const models: GeminiRawModel[] = [];
  for (const item of value.models) {
    if (!isRecord(item)) continue;
    const name = optionalStringField(item.name);
    if (!name) continue;
    // `name` is the resource path `models/<id>`; everything after the prefix
    // is the id inference and listing both address.
    const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
    if (id === '') continue;
    const methods = item.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.some(method => GEMINI_GENERATE_CONTENT_SERVING_METHODS.has(method))) continue;
    const raw: GeminiRawModel = { id };
    const displayName = optionalStringField(item.displayName);
    if (displayName !== undefined) raw.displayName = displayName;
    const description = optionalStringField(item.description);
    if (description !== undefined) raw.description = description;
    // The camelCase spelling is the current wire shape; the snake_case one
    // predates it and is accepted for older proxies.
    const contextLength = optionalNumberField(item.inputTokenLimit) ?? optionalNumberField(item.input_token_limit);
    if (contextLength !== undefined) raw.contextLength = contextLength;
    models.push(raw);
  }
  return models;
};

export const fetchGeminiCatalog = async (config: GeminiUpstreamConfig, fetcher: Fetcher): Promise<GeminiRawModel[]> =>
  await fetchUpstreamModels(
    () => geminiFetchInternal(config, geminiListModelsPath(), { method: 'GET' }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
    parseModelsResponse,
  );
