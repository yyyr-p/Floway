import { generateCursorChecksum } from './checksum.ts';
import { CURSOR_BACKEND_BASE, CURSOR_CLIENT_VERSION, CURSOR_USABLE_MODELS_PATH, CURSOR_USER_AGENT } from './constants.ts';
import { pricingForCursorModelKey } from './pricing.ts';
import { type Fetcher, type UpstreamModel } from '@floway-dev/provider';

export interface CursorRawModel {
  id: string;
  display_name: string;
  aliases?: readonly string[];
}

// GetUsableModels is called over Connect JSON (not grpc-web) — the same
// endpoint the Cursor CLI hits for its model picker. `fetcher` is required so
// the catalog refresh traverses the same proxy/dial chain as request traffic.
export const fetchCursorCatalog = async (opts: {
  accessToken: string;
  timezone: string;
  signal?: AbortSignal;
  fetcher: Fetcher;
}): Promise<CursorRawModel[]> => {
  const checksum = await generateCursorChecksum(opts.accessToken);
  const response = await opts.fetcher(`${CURSOR_BACKEND_BASE}${CURSOR_USABLE_MODELS_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'connect-protocol-version': '1',
      'user-agent': CURSOR_USER_AGENT,
      'x-cursor-checksum': checksum,
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
      'x-cursor-client-type': 'cli',
      'x-cursor-timezone': opts.timezone,
      'x-ghost-mode': 'true',
    },
    body: '{}',
    signal: opts.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cursor GetUsableModels fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Cursor GetUsableModels response missing models array');
  return parsed.models.map(assertRawModel);
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
    // GetUsableModels does not surface a context window. Use a conservative
    // default until a real capture documents per-model limits.
    limits: { max_context_window_tokens: 200_000 },
    endpoints: { chatCompletions: {} },
    enabledFlags,
    ...(cost ? { cost } : {}),
  };
};
