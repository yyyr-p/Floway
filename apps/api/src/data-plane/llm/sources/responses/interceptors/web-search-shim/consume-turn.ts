import { type MergeState, type MergeUsage, usageOf } from './merge-state.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponsesStreamEvent,
  ResponseStreamEvent,
} from '@floway-dev/protocols/responses';

export interface InterceptedFunctionCall {
  /**
   * Arguments string for the umbrella function_call. Accumulated from
   * upstream as the raw wire string (`.done` is canonical over deltas
   * to avoid drift on chunk-boundary merges). Consumed once by the
   * dispatcher to plan logical operations via
   * `parseUmbrellaOperations`; never re-read for the next-turn echo,
   * which builds args from the resolved IR via `irToUpstreamPair`
   * — the same renderer the client-roundtrip path uses.
   */
  argumentsJson: string;
  /**
   * Downstream output_index reserved at output_item.added time so the
   * umbrella keeps its place in wire ordering when other items arrive
   * between added and done. Truncated streams (no function_call.done)
   * orphan this index, but those end in a synthesized response.failed
   * where contiguity doesn't matter.
   */
  reservedDownstreamIndex: number;
}

interface UmbrellaDispatch<TIR> {
  intercepted: InterceptedFunctionCall;
  slots: UmbrellaSlot<TIR>[];
}

export interface UmbrellaSlot<TIR> {
  synthesizedId: string;
  outputIndex: number;
  irPromise: Promise<TIR>;
}

/**
 * Fires synchronously at function_call.done so backend promises kick off
 * before the next event-loop yield.
 */
type UmbrellaDispatcher<TIR> = (
  intercepted: InterceptedFunctionCall,
) => {
  slots: UmbrellaSlot<TIR>[];
  startFrames: ProtocolFrame<ResponsesStreamEvent>[];
};

export type TerminalStatus =
  | { kind: 'completed' }
  | { kind: 'failed'; response: ResponsesResult }
  | { kind: 'incomplete'; response: ResponsesResult }
  // Upstream's stream ended without ever producing a `response.created`
  // envelope — either a bare `{type:'error'}` arrived first, or the
  // stream truncated before any frame. There is no captured identity
  // (id / model), so we cannot fabricate a wire-valid `ResponsesResult`.
  // The shim surfaces this by short-circuiting to a non-events
  // `upstream-error` result instead of yielding a `response.failed`
  // frame with empty-string identity (which would violate the wire
  // contract — id and model are required, not nullable).
  | { kind: 'bare-error-pre-shell'; error: { message: string; code: string } };

export interface TurnSummary<TIR> {
  dispatched: UmbrellaDispatch<TIR>[];
  sawClientToolCall: boolean;
  turnUsage: Partial<MergeUsage>;
  terminalStatus: TerminalStatus;
}

const syntheticInProgressResponse = (state: MergeState, id: string, model: string): ResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error(
      'Web-search shim cannot synthesize a Responses in-progress envelope: upstream `response.created` was never captured. This should be unreachable.',
    );
  }
  return {
    ...state.upstreamResponseSnapshot,
    id,
    object: 'response',
    model,
    output: [],
    status: 'in_progress',
    error: null,
    incomplete_details: null,
  };
};

const FORWARD_REWRITE_TYPES = new Set<string>([
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
]);

const ITEM_ID_REWRITE_TYPES = new Set<string>([
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
]);

const rewriteOutputIndex = (
  event: ResponseStreamEvent,
  openItems: Map<number, number>,
  openItemIds: Map<number, string>,
): { event: ResponseStreamEvent } | { drop: true } | null => {
  if (!FORWARD_REWRITE_TYPES.has(event.type)) return null;
  const e = event as ResponseStreamEvent & { output_index: number; item_id?: string };
  const downstreamIndex = openItems.get(e.output_index);
  if (downstreamIndex === undefined) return { drop: true };
  if (ITEM_ID_REWRITE_TYPES.has(event.type)) {
    const downstreamItemId = openItemIds.get(e.output_index);
    return {
      event: {
        ...e,
        output_index: downstreamIndex,
        ...(downstreamItemId !== undefined ? { item_id: downstreamItemId } : {}),
      } as ResponseStreamEvent,
    };
  }
  return { event: { ...e, output_index: downstreamIndex } as ResponseStreamEvent };
};

