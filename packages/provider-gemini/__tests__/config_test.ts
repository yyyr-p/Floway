import { describe, expect, test, vi } from 'vitest';

import { assertGeminiUpstreamRecord, parseGeminiUpstreamConfig } from '../src/config.ts';
import { fetchGeminiCatalog } from '../src/fetch-models.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const base = {
  id: 'up_1', name: 'n', enabled: true, sort_order: 0, created_at: '', updated_at: '',
  flag_overrides: {}, flag_defaults: {}, disabled_public_model_ids: [],
  proxy_fallback_list: [], model_prefix: null, hue: 0,
} as unknown as UpstreamRecord;

const record = (config: unknown): UpstreamRecord =>
  ({ ...base, kind: 'gemini', config }) as UpstreamRecord;

describe('parseGeminiUpstreamConfig', () => {
  test('parses baseUrl, apiKey and models', () => {
    const parsed = parseGeminiUpstreamConfig({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'key', models: [] });
    expect(parsed).toEqual({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'key', models: [] });
  });

  test('rejects an ftp baseUrl and a non-http URL', () => {
    expect(() => parseGeminiUpstreamConfig({ baseUrl: 'ftp://example.com', apiKey: 'k' })).toThrow(/http\(s\) URL/);
    expect(() => parseGeminiUpstreamConfig({ baseUrl: 'generativelanguage.googleapis.com', apiKey: 'k' })).toThrow(/http\(s\) URL/);
  });

  test('accepts an http baseUrl for local proxies', () => {
    expect(parseGeminiUpstreamConfig({ baseUrl: 'http://127.0.0.1:8080', apiKey: 'k' }).baseUrl).toBe('http://127.0.0.1:8080');
  });

  test('rejects a blank apiKey and a blank baseUrl', () => {
    expect(() => parseGeminiUpstreamConfig({ baseUrl: 'https://x.example.com', apiKey: '  ' })).toThrow(/apiKey/);
    expect(() => parseGeminiUpstreamConfig({ baseUrl: ' ', apiKey: 'k' })).toThrow(/baseUrl/);
  });

  test('rejects a non-object config', () => {
    expect(() => parseGeminiUpstreamConfig('nope')).toThrow(/must be an object/);
  });
});

describe('assertGeminiUpstreamRecord', () => {
  test('passes a kind-matching record through with a parsed config', () => {
    const parsed = assertGeminiUpstreamRecord(record({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'key', models: [] }));
    expect(parsed.kind).toBe('gemini');
    expect(parsed.config.apiKey).toBe('key');
  });

  test('rejects another provider kind', () => {
    expect(() => assertGeminiUpstreamRecord({ ...base, kind: 'custom', config: {} } as UpstreamRecord)).toThrow(/gemini/);
  });
});

describe('fetchGeminiCatalog', () => {
  test('keeps only models serving the generateContent family and strips the models/ prefix', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1048576 },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/tuned-abc', supportedGenerationMethods: ['streamGenerateContent'] },
        { name: 'models/snake-legacy', supportedGenerationMethods: ['generateContent'], input_token_limit: 32000 },
        { name: '', supportedGenerationMethods: ['generateContent'] },
        { supportedGenerationMethods: ['generateContent'] },
      ],
    }), { status: 200 }));
    const catalog = await fetchGeminiCatalog(
      { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'key', models: [] },
      fetchSpy as unknown as Parameters<typeof fetchGeminiCatalog>[1],
    );
    expect(catalog.map(model => model.id)).toEqual(['gemini-3-pro', 'tuned-abc', 'snake-legacy']);
    expect(catalog[0]).toEqual({ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', contextLength: 1048576 });
    expect(catalog[2].contextLength).toBe(32000);
    // The listing rides the x-goog-api-key header on {base}/v1beta/models.
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('x-goog-api-key')).toBe('key');
  });

  test('surfaces the catalog scaffolding error envelope for a failed listing', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ error: { code: 401, message: 'API key not valid' } }), { status: 401 }));
    await expect(fetchGeminiCatalog(
      { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'bad', models: [] },
      fetchSpy as unknown as Parameters<typeof fetchGeminiCatalog>[1],
    )).rejects.toThrow(/Provider model listing failed/);
  });
});
