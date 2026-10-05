// Gemini AI Studio upstream — a Google AI Studio API key talking directly to
// the generativelanguage.googleapis.com surface. The wire is Google's own
// v1beta generateContent family: `{base}/v1beta/models/{id}:generateContent`
// (and its `:streamGenerateContent?alt=sse` / `:countTokens` variants), authed
// with the `x-goog-api-key` header rather than a bearer token.
//
// The catalog is discovered live from `{base}/v1beta/models`, keeping only
// entries the generateContent family can actually serve — supportedGenerationMethods
// lists the operations each model handles, and tuned models surface alongside
// the first-party ones with their own ids.

import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { modelsField } from '@floway-dev/provider';

export interface GeminiUpstreamConfig {
  baseUrl: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

export type GeminiUpstreamRecord = UpstreamRecord & {
  kind: 'gemini';
  config: GeminiUpstreamConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed gemini upstream config: ${field} must be a non-empty string`);
  return value;
};

const baseUrlField = (value: unknown): string => {
  const baseUrl = nonEmptyStringField(value, 'baseUrl').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('Malformed gemini upstream config: baseUrl must be an http(s) URL');
  }
  return baseUrl;
};

// Parses an upstream's stored/draft config object. Exported because the
// control plane receives a config on its own — from an edit form that has not
// been saved yet — and needs the same validation the record asserter applies.
export const parseGeminiUpstreamConfig = (config: unknown): GeminiUpstreamConfig => {
  if (!isRecord(config)) throw new Error('Malformed gemini upstream config: config must be an object');
  return {
    baseUrl: baseUrlField(config.baseUrl),
    apiKey: nonEmptyStringField(config.apiKey, 'apiKey'),
    models: modelsField(config.models ?? [], 'gemini'),
  };
};

export const assertGeminiUpstreamRecord = (record: UpstreamRecord): GeminiUpstreamRecord => {
  if (record.kind !== 'gemini') throw new Error(`Expected gemini upstream record, got ${record.kind}`);
  return { ...record, kind: 'gemini', config: parseGeminiUpstreamConfig(record.config) };
};
