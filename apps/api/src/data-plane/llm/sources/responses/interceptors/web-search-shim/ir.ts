// Web_search_call IR — canonical representation of one search action,
// the model-visible error strings that feed into IR results, and the
// downstream lifecycle frames the IR materializes into. `id` is both the
// value the client sees on the synthesized `web_search_call` item and
// the seed for the upstream call_id when the reverse path replays the
// item.
//
// Error-text phrasings closely follow OpenAI's gpt-oss reference
// simple_browser tool so gpt-oss-family models (trained on those exact
// phrasings) recognize the structure; non-OpenAI models read them as
// plain natural-language tool output.
//
// References (pinned to commit 285b05d for stable line numbers):
// - gpt-oss simple_browser_tool.py `find` no-match phrase, line 246:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L246
// - gpt-oss simple_browser_tool.py `BackendError` fetching phrase, lines 444-445:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L444-L445
// - litellm `Search failed: <e>` idiom:
//   https://github.com/BerriAI/litellm/blob/main/litellm/integrations/websearch_interception/transformation.py

import { type MergeState } from './merge-state.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputItem,
  ResponseInputWebSearchCall,
  ResponseOutputWebSearchCall,
  ResponsesStreamEvent,
  ResponseWebSearchAction,
  ResponseWebSearchResult,
} from '@floway-dev/protocols/responses';
import { webSearchCallLifecycleEvents } from '@floway-dev/protocols/responses';

// Sole safety valve — do not introduce additional safety caps in
// this subtree. Past iteration 30 the dispatcher swaps backend
// dispatch for the cap snippet so the model sees the bypass and
// steers itself toward a terminal message.
export const ITERATION_CAP = 30;

export interface WebSearchCallIR {
  id: string;
  status: 'completed';
  action: ResponseWebSearchAction;
  /** Always populated; see file-header divergence note in web-search-shim.ts. */
  results: ResponseWebSearchResult[];
  /**
   * Set when this IR was built from a replayed input item that lacked
   * a `results` field — e.g. codex CLI strips the field before
   * persisting to its session rollout. `irToOutputText` swaps the
   * usual formatted snippet for a one-line notice so the model knows
   * the prior content was not preserved (rather than confusing it
   * with a genuine zero-hit search).
   */
  resultsStripped?: boolean;
}

export const synthesizeWebSearchCallId = (): string =>
  `ws_gw_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const searchFailedText = (providerMessage: string): string =>
  `Search failed: ${providerMessage}`;

export const openFailedText = (url: string, providerMessage: string): string =>
  `Error fetching URL \`${url}\`: ${providerMessage}`;

export const findNoMatchesText = (pattern: string, url: string): string =>
  `No matching \`${pattern}\` found on ${url}.`;

export const iterationCapText
  = `Web search iteration limit (${ITERATION_CAP}) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you've gathered.`;

// Snippet emitted when a backend dispatch would push past the
// client-supplied `max_tool_calls` budget. The same emission path
// as `iterationCapText` (per-op snippet with the model-friendly
// instruction to stop), distinct text so a log scan can tell the
// gateway-imposed iteration cap apart from the client's own budget.
export const budgetExhaustedText
  = 'Web search max_tool_calls budget exhausted. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools or directly answer based on what you\'ve gathered.';

export const truncationSentinel = (fullBytes: number): string =>
  `[Content truncated; full page is ${fullBytes} bytes. Use web_search's \`find\` sub-property with a pattern to locate specific content.]`;

// Walk back to the last whole UTF-16 code-point boundary so a truncation
// inside a surrogate pair (e.g. an emoji at exactly position 511) doesn't
// leave an orphan high surrogate in the body excerpt. UTF-16 high
// surrogates are 0xD800–0xDBFF; if the last retained code unit is a high
// surrogate the matching low surrogate was dropped — strip it. Exported
// for unit tests covering the surrogate / empty / exact-length boundary
// cases.
export const truncatePreservingCodePoints = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let end = max;
  const lastCode = s.charCodeAt(end - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) end -= 1;
  return s.slice(0, end);
};

// Returned as the function_call_output when a replayed `web_search_call`
// item arrived without `results` (the client did not preserve them
// across the round trip). The model still sees the action via the
// paired function_call's arguments, so this only has to communicate
// that re-searching is the way to recover the contents.
export const resultsStrippedText
  = 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.';

// Returned as the function_call_output (and as the snippet of the
// synthesized lifecycle item on the malformed-args path) when an umbrella
// call has no logical ops the shim can attribute — empty args object,
// malformed JSON, or a non-object top-level shape. The hint names the
// supported sub-properties so the model knows what shape to retry with.
export const emptyUmbrellaArgsText
  = 'Error: arguments must be a JSON object with sub-property arrays (search_query[], open[], find[]).';

export const searchIr = (
  id: string,
  query: string,
  results: ResponseWebSearchResult[],
  sources?: { type: 'url'; url: string }[],
): WebSearchCallIR => ({
  id,
  status: 'completed',
  // Emit both `query` and `queries`; see `actionSearchQueries`.
  action: {
    type: 'search',
    query,
    queries: [query],
    // Native gates `sources` on `include:
    // ["web_search_call.action.sources"]`; only include when the
    // client opted in. The producer (dispatch.ts) decides whether to
    // pass the list based on the include token.
    ...(sources !== undefined ? { sources } : {}),
  },
  results,
});

