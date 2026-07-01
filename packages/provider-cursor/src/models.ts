import { generateCursorChecksum } from './checksum.ts';
import { CURSOR_AVAILABLE_MODELS_PATH, CURSOR_BACKEND_BASE, CURSOR_CLIENT_VERSION, CURSOR_USABLE_MODELS_PATH, CURSOR_USER_AGENT } from './constants.ts';
import { pricingForCursorModelKey } from './pricing.ts';
import { type Fetcher, type UpstreamChatModelConfig, type UpstreamModel } from '@floway-dev/provider';

export interface CursorReasoningInfo {
  supported: readonly string[];
  default: string;
}

export interface CursorRawModel {
  id: string;
  display_name: string;
  aliases?: readonly string[];
  // Context window (tokens) — undefined leaves cursorRawToUpstreamModel on 200k.
  contextWindow?: number;
  // The concrete Cursor model id to put on the wire (a usable variant slug),
  // when this base's display id differs from what RunSSE accepts.
  wireModelId?: string;
  // Pre-collapse variant/alias ids that map onto this base (registry aliasing).
  variantIds?: readonly string[];
  // Reasoning-effort levels the model exposes (→ chat.reasoning.effort).
  reasoning?: CursorReasoningInfo;
}

// One Cursor "base" model from AvailableModels(useModelParameters=true): the
// server's own collapse of the ~150 per-variant slugs into ~32 families, each
// carrying its variant list, per-mode context, reasoning capability, and
// display name. (Image modality is intentionally not surfaced: cursor's
// supportsImages field is unreliable and image input is not yet wired.)
export interface CursorBaseModel {
  name: string;
  displayName: string;
  contextNormal: number | null;
  contextMax: number | null;
  reasoning: CursorReasoningInfo | null;
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

// "300k" -> 300000, "1m" -> 1000000, "272k" -> 272000. Null on anything else.
const scaleTokenCount = (token: string): number | null => {
  const m = /^([0-9][0-9.]*)\s*([kKmM])$/.exec(token.trim());
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * (m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000));
};

// Fetch + collapse the Cursor catalog. GetUsableModels is the entitlement gate;
// AvailableModels(useModelParameters) supplies the base grouping, per-mode
// context, modality/reasoning capability, and display names. Joined into one
// Floway model per base, with the base's default usable variant slug as the
// wire id. AvailableModels is best-effort: on any failure we fall back to the
// raw per-variant list so the upstream keeps working. `maxMode` selects the
// max-mode context + default variant.
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
  const response = await fetcher(`${CURSOR_BACKEND_BASE}${CURSOR_USABLE_MODELS_PATH}`, { method: 'POST', headers, body: '{}', signal });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cursor GetUsableModels fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = (await response.json()) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Cursor GetUsableModels response missing models array');
  return parsed.models.map(assertRawModel);
};

// Parse a context window out of an AvailableModels tooltip's markdown prose.
// Used as the fallback when parameterDefinitions carries no structured `context`
// enum. Returns null when the prose names no window (e.g. Auto).
export const parseContextWindow = (markdown: string): number | null => {
  const m = /([0-9][0-9.]*\s*[kKmM])\s*context\s*window/.exec(markdown);
  return m ? scaleTokenCount(m[1].replace(/\s+/g, '')) : null;
};

// The tooltip's first bold heading is the model's full brand name
// ("**Claude Opus 4.8**") — richer than clientDisplayName ("Opus 4.8"). The
// trailing variant parenthetical ("(Fast)", "(Thinking)") is stripped. Null
// when the tooltip carries no bold heading.
const tooltipHeading = (markdown: string): string | null => {
  const m = /^\s*\*\*(.+?)\*\*/.exec(markdown);
  if (!m) return null;
  const name = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
  return name.length > 0 ? name : null;
};

