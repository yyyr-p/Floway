import type { ControlPlaneModel } from '../../api/types.ts';

export const CLAUDE_TIER_KEYS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeTierKey = typeof CLAUDE_TIER_KEYS[number];
const CLAUDE_TIER: Record<ClaudeTierKey, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };
export const CLAUDE_TIER_LABELS: Record<ClaudeTierKey, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

// Regex (rather than startsWith) so prefixed surfaces — e.g. `vendor/claude-…`
// or `vendor/gpt-5-…` from upstreams configured with a model-name prefix —
// sort and group with their unprefixed peers.
export const CLAUDE_RE = /(^|\/)claude-/;
export const CODEX_RE = /(^|\/)gpt-5/;

export const claudeTier = (id: string): number => {
  // Gate on CLAUDE_RE first so a non-Claude id whose name happens to contain
  // one of the tier tokens (e.g. `vendor/gpt-4-opus-finetune`) cannot land
  // in a tier and win a default slot via the reversed-localeCompare tiebreak
  // in `sortByTierDistance`. Mirrors the CODEX_RE gate in `sortCodex`.
  if (!CLAUDE_RE.test(id)) return 99;
  for (const t of CLAUDE_TIER_KEYS) if (id.includes(t)) return CLAUDE_TIER[t];
  return 99;
};

export const sortByTierDistance = (target: ClaudeTierKey) => (a: string, b: string): number => {
  const t = CLAUDE_TIER[target];
  const da = Math.abs(claudeTier(a) - t);
  const db = Math.abs(claudeTier(b) - t);
  return da !== db ? da - db : b.localeCompare(a);
};

export const sortCodex = (a: string, b: string): number => {
  // Codex-family (gpt-5*) ids rank above the rest so the default lands on a
  // Codex model even when the pool contains foreign ids the operator might
  // route through Floway's translator. Symmetric to the CLAUDE_RE gate at
  // the top of `claudeTier`; kept as an explicit tier here because Codex's
  // ranking has a second axis (mini vs non-mini) below the family gate.
  const ac = CODEX_RE.test(a) ? 0 : 1;
  const bc = CODEX_RE.test(b) ? 0 : 1;
  if (ac !== bc) return ac - bc;
  const am = a.includes('mini') ? 1 : 0;
  const bm = b.includes('mini') ? 1 : 0;
  return am !== bm ? am - bm : b.localeCompare(a);
};

export type GroupedIds = { matched: string[]; other: string[] };
export const partition = (list: string[], re: RegExp): GroupedIds => ({
  matched: list.filter(id => re.test(id)),
  other: list.filter(id => !re.test(id)),
});

// Per-id context-window lookup so the fable/opus/sonnet slots can append the
// `[1m]` suffix when the upstream advertises a 1M context window. Family-
// agnostic to mirror the /v1/models handler's own `[1m]` emission at
// `packages/gateway/src/data-plane/models/serve.ts` — the CLI strips the
// suffix and translates it into `anthropic-beta: context-1m-2025-08-07`,
// which providers already handle per-family. Haiku stays plain — background-
// task slot, 1M cost isn't warranted.
export const computeContextById = (models: readonly ControlPlaneModel[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const m of models) {
    if (m.kind !== 'chat') continue;
    const lim = m.limits;
    const ctx = lim?.max_context_window_tokens ?? ((lim?.max_prompt_tokens ?? 0) + (lim?.max_output_tokens ?? 0));
    map.set(m.id, ctx);
  }
  return map;
};

export const addCtxSuffix = (id: string, contextById: Map<string, number>): string =>
  (contextById.get(id) ?? 0) >= 1_000_000 ? `${id}[1m]` : id;
