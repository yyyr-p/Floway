import { generateCursorChecksum } from './checksum.ts';
import { CURSOR_AVAILABLE_MODELS_PATH, CURSOR_BACKEND_BASE, CURSOR_CLIENT_VERSION, CURSOR_USABLE_MODELS_PATH, CURSOR_USER_AGENT } from './constants.ts';
import { pricingForCursorModelKey } from './pricing.ts';
import { type Fetcher, type UpstreamModel } from '@floway-dev/provider';

export interface CursorRawModel {
  id: string;
  display_name: string;
  aliases?: readonly string[];
  // Context window (tokens) parsed from the AvailableModels tooltip prose, when
  // a match was found. Undefined leaves cursorRawToUpstreamModel on its default.
  contextWindow?: number;
}

// Shared Connect-JSON headers for the CLI-impersonating catalog RPCs
// (GetUsableModels + AvailableModels), which take the same auth + client headers.
const catalogHeaders = (accessToken: string, checksum: string, timezone: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  'content-type': 'application/json',
  accept: 'application/json',
  'connect-protocol-version': '1',
  'user-agent': CURSOR_USER_AGENT,
  'x-cursor-checksum': checksum,
  'x-cursor-client-version': CURSOR_CLIENT_VERSION,
  'x-cursor-client-type': 'cli',
  'x-cursor-timezone': timezone,
  'x-ghost-mode': 'true',
});

// GetUsableModels is called over Connect JSON (not grpc-web) — the same
// endpoint the Cursor CLI hits for its model picker. `fetcher` is required so
// the catalog refresh traverses the same proxy/dial chain as request traffic.
// Context windows come from AvailableModels tooltips (best-effort — see below).
export const fetchCursorCatalog = async (opts: {
  accessToken: string;
  timezone: string;
  signal?: AbortSignal;
  fetcher: Fetcher;
}): Promise<CursorRawModel[]> => {
  const checksum = await generateCursorChecksum(opts.accessToken);
  const headers = catalogHeaders(opts.accessToken, checksum, opts.timezone);

  // AvailableModels enrichment must never break the catalog refresh (which also
  // mints the access token) — on any failure fall back to an empty map, and
  // every model lands on cursorRawToUpstreamModel's default context window.
  const [usable, contextByKey] = await Promise.all([
    fetchUsableModels(opts.fetcher, headers, opts.signal),
    fetchCursorAvailableContext(opts.fetcher, headers, opts.signal).catch(() => new Map<string, number>()),
  ]);

  return usable.map(r => {
    const contextWindow = contextByKey.get(r.id);
    return contextWindow === undefined ? r : { ...r, contextWindow };
  });
};

const fetchUsableModels = async (fetcher: Fetcher, headers: Record<string, string>, signal?: AbortSignal): Promise<CursorRawModel[]> => {
  const response = await fetcher(`${CURSOR_BACKEND_BASE}${CURSOR_USABLE_MODELS_PATH}`, {
    method: 'POST',
    headers,
    body: '{}',
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cursor GetUsableModels fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Cursor GetUsableModels response missing models array');
  return parsed.models.map(assertRawModel);
};

// Parse a context window out of an AvailableModels tooltip's markdown prose.
// Cursor exposes NO serialized numeric context field (proto field 15/16 is
// never populated on the wire, under any client-type or request flag), so the
// "<N>k/M context window" phrase in the tooltip is the only machine-readable
// source. Returns null when the prose carries no such phrase (e.g. Auto).
export const parseContextWindow = (markdown: string): number | null => {
  const m = /([0-9][0-9.]*)\s*([kKmM])\s*context\s*window/.exec(markdown);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const scale = m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
  return Math.round(value * scale);
};

// Build a { modelId -> contextWindow } map from AvailableModels. Body is `{}`
// (the variant-level list of ~153 entries whose `name` aligns with
// GetUsableModels' modelId) — NOT useModelParameters, which collapses to ~32
// base models and would not join the per-variant catalog. Each parsed context
// is keyed by `name` plus every legacySlug/idAlias so more usable ids join.
export const fetchCursorAvailableContext = async (
  fetcher: Fetcher,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, number>> => {
  const response = await fetcher(`${CURSOR_BACKEND_BASE}${CURSOR_AVAILABLE_MODELS_PATH}`, {
    method: 'POST',
    headers,
    body: '{}',
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cursor AvailableModels fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as { models?: unknown };
  const out = new Map<string, number>();
  if (!Array.isArray(parsed.models)) return out;

  for (const entry of parsed.models) {
    if (!isPlainRecord(entry)) continue;
    const tooltip = isPlainRecord(entry.tooltipData) && typeof entry.tooltipData.markdownContent === 'string'
      ? entry.tooltipData.markdownContent
      : '';
    const context = parseContextWindow(tooltip);
    if (context === null) continue;

    const keys: string[] = [];
    if (typeof entry.name === 'string') keys.push(entry.name);
    for (const field of ['legacySlugs', 'idAliases'] as const) {
      const list = entry[field];
      if (Array.isArray(list)) for (const s of list) if (typeof s === 'string') keys.push(s);
    }
    for (const key of keys) if (!out.has(key)) out.set(key, context);
  }
  return out;
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const assertRawModel = (value: unknown): CursorRawModel => {
  if (!isPlainRecord(value)) throw new TypeError('Cursor model entry is not an object');
  const modelId = typeof value.modelId === 'string' ? value.modelId : undefined;
  const displayModelId = typeof value.displayModelId === 'string' ? value.displayModelId : undefined;
  const id = modelId ?? displayModelId;
  if (!id) throw new TypeError('Cursor model entry missing modelId/displayModelId');

  const displayName = typeof value.displayName === 'string' ? value.displayName : undefined;
  const displayNameShort = typeof value.displayNameShort === 'string' ? value.displayNameShort : undefined;
  const display_name = displayName ?? displayNameShort ?? id;

  const raw: CursorRawModel = { id, display_name };

  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) throw new TypeError(`Cursor model entry ${id} aliases not an array`);
    const out: string[] = [];
    for (const a of value.aliases) {
      if (typeof a !== 'string') throw new TypeError(`Cursor model entry ${id} alias not a string`);
      if (!out.includes(a)) out.push(a);
    }
    raw.aliases = out;
  }

  return raw;
};

// Cursor exposes only the Chat Completions endpoint (RunSSE+BidiAppend).
// Pricing is looked up from the per-model notional table in pricing.ts so the
// dashboard can report value consumed vs. the flat Cursor subscription.
//
// Modalities / reasoning config are not surfaced by GetUsableModels; left
// unset here and refined once a real capture documents per-model capabilities.
export const cursorRawToUpstreamModel = (raw: CursorRawModel, enabledFlags: ReadonlySet<string>): UpstreamModel => {
  const cost = pricingForCursorModelKey(raw.id);
  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'cursor',
    kind: 'chat',
    // Normal-mode context window parsed from the AvailableModels tooltip prose
    // (cursor surfaces no numeric field). 200k is the fallback for models whose
    // tooltip named no window (e.g. Auto) or that AvailableModels didn't cover.
    // Max Mode's larger window is a separate, deferred feature.
    limits: { max_context_window_tokens: raw.contextWindow ?? 200_000 },
    endpoints: { chatCompletions: {} },
    enabledFlags,
    ...(cost ? { cost } : {}),
  };
};