// AvailableModels with useModelParameters=true returns the base-grouped catalog
// (~32 families, each with a `variants` array, `parameterDefinitions`, per-mode
// tooltips). Authoritative source for the collapse + capability metadata.
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

    const paramDefs = Array.isArray(entry.parameterDefinitions) ? entry.parameterDefinitions : [];
    const enumValues = (id: string): string[] | null => {
      for (const p of paramDefs) {
        if (!isPlainRecord(p) || p.id !== id) continue;
        const et = isPlainRecord(p.parameterType) ? p.parameterType.enumParameter : undefined;
        if (!isPlainRecord(et) || !Array.isArray(et.values)) return null;
        const vals = et.values.map(v => (isPlainRecord(v) && typeof v.value === 'string' ? v.value : null)).filter((x): x is string => x !== null);
        return vals.length > 0 ? vals : null;
      }
      return null;
    };

    // Context: prefer the structured `context` enum ([normal, max]); else the
    // tooltip prose. Some models leave one tooltip blank (e.g. the normal
    // tooltip empty but the max-mode tooltip naming "272k") — cross-fill so a
    // context stated in either tooltip is recovered rather than lost to 200k.
    const contextEnum = enumValues('context');
    const normalProse = parseContextWindow(markdown(entry.tooltipData));
    const maxProse = parseContextWindow(markdown(entry.tooltipDataForMaxMode));
    const contextNormal = contextEnum ? scaleTokenCount(contextEnum[0]) : (normalProse ?? maxProse);
    const contextMax = contextEnum && contextEnum.length > 1 ? scaleTokenCount(contextEnum[contextEnum.length - 1]) : (maxProse ?? normalProse);

    // Reasoning effort: enum id is `effort` (Anthropic) or `reasoning` (OpenAI).
    const effortId = paramDefs.some(p => isPlainRecord(p) && p.id === 'effort') ? 'effort'
      : paramDefs.some(p => isPlainRecord(p) && p.id === 'reasoning') ? 'reasoning' : null;
    const effortEnum = effortId ? enumValues(effortId) : null;

    const variants: CursorBaseModel['variants'] = [];
    let defaultEffort: string | null = null;
    if (Array.isArray(entry.variants)) {
      for (const v of entry.variants) {
        if (!isPlainRecord(v) || typeof v.legacySlug !== 'string') continue;
        const isDefaultNonMaxConfig = v.isDefaultNonMaxConfig === true;
        variants.push({ legacySlug: v.legacySlug, isDefaultNonMaxConfig, isDefaultMaxConfig: v.isDefaultMaxConfig === true });
        if (isDefaultNonMaxConfig && effortId && defaultEffort === null && Array.isArray(v.parameterValues)) {
          for (const pv of v.parameterValues) {
            if (isPlainRecord(pv) && pv.id === effortId && typeof pv.value === 'string') { defaultEffort = pv.value; break; }
          }
        }
      }
    }

    let reasoning: CursorReasoningInfo | null = null;
    if (effortEnum && effortEnum.length > 0) {
      const fallback = effortEnum.includes('medium') ? 'medium' : effortEnum[Math.floor(effortEnum.length / 2)];
      reasoning = { supported: effortEnum, default: defaultEffort && effortEnum.includes(defaultEffort) ? defaultEffort : fallback };
    }

    const aliasSlugs: string[] = [];
    for (const field of ['legacySlugs', 'idAliases'] as const) {
      const list = entry[field];
      if (Array.isArray(list)) for (const s of list) if (typeof s === 'string') aliasSlugs.push(s);
    }

    out.push({
      name: entry.name,
      displayName: tooltipHeading(markdown(entry.tooltipData)) ?? (typeof entry.clientDisplayName === 'string' ? entry.clientDisplayName : entry.name),
      contextNormal,
      contextMax,
      reasoning,
      variants,
      aliasSlugs,
    });
  }
  return out;
};

// Collapse the base catalog against the usable-id gate into one Floway model per
// base. The wire id is the mode-appropriate default variant (or any usable
// variant, or the base name) the account can send. Bases with no usable variant
// are dropped. Any usable id no base claimed is appended uncollapsed.
export const buildCollapsedCatalog = (
  usable: readonly CursorRawModel[],
  bases: readonly CursorBaseModel[],
  maxMode: boolean,
): CursorRawModel[] => {
  const usableIds = new Set(usable.map(r => r.id));
  const claimed = new Set<string>();
  const out: CursorRawModel[] = [];

  for (const b of bases) {
    const preferred = b.variants.filter(v => (maxMode ? v.isDefaultMaxConfig : v.isDefaultNonMaxConfig));
    let wire: string | undefined;
    for (const v of [...preferred, ...b.variants]) {
      if (usableIds.has(v.legacySlug)) { wire = v.legacySlug; break; }
    }
    if (!wire && usableIds.has(b.name)) wire = b.name;
    if (!wire) continue;

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
      ...(b.reasoning ? { reasoning: b.reasoning } : {}),
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

const buildChatConfig = (raw: CursorRawModel): UpstreamChatModelConfig | undefined => {
  // Only reasoning effort is surfaced. Image modality is deliberately omitted:
  // cursor's supportsImages field disagrees with reality for some models and
  // image input is not yet wired into the provider.
  if (!raw.reasoning) return undefined;
  return { reasoning: { effort: { supported: [...raw.reasoning.supported], default: raw.reasoning.default } } };
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
  const chat = buildChatConfig(raw);

  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'cursor',
    kind: 'chat',
    // Context window (normal- or max-mode per the upstream's maxMode toggle);
    // 200k fallback for models with no window (e.g. Auto) or not covered.
    limits: { max_context_window_tokens: raw.contextWindow ?? 200_000 },
    endpoints: { chatCompletions: {} },
    enabledFlags,
    ...(chat ? { chat } : {}),
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
