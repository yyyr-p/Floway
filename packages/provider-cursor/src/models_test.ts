import { describe, expect, test } from 'vitest';

import {
  buildCollapsedCatalog,
  cursorRawToUpstreamModel,
  cursorWireModelId,
  fetchCursorCatalog,
  parseContextWindow,
  type CursorBaseModel,
  type CursorRawModel,
} from './models.ts';
import { type Fetcher, type UpstreamModel } from '@floway-dev/provider';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

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

type V = { slug: string; defNonMax?: boolean; defMax?: boolean };

// Parsed CursorBaseModel (what buildCollapsedCatalog consumes).
const pbase = (name: string, variants: V[], contextNormal: number | null = null, contextMax: number | null = null): CursorBaseModel => ({
  name,
  displayName: name,
  contextNormal,
  contextMax,
  variants: variants.map(v => ({ legacySlug: v.slug, isDefaultNonMaxConfig: v.defNonMax === true, isDefaultMaxConfig: v.defMax === true })),
  aliasSlugs: [],
});

// Raw AvailableModels(useModelParameters) JSON entry (what fetchCursorBaseModels parses).
const rawBase = (name: string, variants: V[], ctxNormal?: string, ctxMax?: string) => ({
  name,
  clientDisplayName: name,
  tooltipData: { markdownContent: ctxNormal ? `**${name}**<br />${ctxNormal} context window` : `**${name}**` },
  ...(ctxMax ? { tooltipDataForMaxMode: { markdownContent: `**${name}**<br />${ctxMax} context window` } } : {}),
  variants: variants.map(v => ({
    legacySlug: v.slug,
    ...(v.defNonMax ? { isDefaultNonMaxConfig: true } : {}),
    ...(v.defMax ? { isDefaultMaxConfig: true } : {}),
  })),
});

