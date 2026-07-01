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
  // The concrete Cursor model id to put on the wire (a usable variant slug),
  // when this catalog entry is a collapsed base whose display id differs from
  // the id Cursor's RunSSE accepts. Absent → wire id equals `id`.
  wireModelId?: string;
  // Variant/alias ids that collapse to this base — used to alias an old
  // per-variant request id back onto the base model (backward compatibility).
  variantIds?: readonly string[];
}

// One Cursor "base" model from AvailableModels(useModelParameters=true): the
// server's own collapse of the ~150 per-variant slugs into ~32 families, each
// carrying its variant list, per-mode tooltips, and display name.
export interface CursorBaseModel {
  name: string;
  displayName: string;
  contextNormal: number | null;
  contextMax: number | null;
  variants: { legacySlug: string; isDefaultNonMaxConfig: boolean; isDefaultMaxConfig: boolean }[];
  aliasSlugs: string[];
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

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// Fetch + collapse the Cursor catalog. GetUsableModels is the entitlement gate
// (which per-variant slugs this account may send); AvailableModels(useModel-
// Parameters) supplies the base grouping, per-mode context windows, and display
// names. The two are joined into one Floway model per base, with the base's
// default variant slug as the wire id. AvailableModels is best-effort: on any
// failure we fall back to the raw per-variant list (no collapse, 200k default)
// so the upstream keeps working. `fetcher` traverses the same proxy/dial chain
// as request traffic. `maxMode` selects the max-mode context + default variant.
export const fetchCursorCatalog = async (opts: {
  accessToken: string;
  timezone: string;
  signal?: AbortSignal;
  fetcher: Fetcher;
  maxMode?: boolean;
}): Promise<CursorRawModel[]> => {
  const checksum = await generateCursorChecksum(opts.accessToken);
  const headers = catalogHeaders(opts.accessToken, checksum, opts.timezone);

  const [usable, bases] = await Promise.all([
    fetchUsableModels(opts.fetcher, headers, opts.signal),
    fetchCursorBaseModels(opts.fetcher, headers, opts.signal).catch(() => null),
  ]);

  if (!bases) return usable; // collapse/enrichment unavailable → raw variant list
  return buildCollapsedCatalog(usable, bases, opts.maxMode ?? false);
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

// AvailableModels with useModelParameters=true returns the base-grouped catalog
// (~32 families, each with a `variants` array + per-mode tooltips) rather than
// the flat per-variant list. This is the authoritative source for collapsing.
export const fetchCursorBaseModels = async (
  fetcher: Fetcher,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<CursorBaseModel[]> => {
  const response = await fetcher(`${CURSOR_BACKEND_BASE}${CURSOR_AVAILABLE_MODELS_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ useModelParameters: true }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cursor AvailableModels fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as { models?: unknown };
  const out: CursorBaseModel[] = [];
  if (!Array.isArray(parsed.models)) return out;

  const markdown = (v: unknown): string => (isPlainRecord(v) && typeof v.markdownContent === 'string' ? v.markdownContent : '');
  for (const entry of parsed.models) {
    if (!isPlainRecord(entry) || typeof entry.name !== 'string') continue;

    const variants: CursorBaseModel['variants'] = [];
    if (Array.isArray(entry.variants)) {
      for (const v of entry.variants) {
        if (!isPlainRecord(v) || typeof v.legacySlug !== 'string') continue;
        variants.push({
          legacySlug: v.legacySlug,
          isDefaultNonMaxConfig: v.isDefaultNonMaxConfig === true,
          isDefaultMaxConfig: v.isDefaultMaxConfig === true,
        });
      }
    }

    const aliasSlugs: string[] = [];
    for (const field of ['legacySlugs', 'idAliases'] as const) {
      const list = entry[field];
      if (Array.isArray(list)) for (const s of list) if (typeof s === 'string') aliasSlugs.push(s);
    }

    out.push({
      name: entry.name,
      displayName: typeof entry.clientDisplayName === 'string' ? entry.clientDisplayName : entry.name,
      contextNormal: parseContextWindow(markdown(entry.tooltipData)),
      contextMax: parseContextWindow(markdown(entry.tooltipDataForMaxMode)),
      variants,
      aliasSlugs,
    });
  }
  return out;
};

// Collapse the base catalog against the usable-id gate into one Floway model per
// base. The wire id is the mode-appropriate default variant (or any usable
// variant, or the base name) that the account can actually send. Bases with no
// usable variant are dropped (not entitled). Any usable id no base claimed is
// appended uncollapsed so a request for it never 404s.
export const buildCollapsedCatalog = (
  usable: readonly CursorRawModel[],
  bases: readonly CursorBaseModel[],
  maxMode: boolean,
): CursorRawModel[] => {
  const usableIds = new Set(usable.map(r => r.id));
  const claimed = new Set<string>();
  const out: CursorRawModel[] = [];

  for (const b of bases) {
    // Prefer the mode's default variant, then any variant, then the bare base
    // name — first one the account can actually send wins.
    const preferred = b.variants.filter(v => (maxMode ? v.isDefaultMaxConfig : v.isDefaultNonMaxConfig));
    let wire: string | undefined;
    for (const v of [...preferred, ...b.variants]) {
      if (usableIds.has(v.legacySlug)) { wire = v.legacySlug; break; }
    }
    if (!wire && usableIds.has(b.name)) wire = b.name;
    if (!wire) continue; // this account can't use any variant of the base

    const variantIds: string[] = [];
    for (const v of b.variants) if (usableIds.has(v.legacySlug)) { variantIds.push(v.legacySlug); claimed.add(v.legacySlug); }
    for (const s of b.aliasSlugs) if (usableIds.has(s)) { variantIds.push(s); claimed.add(s); }
    claimed.add(wire);
    claimed.add(b.name);

    const context = maxMode ? (b.contextMax ?? b.contextNormal) : b.contextNormal;
    out.push({
      id: b.name,
      display_name: b.displayName,
      ...(context !== null ? { contextWindow: context } : {}),
      wireModelId: wire,
      variantIds,
    });
  }

  for (const r of usable) if (!claimed.has(r.id)) out.push(r);
  return out;
};

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
export const cursorRawToUpstreamModel = (raw: CursorRawModel, enabledFlags: ReadonlySet<string>): UpstreamModel => {
  const cost = pricingForCursorModelKey(raw.id);
  // Carry the wire id (so fetch.ts sends the usable variant slug while the
  // catalog keeps the clean base id) and the pre-collapse variant ids (so the
  // registry can alias an old per-variant request onto this base).
  const providerData: { wireModelId?: string; variantIds?: readonly string[] } = {};
  if (raw.wireModelId && raw.wireModelId !== raw.id) providerData.wireModelId = raw.wireModelId;
  if (raw.variantIds && raw.variantIds.length > 0) providerData.variantIds = raw.variantIds;

  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'cursor',
    kind: 'chat',
    // Context window parsed from the AvailableModels tooltip prose (cursor
    // surfaces no numeric field): normal- or max-mode value per the upstream's
    // maxMode toggle. 200k is the fallback for models whose tooltip named no
    // window (e.g. Auto) or that AvailableModels didn't cover.
    limits: { max_context_window_tokens: raw.contextWindow ?? 200_000 },
    endpoints: { chatCompletions: {} },
    enabledFlags,
    ...(providerData.wireModelId || providerData.variantIds ? { providerData } : {}),
    ...(cost ? { cost } : {}),
  };
};

// The concrete Cursor model id to put on the RunSSE wire for a resolved model:
// the collapsed base's usable variant slug (from providerData) or the id itself.
export const cursorWireModelId = (model: UpstreamModel): string => {
  const data = model.providerData;
  if (isPlainRecord(data) && typeof data.wireModelId === 'string') return data.wireModelId;
  return model.id;
};