const captureTerminalEvent = (
  event: ResponseStreamEvent,
  merge: MergeState,
): { status: TerminalStatus; usage: Partial<MergeUsage> } | null => {
  if (event.type === 'response.completed') {
    // Refresh the snapshot — terminal-only fields (`usage`,
    // `completed_at`, …) now appear, and terminal-shared fields
    // (`tools`, `temperature`, …) supersede earlier captures.
    merge.upstreamResponseSnapshot = event.response;
    return { status: { kind: 'completed' }, usage: usageOf(event.response.usage) };
  }
  if (event.type === 'response.failed') {
    merge.upstreamResponseSnapshot = event.response;
    return { status: { kind: 'failed', response: event.response }, usage: usageOf(event.response.usage) };
  }
  if (event.type === 'response.incomplete') {
    merge.upstreamResponseSnapshot = event.response;
    return { status: { kind: 'incomplete', response: event.response }, usage: usageOf(event.response.usage) };
  }
  return null;
};

export const consumeTurnStreaming = async function* <TIR>(
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  merge: MergeState,
  isFirstTurn: boolean,
  shimToolName: string,
  dispatchUmbrella: UmbrellaDispatcher<TIR>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary<TIR>> {
  const dispatched: UmbrellaDispatch<TIR>[] = [];
  let sawClientToolCall = false;
  let turnUsage: Partial<MergeUsage> = {};
  // Missing terminal (truncated stream / transport drop) is surfaced
  // as a synthesized failure at end-of-stream rather than swallowed
  // as an empty-success turn.
  let terminalStatus: TerminalStatus | undefined = undefined;

  // Upstream output_index resets per run, so the mapping is turn-local.
  const openItems = new Map<number, number>();
  const openItemIds = new Map<number, string>();

  const interceptedByUpstreamIndex = new Map<number, InterceptedFunctionCall>();

  const ensureModel = (): string => {
    if (merge.lastSeenModel === null) {
      throw new Error(
        'Web-search shim cannot synthesize a Responses envelope: upstream `response.created` did not report a `model` field. Refusing to fall back to the requested model — clients depend on the served identity.',
      );
    }
    return merge.lastSeenModel;
  };

  const stamp = (event: ResponseStreamEvent): ProtocolFrame<ResponsesStreamEvent> =>
    eventFrame<ResponsesStreamEvent>({
      ...event,
      sequence_number: merge.sequenceNumber++,
    } as ResponsesStreamEvent);

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.created') {
      const created = event.response;
      const reportedModel = created.model;
      if (typeof reportedModel === 'string' && reportedModel.length > 0) {
        merge.lastSeenModel = reportedModel;
      }
      merge.upstreamResponseSnapshot = created;
      // Model is required for synthesis; throw immediately so the
      // upstream protocol violation surfaces at the offending turn
      // rather than at a later synthesis call.
      ensureModel();
      if (isFirstTurn) {
        yield stamp({
          type: 'response.created',
          response: syntheticInProgressResponse(merge, merge.synthesizedResponseId, ensureModel()),
        });
      }
      continue;
    }

    if (event.type === 'response.in_progress') {
      if (isFirstTurn) {
        yield stamp({
          type: 'response.in_progress',
          response: syntheticInProgressResponse(merge, merge.synthesizedResponseId, ensureModel()),
        });
      }
      continue;
    }

    // Bare error frame. Identity-captured → response.failed;
    // identity-missing → bare-error-pre-shell.
    if (event.type === 'error') {
      const e = event as Extract<ResponseStreamEvent, { type: 'error' }>;
      // `??` alone would let `code: ''` survive to the wire, where typed
      // SDKs reject empty-string the same way as any non-enum value.
      const code = (typeof e.code === 'string' && e.code.length > 0) ? e.code : 'server_error';
      if (merge.lastSeenModel === null) {
        terminalStatus = { kind: 'bare-error-pre-shell', error: { message: e.message, code } };
      } else {
        const failedResponse: ResponsesResult = {
          id: merge.synthesizedResponseId,
          object: 'response',
          model: ensureModel(),
          output: [],
          status: 'failed',
          error: {
            message: e.message,
            code,
          },
          incomplete_details: null,
        };
        terminalStatus = { kind: 'failed', response: failedResponse };
      }
      turnUsage = {};
      continue;
    }

    const terminal = captureTerminalEvent(event, merge);
    if (terminal !== null) {
      terminalStatus = terminal.status;
      turnUsage = terminal.usage;
      continue;
    }

    if (event.type === 'response.output_item.added') {
      const upstreamIndex = event.output_index;
      const item = event.item;

      if (item.type === 'function_call' && item.name === shimToolName) {
        interceptedByUpstreamIndex.set(upstreamIndex, {
          argumentsJson: '',
          reservedDownstreamIndex: merge.outputIndex++,
        });
        continue;
      }

      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        sawClientToolCall = true;
      }

      const downstreamIndex = merge.outputIndex++;
      openItems.set(upstreamIndex, downstreamIndex);
      // Preserve upstream's item id when present so child events
      // (`output_text.delta`, `content_part.added`, …) keep referring
      // to the same id upstream emitted. openai-dotnet fixtures attach
      // an id to message items, and reasoning / web_search_call /
      // custom_tool_call items declare `id` in the protocol type. Only
      // when upstream omits the id do we synthesize one — and only for
      // `message` items, because the other types either always carry
      // one or have no child events.
      const upstreamItemId = (item as { id?: unknown }).id;
      const itemId = typeof upstreamItemId === 'string' && upstreamItemId.length > 0
        ? upstreamItemId
        : item.type === 'message'
          ? `msg_${downstreamIndex}`
          : undefined;
      if (itemId !== undefined) {
        openItemIds.set(upstreamIndex, itemId);
      }
      yield stamp({
        type: 'response.output_item.added',
        output_index: downstreamIndex,
        // Attach the synthesized id to the forwarded item so
        // `output_item.added.item.id` matches child events' `item_id`.
        item: itemId !== undefined && upstreamItemId !== itemId
          ? { ...item, id: itemId } as ResponseOutputItem
          : item,
      });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const upstreamIndex = event.output_index;
      const item = event.item;

      const intercepted = interceptedByUpstreamIndex.get(upstreamIndex);
      if (intercepted !== undefined) {
        if (item.type === 'function_call') {
          intercepted.argumentsJson = item.arguments;
        }
        // Dispatch here so the umbrella's reserved slot lands at the
        // source position the model emitted it in.
        const { slots, startFrames } = dispatchUmbrella(intercepted);
        dispatched.push({ intercepted, slots });
        yield* startFrames;
        continue;
      }

      const downstreamIndex = openItems.get(upstreamIndex);
      if (downstreamIndex === undefined) continue;
      // Mirror the id rewrite from `output_item.added` so
      // `added.item.id` / `done.item.id` / every child event's
      // `item_id` all agree.
      const itemId = openItemIds.get(upstreamIndex);
      const upstreamDoneItemId = (item as { id?: unknown }).id;
      const doneItem: ResponseOutputItem = itemId !== undefined && upstreamDoneItemId !== itemId
        ? { ...item, id: itemId } as ResponseOutputItem
        : item;
      yield stamp({
        type: 'response.output_item.done',
        output_index: downstreamIndex,
        item: doneItem,
      });
      merge.accumulatedOutput.set(downstreamIndex, doneItem);
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.argumentsJson += event.delta;
        continue;
      }
      const downstreamIndex = openItems.get(event.output_index);
      if (downstreamIndex === undefined) continue;
      yield stamp({ ...event, output_index: downstreamIndex });
      continue;
    }

    if (event.type === 'response.function_call_arguments.done') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index);
      if (intercepted !== undefined) {
        intercepted.argumentsJson = event.arguments;
        continue;
      }
      const downstreamIndex = openItems.get(event.output_index);
      if (downstreamIndex === undefined) continue;
      yield stamp({ ...event, output_index: downstreamIndex });
      continue;
    }

    const rewriteResult = rewriteOutputIndex(event, openItems, openItemIds);
    if (rewriteResult !== null) {
      if ('event' in rewriteResult) yield stamp(rewriteResult.event);
      continue;
    }

    // Unknown indexed events forward through with rewritten
    // output_index so future server-tool lifecycle variants don't need
    // shim updates.
    const maybeIndexed = event as ResponseStreamEvent & {
      output_index?: number;
      item?: unknown;
    };
    if (typeof maybeIndexed.output_index === 'number') {
      const upstreamIndex = maybeIndexed.output_index;
      let downstreamIndex = openItems.get(upstreamIndex);
      if (downstreamIndex === undefined) {
        downstreamIndex = merge.outputIndex++;
        openItems.set(upstreamIndex, downstreamIndex);
      }
      yield stamp({ ...event, output_index: downstreamIndex } as ResponseStreamEvent);
      if (maybeIndexed.item !== undefined) {
        if (event.type.endsWith('.added') || event.type.endsWith('.done')) {
          merge.accumulatedOutput.set(
            downstreamIndex,
            maybeIndexed.item as Parameters<MergeState['accumulatedOutput']['set']>[1],
          );
        }
      }
      continue;
    }
  }

  if (terminalStatus === undefined) {
    // Truncated stream: synthesize a wire-valid `response.failed`
    // when identity is captured, otherwise surface
    // `bare-error-pre-shell`.
    if (merge.lastSeenModel === null) {
      terminalStatus = {
        kind: 'bare-error-pre-shell',
        error: {
          message: 'Upstream stream ended without a terminal event (no response.created observed)',
          code: 'server_error',
        },
      };
    } else {
      const failedResponse: ResponsesResult = {
        id: merge.synthesizedResponseId,
        object: 'response',
        model: ensureModel(),
        output: [],
        status: 'failed',
        error: {
          message: 'Upstream stream ended without a terminal event.',
          code: 'server_error',
        },
        // Spec-required nullable.
        incomplete_details: null,
      };
      terminalStatus = { kind: 'failed', response: failedResponse };
    }
  }

  // Detect umbrella reservations that never got their matching
  // `output_item.done`. Without this check the reserved slot is
  // silently discarded — the umbrella never dispatches, no IRs flow
  // to the next turn, and the loop emits success on a turn with
  // unfinished tool intent. Promote to `response.failed` instead.
  // Identity is guaranteed captured here (reservations only happen
  // after `response.created` already fired).
  if (interceptedByUpstreamIndex.size > dispatched.length) {
    const dispatchedSet = new Set(dispatched.map(d => d.intercepted));
    const unmatched = [...interceptedByUpstreamIndex.entries()]
      .filter(([, intercepted]) => !dispatchedSet.has(intercepted))
      .map(([idx]) => idx);
    const failedResponse: ResponsesResult = {
      id: merge.synthesizedResponseId,
      object: 'response',
      model: ensureModel(),
      output: [],
      status: 'failed',
      error: {
        message: `Upstream emitted ${TERMINAL_KIND_LABEL[terminalStatus.kind]} without closing umbrella function_call items at upstream output_index ${unmatched.join(', ')}.`,
        code: 'server_error',
      },
      incomplete_details: null,
    };
    terminalStatus = { kind: 'failed', response: failedResponse };
  }

  return {
    dispatched,
    sawClientToolCall,
    turnUsage,
    terminalStatus,
  };
};

const TERMINAL_KIND_LABEL: Record<TerminalStatus['kind'], string> = {
  completed: 'response.completed',
  failed: 'response.failed',
  incomplete: 'response.incomplete',
  'bare-error-pre-shell': 'a pre-shell bare error',
};
