// Per-request scratchpad threaded through the shim's turn-by-turn SSE
// merge, plus the helpers that read / write it. Counters are
// downstream-only — upstream output_index / sequence_number reset to 0
// per run().

import type {
  ResponseOutputItem,
  ResponsesResult,
} from '@floway-dev/protocols/responses';

// Sparse on purpose: a field is present only when at least one turn
// reported a non-null/undefined value. Internal sums treat missing
// fields as 0; the wire output omits anything never observed so we
// don't fabricate `cached_tokens: 0` for an upstream that doesn't
// report cache.
export interface MergeUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}

export interface MergeState {
  sequenceNumber: number;
  outputIndex: number;
  // Sparse: umbrella reserves its slot at start-frame time but its
  // terminal item lands later (after backend resolves); items emitted
  // after the umbrella in source order may finalize first.
  // `materializeAccumulatedOutput` densifies in index order at terminal.
  accumulatedOutput: Map<number, ResponseOutputItem>;
  accumulatedUsage: Partial<MergeUsage>;
  // Last-wins capture of upstream's `response.created.model`; throws
  // at synthesis time (`ensureModel`) when never observed rather than
  // inventing a fallback.
  lastSeenModel: string | null;
  // Synthesized once at shim activation (`resp_shim_<uuid>`) and
  // quoted on every downstream synthesized envelope. Upstream's
  // `response.id` rotates per turn (each `response.created` can
  // carry a different id), so a single cross-turn shim id is the
  // only honest identity downstream clients can correlate against.
  // We do NOT expose upstream's id downstream; the shim is the
  // server boundary the client talks to, and the cross-turn
  // conversation it sees is the shim's own response.
  synthesizedResponseId: string;
  // Snapshot of the latest upstream `ResponsesResult` envelope. Set on
  // every upstream `response.created` and refreshed by terminal frames.
  // Synthesizers spread this verbatim and override only the fields the
  // shim owns; without it, upstream-only wire fields (`tools`,
  // `tool_choice`, `temperature`, `parallel_tool_calls`, `reasoning`,
  // `service_tier`, `metadata`, `previous_response_id`, …) would
  // silently disappear from the downstream envelope.
  upstreamResponseSnapshot: ResponsesResult | undefined;
}

const synthesizeShimResponseId = (): string =>
  `resp_shim_${crypto.randomUUID().replace(/-/g, '')}`;

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: synthesizeShimResponseId(),
  upstreamResponseSnapshot: undefined,
});

export const materializeAccumulatedOutput = (state: MergeState): ResponseOutputItem[] => {
  const sorted = [...state.accumulatedOutput.keys()].sort((a, b) => a - b);
  return sorted.map(k => state.accumulatedOutput.get(k)!);
};

// Rebuild the SDK-convenience `output_text` alias from the cross-turn
// `accumulatedOutput`. Native upstreams' per-turn `output_text` on a
// terminal snapshot only describes that one turn, so leaving the
// snapshot value would desync from `output` on multi-turn responses.
// We walk every accumulated message item, pull each text content
// block, and concatenate — matching the openai-python
// `Response.output_text` property (`"".join(c.text for item in output
// if item.type == "message" for c in item.content if c.type ==
// "output_text")`).
export const rebuildOutputText = (items: readonly ResponseOutputItem[]): string => {
  let out = '';
  for (const item of items) {
    if (item.type !== 'message') continue;
    for (const block of item.content) {
      if (block.type === 'output_text') out += block.text;
    }
  }
  return out;
};

// Sparse usage merge: a field appears only when at least one operand
// reported it. Sub-details (`cached_tokens`, `reasoning_tokens`) are
// independent breakdowns of `input_tokens` / `output_tokens` and are
// NOT added to the parent.
export const sumUsage = (a: Partial<MergeUsage>, b: Partial<MergeUsage>): Partial<MergeUsage> => {
  const out: Partial<MergeUsage> = {};
  const sumScalar = (
    key: 'input_tokens' | 'output_tokens' | 'total_tokens',
  ) => {
    if (a[key] !== undefined || b[key] !== undefined) {
      out[key] = (a[key] ?? 0) + (b[key] ?? 0);
    }
  };
  sumScalar('input_tokens');
  sumScalar('output_tokens');
  sumScalar('total_tokens');
  if (a.input_tokens_details !== undefined || b.input_tokens_details !== undefined) {
    out.input_tokens_details = {
      cached_tokens:
        (a.input_tokens_details?.cached_tokens ?? 0) + (b.input_tokens_details?.cached_tokens ?? 0),
    };
  }
  if (a.output_tokens_details !== undefined || b.output_tokens_details !== undefined) {
    out.output_tokens_details = {
      reasoning_tokens:
        (a.output_tokens_details?.reasoning_tokens ?? 0)
        + (b.output_tokens_details?.reasoning_tokens ?? 0),
    };
  }
  return out;
};

// Project the accumulator onto the wire `usage` shape. Returns
// `undefined` when no field was ever observed across the whole run
// (upstream never reported usage), matching what a native upstream
// would emit for an unmetered call.
export const usageForWire = (state: MergeState): ResponsesResult['usage'] => {
  const u = state.accumulatedUsage;
  if (
    u.input_tokens === undefined
    && u.output_tokens === undefined
    && u.total_tokens === undefined
    && u.input_tokens_details === undefined
    && u.output_tokens_details === undefined
  ) {
    return undefined;
  }
  // The wire type requires the three scalar fields, so when only
  // sub-details were ever reported we still anchor 0s for the
  // scalars. We do NOT anchor the sub-detail objects because they're
  // optional on the wire.
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    ...(u.input_tokens_details !== undefined ? { input_tokens_details: u.input_tokens_details } : {}),
    ...(u.output_tokens_details !== undefined ? { output_tokens_details: u.output_tokens_details } : {}),
  };
};

// Lift a wire usage object into the sparse `MergeUsage` shape. Fields
// the upstream did not include stay undefined so the accumulator
// remembers the "never observed" state.
export const usageOf = (usage: ResponsesResult['usage']): Partial<MergeUsage> => {
  if (usage === undefined) return {};
  const out: Partial<MergeUsage> = {};
  if (usage.input_tokens !== undefined) out.input_tokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) out.output_tokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  if (usage.input_tokens_details !== undefined) out.input_tokens_details = usage.input_tokens_details;
  if (usage.output_tokens_details !== undefined) out.output_tokens_details = usage.output_tokens_details;
  return out;
};
