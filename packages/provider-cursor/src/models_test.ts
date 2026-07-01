import { describe, expect, test } from 'vitest';

import { cursorRawToUpstreamModel, fetchCursorCatalog, parseContextWindow } from './models.ts';
import { type Fetcher } from '@floway-dev/provider';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// A fetcher that branches on the RPC path, so one call to fetchCursorCatalog
// exercises both GetUsableModels and AvailableModels.
const routingFetcher = (routes: {
  usable: () => Response | Promise<Response>;
  available: () => Response | Promise<Response>;
}): Fetcher =>
  (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('GetUsableModels')) return await routes.usable();
    if (url.includes('AvailableModels')) return await routes.available();
    throw new Error(`unexpected url ${url}`);
  }) as unknown as Fetcher;

const usableModels = (ids: string[]): Response =>
  jsonResponse({ models: ids.map(id => ({ modelId: id, displayName: id })) });

describe('parseContextWindow', () => {
  test('parses k and M suffixes', () => {
    expect(parseContextWindow('**X**<br />200k context window')).toBe(200_000);
    expect(parseContextWindow('300k context window')).toBe(300_000);
    expect(parseContextWindow('272k context window')).toBe(272_000);
    expect(parseContextWindow('262k context window')).toBe(262_000);
    expect(parseContextWindow('1M context window')).toBe(1_000_000);
    expect(parseContextWindow('1.5M context window')).toBe(1_500_000);
  });

  test('returns null when no context phrase is present', () => {
    expect(parseContextWindow('**Auto**<br />Balanced default.')).toBeNull();
    expect(parseContextWindow('')).toBeNull();
  });
});

describe('cursorRawToUpstreamModel', () => {
  const flags = new Set<string>();

  test('uses the parsed context window when present', () => {
    const model = cursorRawToUpstreamModel({ id: 'claude-opus-4-8', display_name: 'Opus', contextWindow: 300_000 }, flags);
    expect(model.limits.max_context_window_tokens).toBe(300_000);
  });

  test('falls back to 200k when no context window was parsed', () => {
    const model = cursorRawToUpstreamModel({ id: 'auto', display_name: 'Auto' }, flags);
    expect(model.limits.max_context_window_tokens).toBe(200_000);
  });
});

describe('fetchCursorCatalog context enrichment', () => {
  const opts = (fetcher: Fetcher) => ({ accessToken: 'tok', timezone: 'UTC', fetcher });

  test('joins AvailableModels tooltip context by name, legacySlug, and idAlias', async () => {
    const available = jsonResponse({
      models: [
        { name: 'claude-opus-4-8-high', tooltipData: { markdownContent: '**Opus**<br />300k context window' }, legacySlugs: ['claude-opus-4-8'] },
        { name: 'gpt-5.5-high', tooltipData: { markdownContent: '272k context window' } },
        { name: 'default', tooltipData: { markdownContent: '**Auto**<br />Balanced.' }, idAliases: ['auto'] },
        { name: 'composer-2.5', tooltipData: { markdownContent: '200k context window' }, idAliases: ['composer'] },
      ],
    });
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      // usable ids include one hit-by-name, one hit-by-legacySlug, one hit-by-alias,
      // 'default' (no context phrase → fallback), and one absent from AvailableModels.
      usable: () => usableModels(['claude-opus-4-8-high', 'claude-opus-4-8', 'composer', 'default', 'kimi-k2.5']),
      available: () => available,
    })));

    const byId = Object.fromEntries(raw.map(r => [r.id, r.contextWindow]));
    expect(byId['claude-opus-4-8-high']).toBe(300_000); // by name
    expect(byId['claude-opus-4-8']).toBe(300_000); // by legacySlug
    expect(byId['composer']).toBe(200_000); // by idAlias
    expect(byId['default']).toBeUndefined(); // no context phrase → left unset (→ 200k default downstream)
    expect(byId['kimi-k2.5']).toBeUndefined(); // absent from AvailableModels
  });

  test('AvailableModels failure never breaks the catalog — all models fall back', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      usable: () => usableModels(['claude-opus-4-8', 'gpt-5.5']),
      available: () => new Response('nope', { status: 500 }),
    })));
    expect(raw.map(r => r.id)).toEqual(['claude-opus-4-8', 'gpt-5.5']);
    expect(raw.every(r => r.contextWindow === undefined)).toBe(true);
    // Downstream every one lands on the 200k default.
    const flags = new Set<string>();
    expect(cursorRawToUpstreamModel(raw[0], flags).limits.max_context_window_tokens).toBe(200_000);
  });

  test('AvailableModels throwing (dial error) is swallowed', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      usable: () => usableModels(['gpt-5.5']),
      available: () => { throw new Error('dial failed'); },
    })));
    expect(raw).toHaveLength(1);
    expect(raw[0].contextWindow).toBeUndefined();
  });
});
