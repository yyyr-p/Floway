// Outer multi-turn loop for the Responses web-search shim. Turn 1's
// iterator runs to completion through `yield*` (consuming the upstream
// frames `consumeTurnStreaming` returns); identity capture happens
// inline inside that iterator when it processes the first upstream
// `response.created`. Subsequent turns drain the same way through
// `yield* consumeTurnStreaming(...)` inside the loop body.

import {
  consumeTurnStreaming,
  type TurnSummary,
  type UmbrellaSlot,
} from './consume-turn.ts';
import { createUmbrellaDispatcher, type ShimState } from './dispatch.ts';
import {
  emitWebSearchCallLifecycleEnd,
  irToUpstreamPair,
  truncatePreservingCodePoints,
  type WebSearchCallIR,
} from './ir.ts';
import {
  materializeAccumulatedOutput,
  type MergeState,
  rebuildOutputText,
  sumUsage,
  usageForWire,
} from './merge-state.ts';
import type { ResponsesInterceptor } from '../../../../interceptors.ts';
import type { EventResultMetadata, ExecuteResult } from '../../../../shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type {
  ResponseInputItem,
  ResponsesResult,
  ResponsesStreamEvent,
} from '@floway-dev/protocols/responses';

// Mutable carrier the outer loop advances per turn and seals into
// `shimFinalMetadata` on every exit path. The box pattern keeps the
// metadata closure-free so `runMultiTurnLoop` stays a top-level
// generator.
export interface LatestMetadata {
  modelIdentity: EventResultMetadata['modelIdentity'];
  performance: EventResultMetadata['performance'];
}

const MAX_BODY_EXCERPT_CHARS = 512;

// Map a non-events `ExecuteResult` (upstream HTTP failure or
// internal-error envelope) to a `ResponseError` payload. Upstream's
// own `error.code` / `type` / `message` flow through verbatim when
// the body is OpenAI-shaped; otherwise we surface the status + body
// excerpt as a free-text message without inventing a code (the
// downstream wire carries whatever upstream said).
export const buildErrorFromResult = (
  result: Exclude<ExecuteResult<unknown>, { type: 'events' }>,
): NonNullable<ResponsesResult['error']> => {
  if (result.type === 'internal-error') {
    // Gateway-side fault — `server_error` is the spec-defined enum
    // value clients pattern-match for "couldn't fulfill".
    return {
      message: result.error.message,
      code: 'server_error',
    };
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(result.body);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    parsed = undefined;
  }
  const err = (typeof parsed === 'object' && parsed !== null)
    ? (parsed as { error?: unknown }).error
    : undefined;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    // Pass upstream's `code` / `type` / `message` through verbatim —
    // the shim is a pass-through here, not a spec normalizer.
    const out: NonNullable<ResponsesResult['error']> = {
      message: typeof e.message === 'string' ? e.message : `Upstream returned HTTP ${result.status}`,
      code: typeof e.code === 'string' ? e.code : `upstream_${result.status}`,
    };
    if (typeof e.type === 'string') {
      (out as Record<string, unknown>).type = e.type;
    }
    return out;
  }
  // Non-OpenAI body: synthesize a minimal envelope using the status
  // as the code and the body excerpt as the message. Still no
  // normalization — `upstream_<status>` keeps the upstream origin
  // visible to clients pattern-matching on it.
  const truncated = truncatePreservingCodePoints(decoded, MAX_BODY_EXCERPT_CHARS);
  const excerpt = truncated.length === decoded.length ? decoded : `${truncated}…`;
  return {
    message: excerpt.length > 0
      ? `Upstream returned HTTP ${result.status}: ${excerpt}`
      : `Upstream returned HTTP ${result.status}`,
    code: `upstream_${result.status}`,
  };
};

// OpenAI-shaped 400 error envelope used by the filter-validation
// rejects. Status 400 + `type: 'invalid_request_error'` is the standard
// channel typed-SDK retry / display logic branches on. `param`
// identifies the offending JSON-Pointer-style location inside the
// request tools array (e.g. `tools[].filters` or
// `tools[].filters.allowed_domains`).
export const invalidRequestEnvelope = (
  message: string,
  param: string,
): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => {
  const body = JSON.stringify({
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code: 'invalid_request_error',
    },
  });
  return {
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(body),
  };
};

export const overlayOnSnapshot = (
  state: MergeState,
  overlay: Partial<ResponsesResult> & Pick<ResponsesResult, 'id' | 'object' | 'model' | 'status' | 'output'>,
): ResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    // Every caller reaches here only after at least one
    // `response.created` capture; a missing snapshot is a real bug,
    // not a graceful-fallback case.
    throw new Error('Web-search shim cannot overlay on an undefined upstream snapshot. This should be unreachable.');
  }
  return {
    ...state.upstreamResponseSnapshot,
    ...overlay,
  };
};