export const openPageIr = (
  id: string,
  url: string | undefined,
  results: ResponseWebSearchResult[],
): WebSearchCallIR => ({
  id,
  status: 'completed',
  // Omit `url` when undefined to match native's soft-failure shape;
  // never emit `url: ''`.
  action: url !== undefined && url.length > 0
    ? { type: 'open_page', url }
    : { type: 'open_page' },
  results,
});

export const findInPageIr = (
  id: string,
  url: string,
  pattern: string,
  results: ResponseWebSearchResult[],
): WebSearchCallIR => ({
  id,
  status: 'completed',
  action: { type: 'find_in_page', url, pattern },
  results,
});

// No native action.type fits shim-only error classes (unknown
// sub-property, malformed args); encode them via action.type:'search'
// with the diagnostic in queries[0] so wire-typed SDKs still parse the
// item.
export const schemaErrorIr = (
  id: string,
  queryLabel: string,
  title: string,
  snippet: string,
): WebSearchCallIR => ({
  id,
  status: 'completed',
  // Emit both `query` and `queries`; see `actionSearchQueries`.
  action: { type: 'search', query: queryLabel, queries: [queryLabel] },
  results: [{
    type: 'text_result',
    url: '',
    title,
    snippet,
  }],
});

// openai-python `ActionSearch.query` is a single string; some clients
// send only `queries[]`. Accept both: the shim emits both fields on
// every search action so typed SDKs reading either one keep working.
const actionSearchQueries = (action: Extract<ResponseWebSearchAction, { type: 'search' }>): string[] => {
  if (action.queries !== undefined) return action.queries;
  if (action.query !== undefined) return [action.query];
  return [];
};

/**
 * Wire input item → IR. Returns null only when `action` is missing —
 * without it we can't even tell upstream what was previously searched.
 * `id` is synthesized when missing (it's an internal ref the model
 * never sees); `results` missing toggles `resultsStripped` so the
 * function_call_output reads as "not preserved" instead of "no hits".
 */
export const inputItemToIr = (item: ResponseInputWebSearchCall): WebSearchCallIR | null => {
  if (item.action === undefined) return null;
  let action: ResponseWebSearchAction;
  if (item.action.type === 'search') {
    const queries = actionSearchQueries(item.action);
    // Emit both `query` and `queries`; see `actionSearchQueries`.
    action = {
      type: 'search',
      ...(queries.length > 0 ? { query: queries[0] } : {}),
      queries,
    };
  } else {
    action = item.action;
  }
  const id = item.id !== undefined && item.id.length > 0
    ? item.id
    : synthesizeWebSearchCallId();
  const hasResults = Array.isArray(item.results);
  return {
    id,
    status: 'completed',
    action,
    results: hasResults ? item.results! : [],
    ...(hasResults ? {} : { resultsStripped: true }),
  };
};

/**
 * IR → umbrella function_call + function_call_output pair sharing a
 * synthetic call_id derived from the IR id. Used when echoing a
 * web_search_call input item back to upstream. The forward
 * (internal-loop) path reuses the upstream's original umbrella call_id
 * and does NOT go through this helper.
 */
export const irToUpstreamPair = (
  ir: WebSearchCallIR,
  umbrellaToolName: string,
): {
  functionCall: ResponseFunctionToolCallItem;
  functionCallOutput: ResponseFunctionCallOutputItem;
} => {
  const callId = `cc_from_${ir.id}`;
  return {
    functionCall: {
      type: 'function_call',
      call_id: callId,
      name: umbrellaToolName,
      arguments: actionToUmbrellaArgsJson(ir.action),
      status: 'completed',
    },
    functionCallOutput: {
      type: 'function_call_output',
      call_id: callId,
      output: irToOutputText(ir),
    },
  };
};

const actionToUmbrellaArgsJson = (action: ResponseWebSearchAction): string => {
  switch (action.type) {
  case 'search':
    return JSON.stringify({
      search_query: actionSearchQueries(action).map(q => ({ q })),
    });
  case 'open_page':
    // Echoed open_page items can arrive without `url` (native drops it
    // on soft failure); fall back to an empty string in the replayed
    // args so the upstream sees a well-formed `ref_id` field rather
    // than a literal `undefined` collapse.
    return JSON.stringify({ open: [{ ref_id: action.url ?? '' }] });
  case 'find_in_page':
    return JSON.stringify({ find: [{ ref_id: action.url, pattern: action.pattern }] });
  }
};

// Numeric `[N]` references in the snippet body let the model cite
// specific search hits in its final answer. Empty results emit
// `(no results)` rather than a bare header so the model recognizes the
// call ran successfully but returned nothing.
const formatSearchResultsText = (query: string, results: readonly ResponseWebSearchResult[]): string => {
  const header = `Search results for "${query}":`;
  if (results.length === 0) return `${header}\n\n(no results)`;
  const sections = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
  return `${header}\n\n${sections.join('\n\n')}`;
};

