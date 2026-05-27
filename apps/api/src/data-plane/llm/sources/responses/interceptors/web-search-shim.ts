// Responses web-search shim — intercepts a client's hosted `web_search`
// tool when the planned upstream target cannot carry it (Messages, Chat
// Completions, or operator-flagged Responses bypass), rewrites the tool
// into one umbrella function tool, executes search/open/find actions
// against a configured backend, and re-emits the results as the public
// `web_search_call` lifecycle the client expects.
//
// Divergences from native are catalogued in AGENTS.md.

import {
  consumeTurnStreaming,
} from './web-search-shim/consume-turn.ts';
import { createUmbrellaDispatcher, type ShimState } from './web-search-shim/dispatch.ts';
import {
  inputItemsToUpstreamPairs,
  type WebSearchCallIR,
} from './web-search-shim/ir.ts';
import { createMergeState } from './web-search-shim/merge-state.ts';
import {
  invalidRequestEnvelope,
  type LatestMetadata,
  runMultiTurnLoop,
} from './web-search-shim/multi-turn-loop.ts';
import { isHostedWebSearchTool, prepareToolsForShim } from './web-search-shim/tool-rewrite.ts';
import {
  resolveConfiguredWebSearchProvider,
} from '../../../../tools/web-search/provider.ts';
import { loadSearchConfig } from '../../../../tools/web-search/search-config.ts';
import type {
  ConfiguredWebSearchProvider,
} from '../../../../tools/web-search/types.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';
import { type EventResult, type EventResultMetadata } from '../../../shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  ResponsesStreamEvent,
} from '@floway-dev/protocols/responses';

// Memoized per-request so the first dispatch pays the load+resolve cost.
const memoizedProviderResolver = (): () => Promise<ConfiguredWebSearchProvider> => {
  let cached: Promise<ConfiguredWebSearchProvider> | undefined;
  return () => {
    cached ??= loadSearchConfig().then(cfg => resolveConfiguredWebSearchProvider(cfg));
    return cached;
  };
};

export const withResponsesWebSearchShim: ResponsesInterceptor = async (ctx, request, run) => {
  // Non-responses targets can't carry hosted web_search — the shim
  // is mandatory there. For responses targets the flag is an
  // operator override to bypass the upstream's native implementation.
  if (
    ctx.targetApi === 'responses'
    && !ctx.enabledFlags.has('responses-web-search-shim')
  ) {
    return await run();
  }

  const tools = Array.isArray(ctx.payload.tools) ? ctx.payload.tools : [];
  const hasHostedWebSearch = tools.some(isHostedWebSearchTool);
  const inputArray = Array.isArray(ctx.payload.input) ? ctx.payload.input : undefined;
  const inputArrayWithReplay = inputArray?.some(i => i.type === 'web_search_call') === true
    ? inputArray
    : undefined;

  // The reverse path must run even on turns without a hosted
  // web_search tool — upstream doesn't recognize echoed
  // web_search_call input items otherwise.
  if (!hasHostedWebSearch && inputArrayWithReplay === undefined) return await run();

  // Combined validation + rewrite: walks hosted entries once, then
  // injects the umbrella in-place. Validation errors map directly
  // to the 400 envelope shape so the source responder packages
  // them as Responses-shaped HTTP errors.
  const prepared = prepareToolsForShim(tools, ctx.payload.tool_choice);
  if (!prepared.ok) return invalidRequestEnvelope(prepared.error.message, prepared.error.param);
  const rewritten = prepared.prepared;

  ctx.payload = {
    ...ctx.payload,
    tools: rewritten.tools,
    ...(rewritten.toolChoice !== undefined ? { tool_choice: rewritten.toolChoice } : {}),
  };

  const shimToolName = rewritten.shimToolName;

  if (inputArrayWithReplay !== undefined) {
    ctx.payload = { ...ctx.payload, input: inputItemsToUpstreamPairs(inputArrayWithReplay, shimToolName) };
  }

  if (!hasHostedWebSearch) return await run();

  // A forced choice on EVERY turn would prevent the model from ever
  // producing a terminal message. Demote to `'auto'` after turn 1.
  const turn1ChoiceForcesTool
    = rewritten.toolChoice === 'required'
      || (typeof rewritten.toolChoice === 'object'
        && rewritten.toolChoice !== null
        && rewritten.toolChoice.type === 'function');

  const merge = createMergeState();
  const includeArray = Array.isArray(ctx.payload.include) ? ctx.payload.include : [];
  const state: ShimState = {
    filters: rewritten.filters,
    pageCache: new Map(),
    iterationCount: 0,
    getProvider: memoizedProviderResolver(),
    apiKeyId: request.apiKeyId,
    includeSearchActionSources: includeArray.includes('web_search_call.action.sources'),
    remainingToolCalls: typeof ctx.payload.max_tool_calls === 'number' ? ctx.payload.max_tool_calls : undefined,
    ...(request.downstreamAbortSignal !== undefined ? { downstreamAbortSignal: request.downstreamAbortSignal } : {}),
  };

  // Eager first run so the outer EventResult envelope's modelIdentity,
  // performance, and finalMetadata come from a real upstream call.
  state.iterationCount += 1;
  const firstResultRaw = await run();
  if (firstResultRaw.type !== 'events') return firstResultRaw;
  const firstResult: EventResult<ProtocolFrame<ResponsesStreamEvent>> = firstResultRaw;

  // Turn 1 streams live through `consumeTurnStreaming` end-to-end.
  // Identity capture and synthesized `response.created` emission both
  // happen inline when the iterator first sees upstream's
  // `response.created`; downstream consumers pull frames lazily and
  // never block on a separate pre-buffering phase.
  const turn1Iter = consumeTurnStreaming<WebSearchCallIR>(
    firstResult.events,
    merge,
    true,
    shimToolName,
    createUmbrellaDispatcher(state, merge),
  );

  let resolveFinalMetadata!: (m: EventResultMetadata) => void;
  const shimFinalMetadata = new Promise<EventResultMetadata>(resolve => {
    resolveFinalMetadata = resolve;
  });
  const metadata: LatestMetadata = {
    modelIdentity: firstResult.modelIdentity,
    performance: firstResult.performance,
  };

  return {
    ...firstResult,
    events: runMultiTurnLoop({
      ctx,
      run,
      merge,
      state,
      shimToolName,
      turn1ChoiceForcesTool,
      turn1Iter,
      metadata,
      resolveFinalMetadata,
    }),
    finalMetadata: shimFinalMetadata,
  };
};