export type TerminalKind =
  | { kind: 'completed' }
  | { kind: 'failed'; error: ResponsesResult['error'] }
  | { kind: 'incomplete'; incompleteDetails: ResponsesResult['incomplete_details'] };

const TERMINAL_FRAME_TYPE: Record<TerminalKind['kind'], 'response.completed' | 'response.failed' | 'response.incomplete'> = {
  completed: 'response.completed',
  failed: 'response.failed',
  incomplete: 'response.incomplete',
};

const TERMINAL_FRAME_STATUS: Record<TerminalKind['kind'], ResponsesResult['status']> = {
  completed: 'completed',
  failed: 'failed',
  incomplete: 'incomplete',
};

export const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: TerminalKind,
): ProtocolFrame<ResponsesStreamEvent> => {
  if (state.lastSeenModel === null) {
    throw new Error(
      'Web-search shim cannot synthesize a Responses terminal envelope: upstream `response.created` never reported a `model`.',
    );
  }
  const id = state.synthesizedResponseId;
  const model = state.lastSeenModel;
  const usage = usageForWire(state);
  const output = materializeAccumulatedOutput(state);
  const output_text = rebuildOutputText(output);
  const failedExtras = kind.kind === 'failed' ? { error: kind.error } : {};
  const incompleteExtras = kind.kind === 'incomplete'
    ? { incomplete_details: kind.incompleteDetails }
    : {};
  return eventFrame<ResponsesStreamEvent>({
    type: TERMINAL_FRAME_TYPE[kind.kind],
    sequence_number: state.sequenceNumber++,
    response: overlayOnSnapshot(state, {
      id,
      object: 'response',
      model,
      status: TERMINAL_FRAME_STATUS[kind.kind],
      output,
      output_text,
      ...(usage !== undefined ? { usage } : {}),
      ...failedExtras,
      ...incompleteExtras,
    }),
  });
};

// Copy upstream's terminal envelope verbatim, substituting only `id`.
export const passthroughUpstreamTerminal = (
  state: MergeState,
  upstream: ResponsesResult,
  type: 'response.failed' | 'response.incomplete',
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type,
    sequence_number: state.sequenceNumber++,
    response: { ...upstream, id: state.synthesizedResponseId },
  });

export interface MultiTurnLoopArgs {
  ctx: Parameters<ResponsesInterceptor>[0];
  run: Parameters<ResponsesInterceptor>[2];
  merge: MergeState;
  state: ShimState;
  shimToolName: string;
  turn1ChoiceForcesTool: boolean;
  turn1Iter: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary<WebSearchCallIR>>;
  metadata: LatestMetadata;
  resolveFinalMetadata: (m: EventResultMetadata) => void;
}