/**
 * IR rendered as a labeled text section the upstream model reads from
 * function_call_output. Format matches what model variants have seen
 * historically so model behaviour doesn't drift on the rewrite.
 */
export const irToOutputText = (ir: WebSearchCallIR): string => {
  if (ir.resultsStripped) return resultsStrippedText;
  switch (ir.action.type) {
  case 'search': {
    const queryLabel = actionSearchQueries(ir.action).join(' | ');
    return formatSearchResultsText(queryLabel, ir.results);
  }
  case 'open_page': {
    if (ir.results.length === 0) {
      const url = ir.action.url ?? '(no url)';
      return `Open ${url}: (no body returned)`;
    }
    return ir.results[0].snippet;
  }
  case 'find_in_page':
    return ir.results.length > 0 ? ir.results[0].snippet : '';
  }
};

// Echoed items without `action` become placeholder function_call /
// function_call_output pairs with the original wire item inlined so the
// model can inspect them; positional indices stay stable.
export const inputItemsToUpstreamPairs = (
  input: ResponseInputItem[],
  umbrellaToolName: string,
): ResponseInputItem[] => {
  const out: ResponseInputItem[] = [];
  for (const item of input) {
    if (item.type === 'web_search_call') {
      const ir = inputItemToIr(item);
      if (ir === null) {
        const id = synthesizeWebSearchCallId();
        const callId = `cc_from_${id}_malformed`;
        out.push(
          {
            type: 'function_call',
            call_id: callId,
            name: umbrellaToolName,
            arguments: '{}',
            status: 'completed',
          },
          {
            type: 'function_call_output',
            call_id: callId,
            // Include the original wire item verbatim so the model
            // can see what was there — the placeholder shape stays
            // stable while the malformed payload reaches the LLM
            // for inspection.
            output: `A prior web_search_call item in the conversation history was malformed (no \`action\` field). Original wire item: ${JSON.stringify(item)}`,
          },
        );
        continue;
      }
      const { functionCall, functionCallOutput } = irToUpstreamPair(ir, umbrellaToolName);
      out.push(functionCall, functionCallOutput);
      continue;
    }
    out.push(item);
  }
  return out;
};

// Each intercepted umbrella produces a 5-event sequence sharing one
// output_index:
//
//   1. response.output_item.added             { item: web_search_call, status: 'in_progress' }
//   2. response.web_search_call.in_progress   { item_id }
//   3. response.web_search_call.searching     { item_id }
//   4. response.web_search_call.completed     { item_id }
//   5. response.output_item.done              { item: web_search_call, status: 'completed', action, results }
//
// Callers emit events 1-3 BEFORE awaiting the backend and 4-5 AFTER so
// the wire's `searching` state lasts the real backend latency.

interface WebSearchCallLifecycleStartArgs {
  synthesizedId: string;
  /**
   * When supplied, the start frames carry this downstream output_index
   * instead of allocating a fresh one. Used for the umbrella's first IR
   * slot so it lands at the slot reserved at function_call.added.
   */
  reservedOutputIndex?: number;
}

interface WebSearchCallLifecycleEndArgs {
  synthesizedId: string;
  outputIndex: number;
  action: ResponseWebSearchAction;
  results: ResponseWebSearchResult[];
}

export const emitWebSearchCallLifecycleStart = (
  state: MergeState,
  args: WebSearchCallLifecycleStartArgs,
): { outputIndex: number; frames: ProtocolFrame<ResponsesStreamEvent>[] } => {
  const outputIndex = args.reservedOutputIndex ?? state.outputIndex++;

  // Start-half item carries `status: 'in_progress'`, no `action`
  // (mirrors native — action is known here but kept off the wire to
  // match the upstream contract), and no `results` (the backend
  // hasn't resolved yet).
  const inFlightItem: ResponseOutputWebSearchCall = {
    type: 'web_search_call',
    id: args.synthesizedId,
    status: 'in_progress',
  };
  const { startFrames } = webSearchCallLifecycleEvents(inFlightItem, outputIndex);

  return {
    outputIndex,
    frames: startFrames.map(event =>
      eventFrame<ResponsesStreamEvent>({ ...event, sequence_number: state.sequenceNumber++ } as ResponsesStreamEvent)),
  };
};

export const emitWebSearchCallLifecycleEnd = (
  state: MergeState,
  args: WebSearchCallLifecycleEndArgs,
): ProtocolFrame<ResponsesStreamEvent>[] => {
  const completedItem: ResponseOutputWebSearchCall = {
    type: 'web_search_call',
    id: args.synthesizedId,
    status: 'completed',
    action: args.action,
    results: args.results,
  };
  const { endFrames } = webSearchCallLifecycleEvents(completedItem, args.outputIndex);

  const frames = endFrames.map(event =>
    eventFrame<ResponsesStreamEvent>({ ...event, sequence_number: state.sequenceNumber++ } as ResponsesStreamEvent));

  state.accumulatedOutput.set(args.outputIndex, completedItem);
  return frames;
};