describe('parseContextWindow', () => {
  test('parses k and M suffixes', () => {
    expect(parseContextWindow('**X**<br />200k context window')).toBe(200_000);
    expect(parseContextWindow('300k context window')).toBe(300_000);
    expect(parseContextWindow('272k context window')).toBe(272_000);
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
  test('carries context and a differing wire id as providerData', () => {
    const m = cursorRawToUpstreamModel({ id: 'claude-opus-4-8', display_name: 'Opus', contextWindow: 300_000, wireModelId: 'claude-opus-4-8-high' }, flags);
    expect(m.limits.max_context_window_tokens).toBe(300_000);
    expect(m.providerData).toEqual({ wireModelId: 'claude-opus-4-8-high' });
  });
  test('no providerData when wire id equals id; 200k fallback', () => {
    const m = cursorRawToUpstreamModel({ id: 'default', display_name: 'Auto', wireModelId: 'default' }, flags);
    expect(m.providerData).toBeUndefined();
    expect(m.limits.max_context_window_tokens).toBe(200_000);
  });
  test('carries pre-collapse variant ids in providerData for aliasing', () => {
    const m = cursorRawToUpstreamModel({ id: 'claude-opus-4-8', display_name: 'Opus', wireModelId: 'claude-opus-4-8-high', variantIds: ['claude-opus-4-8-high', 'claude-opus-4-8-max'] }, flags);
    expect(m.providerData).toEqual({ wireModelId: 'claude-opus-4-8-high', variantIds: ['claude-opus-4-8-high', 'claude-opus-4-8-max'] });
  });
});

describe('cursorWireModelId', () => {
  test('reads providerData.wireModelId, else the id', () => {
    expect(cursorWireModelId({ id: 'claude-opus-4-8', providerData: { wireModelId: 'claude-opus-4-8-high' } } as UpstreamModel)).toBe('claude-opus-4-8-high');
    expect(cursorWireModelId({ id: 'gpt-5.5' } as UpstreamModel)).toBe('gpt-5.5');
  });
});

describe('buildCollapsedCatalog', () => {
  const usable: CursorRawModel[] = [
    'claude-opus-4-8-high', 'claude-opus-4-8-max', 'composer-2.5', 'default', 'kimi-k2.5', 'gpt-5.5-high',
  ].map(id => ({ id, display_name: id }));

  const bases = [
    pbase('claude-opus-4-8', [{ slug: 'claude-opus-4-8-high', defNonMax: true }, { slug: 'claude-opus-4-8-max', defMax: true }], 300_000, 1_000_000),
    pbase('composer-2.5', [{ slug: 'composer-2.5-fast', defNonMax: true, defMax: true }, { slug: 'composer-2.5' }], 200_000, 200_000),
    pbase('default', [{ slug: 'default', defNonMax: true, defMax: true }]),
    pbase('gpt-5.5', [{ slug: 'gpt-5.5-high', defNonMax: true }], 272_000, 1_000_000),
    pbase('phantom', [{ slug: 'phantom-x', defNonMax: true }], 128_000), // no usable variant → dropped
  ];

  test('collapses to one model per usable base, normal mode', () => {
    const out = buildCollapsedCatalog(usable, bases, false);
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    expect(out).toHaveLength(5); // 4 collapsed + kimi leftover; phantom dropped
    expect(byId['phantom']).toBeUndefined();

    expect(byId['claude-opus-4-8'].wireModelId).toBe('claude-opus-4-8-high');
    expect(byId['claude-opus-4-8'].contextWindow).toBe(300_000);
    expect(byId['claude-opus-4-8'].variantIds).toEqual(['claude-opus-4-8-high', 'claude-opus-4-8-max']);

    expect(byId['composer-2.5'].wireModelId).toBe('composer-2.5'); // fast not usable → fallback
    expect(byId['composer-2.5'].contextWindow).toBe(200_000);

    expect(byId['default'].wireModelId).toBe('default');
    expect(byId['default'].contextWindow).toBeUndefined();

    expect(byId['gpt-5.5'].wireModelId).toBe('gpt-5.5-high');

    expect(byId['kimi-k2.5'].wireModelId).toBeUndefined(); // leftover, uncollapsed
  });

  test('max mode picks the default-max variant + max context', () => {
    const out = buildCollapsedCatalog(usable, bases, true);
    const opus = out.find(r => r.id === 'claude-opus-4-8')!;
    expect(opus.wireModelId).toBe('claude-opus-4-8-max');
    expect(opus.contextWindow).toBe(1_000_000);
  });
});

describe('fetchCursorCatalog', () => {
  const opts = (fetcher: Fetcher, maxMode?: boolean) => ({ accessToken: 'tok', timezone: 'UTC', fetcher, maxMode });

  const availableResponse = () => jsonResponse({
    models: [
      rawBase('claude-opus-4-8', [{ slug: 'claude-opus-4-8-high', defNonMax: true }], '300k', '1M'),
      rawBase('gpt-5.5', [{ slug: 'gpt-5.5-high', defNonMax: true }], '272k'),
    ],
  });

  test('collapses variants into base models with wire ids + context', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      usable: () => usableModels(['claude-opus-4-8-high', 'gpt-5.5-high']),
      available: availableResponse,
    })));
    expect(raw.map(r => r.id).sort()).toEqual(['claude-opus-4-8', 'gpt-5.5']);
    const opus = raw.find(r => r.id === 'claude-opus-4-8')!;
    expect(opus.wireModelId).toBe('claude-opus-4-8-high');
    expect(opus.contextWindow).toBe(300_000);
  });

  test('max mode uses the max-mode context', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      usable: () => usableModels(['claude-opus-4-8-high', 'gpt-5.5-high']),
      available: availableResponse,
    }), true));
    expect(raw.find(r => r.id === 'claude-opus-4-8')!.contextWindow).toBe(1_000_000);
  });

  test('falls back to the raw per-variant list when AvailableModels fails', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      usable: () => usableModels(['claude-opus-4-8-high', 'gpt-5.5-high']),
      available: () => new Response('nope', { status: 500 }),
    })));
    expect(raw.map(r => r.id)).toEqual(['claude-opus-4-8-high', 'gpt-5.5-high']);
    expect(raw.every(r => r.wireModelId === undefined)).toBe(true);
  });

  test('AvailableModels throwing (dial error) is swallowed', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({
      usable: () => usableModels(['gpt-5.5-high']),
      available: () => { throw new Error('dial failed'); },
    })));
    expect(raw).toHaveLength(1);
    expect(raw[0].id).toBe('gpt-5.5-high');
  });
});