// Await each umbrella's IR promises in order and yield the
// corresponding `web_search_call.completed` lifecycle ends inline.
// Strict serial across umbrellas: umbrella N's lifecycle ends emit
// before umbrella N+1's await begins. Slots within a single umbrella
// still resolve through one batched provider call (intra-umbrella
// batching is preserved by `startBatchFetchForUmbrella`).
async function* dispatchTurnResults(
  dispatched: ReadonlyArray<{ slots: UmbrellaSlot<WebSearchCallIR>[] }>,
  merge: MergeState,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, WebSearchCallIR[][]> {
  const irResults: WebSearchCallIR[][] = [];
  for (const d of dispatched) {
    const slotResults: WebSearchCallIR[] = [];
    for (const slot of d.slots) {
      const ir = await slot.irPromise;
      slotResults.push(ir);
      yield* emitWebSearchCallLifecycleEnd(merge, {
        synthesizedId: slot.synthesizedId,
        outputIndex: slot.outputIndex,
        action: ir.action,
        results: ir.results,
      });
    }
    irResults.push(slotResults);
  }
  return irResults;
}

export async function* runMultiTurnLoop({
  ctx,
  run,
  merge,
  state,
  shimToolName,
  turn1ChoiceForcesTool,
  turn1Iter,
  metadata,
  resolveFinalMetadata,
}: MultiTurnLoopArgs): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  let midStreamError: unknown = undefined;
  try {
    let currentTurn: TurnSummary<WebSearchCallIR> = yield* turn1Iter;
    merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    while (true) {
      const turn = currentTurn;
      const executedShim = turn.dispatched.length > 0;

      if (turn.terminalStatus.kind === 'failed') {
        if (executedShim) yield* dispatchTurnResults(turn.dispatched, merge);
        // Upstream-originated terminal: pass through verbatim with
        // only `id` substituted. Upstream's `error.code` / `type` /
        // `message`, `output`, `usage`, `completed_at`, etc. all
        // flow to the wire unchanged.
        yield passthroughUpstreamTerminal(merge, turn.terminalStatus.response, 'response.failed');
        return;
      }

      // Forward upstream's response.incomplete as-is — clients branch
      // on `incomplete_details.reason`. Pass through whatever
      // `incomplete_details` upstream emitted, including null /
      // missing values, instead of inventing a synthetic shape.
      if (turn.terminalStatus.kind === 'incomplete') {
        if (executedShim) yield* dispatchTurnResults(turn.dispatched, merge);
        yield passthroughUpstreamTerminal(merge, turn.terminalStatus.response, 'response.incomplete');
        return;
      }

      // bare-error-pre-shell case; see TerminalStatus union in consume-turn.ts.
      if (turn.terminalStatus.kind === 'bare-error-pre-shell') {
        yield synthesizeTerminalEnvelope(merge, {
          kind: 'failed',
          error: {
            code: turn.terminalStatus.error.code,
            message: turn.terminalStatus.error.message,
          },
        });
        return;
      }

      if (!executedShim && !turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' });
        return;
      }

      const irResults = yield* dispatchTurnResults(turn.dispatched, merge);

      // Exit on a mixed turn — the client will round-trip its own
      // tool's output, and synthesized web_search_call items persist
      // visibly into the next request on the native Responses surface.
      if (turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' });
        return;
      }

      const existingInput: ResponseInputItem[] = Array.isArray(ctx.payload.input)
        ? ctx.payload.input
        : [{ type: 'message', role: 'user', content: ctx.payload.input }];
      // Replay pairs as conversation history so upstream continues the
      // trajectory. Both in-session dispatch and client-roundtrip echoes
      // (`inputItemsToUpstreamPairs`) feed through the same
      // `irToUpstreamPair` renderer — N IRs become N function_call /
      // function_call_output pairs with synthesized `cc_from_<ir.id>`
      // call_ids — so upstream sees exactly one pair shape regardless of
      // whether the IRs came from in-session dispatch or from a client
      // that round-tripped the synthesized `web_search_call` items.
      const replayPairs: ResponseInputItem[] = [];
      for (const ir of irResults.flat()) {
        const { functionCall, functionCallOutput } = irToUpstreamPair(ir, shimToolName);
        replayPairs.push(functionCall, functionCallOutput);
      }
      // Forward remaining budget so upstreams that honor
      // `max_tool_calls` enforce alongside the shim's bypass gate. Drop
      // the field entirely on unlimited requests rather than pinning 0.
      const nextPayload: typeof ctx.payload = { ...ctx.payload, input: [...existingInput, ...replayPairs] };
      if (state.remainingToolCalls !== undefined) {
        nextPayload.max_tool_calls = Math.max(0, state.remainingToolCalls);
      } else {
        delete nextPayload.max_tool_calls;
      }
      ctx.payload = nextPayload;

      if (turn1ChoiceForcesTool && state.iterationCount === 1) {
        ctx.payload = { ...ctx.payload, tool_choice: 'auto' };
      }

      state.iterationCount += 1;
      const nextResult = await run();
      if (nextResult.type !== 'events') {
        // Outer envelope locked to events shape mid-stream —
        // synthesize a terminal `response.failed` to close cleanly.
        yield synthesizeTerminalEnvelope(merge, {
          kind: 'failed',
          error: buildErrorFromResult(nextResult),
        });
        return;
      }
      metadata.modelIdentity = nextResult.modelIdentity;
      metadata.performance = nextResult.performance;
      currentTurn = yield* consumeTurnStreaming<WebSearchCallIR>(
        nextResult.events,
        merge,
        false,
        shimToolName,
        createUmbrellaDispatcher(state, merge),
      );
      merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage);
    }
  } catch (err) {
    midStreamError = err;
  } finally {
    // Close turn 1's iterator on every exit path that didn't naturally
    // drain it (downstream cancel, mid-stream throw). Without an
    // explicit `.return()` the upstream SSE reader can keep buffering
    // past the point we've stopped consuming. Turns 2+ are drained
    // inline by `yield*` which closes their iter on natural completion.
    await turn1Iter.return?.(undefined as never).catch(() => undefined);
    resolveFinalMetadata({
      modelIdentity: metadata.modelIdentity,
      ...(metadata.performance !== undefined ? { performance: metadata.performance } : {}),
    });
  }
  if (midStreamError !== undefined) {
    const message = midStreamError instanceof Error ? midStreamError.message : String(midStreamError);
    yield synthesizeTerminalEnvelope(merge, {
      kind: 'failed',
      error: {
        message: `Upstream stream failed mid-response: ${message}`,
        code: 'server_error',
      },
    });
  }
}
