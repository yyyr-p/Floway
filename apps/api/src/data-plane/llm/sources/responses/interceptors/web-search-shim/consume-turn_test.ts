import { test } from 'vitest';

import {
  consumeTurnStreaming,
  type InterceptedFunctionCall,
  type TerminalStatus,
  type TurnSummary,
  type UmbrellaSlot,
} from './consume-turn.ts';
import { createMergeState, materializeAccumulatedOutput, sumUsage } from './merge-state.ts';
import { assert, assertEquals, assertFalse } from '../../../../../../test-assert.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponsesStreamEvent,
  UnknownResponseStreamEvent,
} from '@floway-dev/protocols/responses';

// Typed event-builder helpers for stream-merge tests. Mirror the
// upstream wire shape: output_index resets to 0 per upstream run() and
// no sequence_number on the wire.

const emptyResult = (id: string, status: ResponsesResult['status']): ResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  output: [],
  output_text: '',
  status,
  error: null,
  incomplete_details: null,
});

const mkResponseCreated = (responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkResponseInProgress = (responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.in_progress',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkFunctionCallAdded = (
  outputIndex: number,
  callId: string,
  name: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '',
      status: 'in_progress',
    },
  });

const mkFunctionCallArgsDelta = (
  outputIndex: number,
  delta: string,
  itemId = `fc_${outputIndex}`,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });

const mkFunctionCallArgsDone = (
  outputIndex: number,
  args: string,
  itemId = `fc_${outputIndex}`,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  });

const mkFunctionCallDone = (
  outputIndex: number,
  callId: string,
  name: string,
  args: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: args,
      status: 'completed',
    },
  });

const mkCustomToolCallAdded = (
  outputIndex: number,
  callId: string,
  name: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input: '',
    },
  });

const mkCustomToolCallInputDelta = (
  outputIndex: number,
  delta: string,
  itemId = `cti_${outputIndex}`,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.custom_tool_call_input.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });

const mkCustomToolCallInputDone = (
  outputIndex: number,
  input: string,
  itemId = `cti_${outputIndex}`,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.custom_tool_call_input.done',
    item_id: itemId,
    output_index: outputIndex,
    input,
  });

const mkCustomToolCallDone = (
  outputIndex: number,
  callId: string,
  name: string,
  input: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input,
    },
  });

const mkMessageAdded = (
  outputIndex: number,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    },
  });

const mkMessageDone = (
  outputIndex: number,
  text: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  });

const mkReasoningAdded = (
  outputIndex: number,
  reasoningId: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'reasoning', id: reasoningId, summary: [] },
  });

const mkReasoningDone = (
  outputIndex: number,
  reasoningId: string,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { type: 'reasoning', id: reasoningId, summary: [] },
  });

const mkResponseCompleted = (
  usage?: ResponsesResult['usage'],
  responseId = 'upstream_test',
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...emptyResult(responseId, 'completed'),
      ...(usage !== undefined ? { usage } : {}),
    },
  });

const framesOf = (
  ...frames: ProtocolFrame<ResponsesStreamEvent>[]
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> =>
  (async function* () {
    for (const f of frames) yield f;
  })();

const eventTypesOf = (frames: ProtocolFrame<ResponsesStreamEvent>[]): string[] =>
  frames.flatMap(f => (f.type === 'event' ? [f.event.type] : []));

interface DispatchRecord {
  intercepted: InterceptedFunctionCall;
}

// Records every umbrella call without producing IRs or start frames.
// Tests that care about dispatcher behavior pass a custom dispatcher.
const recordingDispatcher = (records: DispatchRecord[]) => (intercepted: InterceptedFunctionCall) => {
  records.push({ intercepted });
  return { slots: [] as UmbrellaSlot<unknown>[], startFrames: [] as ProtocolFrame<ResponsesStreamEvent>[] };
};

type DrainResult = {
  downstreamFrames: ProtocolFrame<ResponsesStreamEvent>[];
  summary: TurnSummary<unknown>;
  records: DispatchRecord[];
};

const drain = async (
  iter: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary<unknown>>,
  records: DispatchRecord[],
): Promise<DrainResult> => {
  const downstreamFrames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  let summary: TurnSummary<unknown> | undefined;
  while (true) {
    const next = await iter.next();
    if (next.done) {
      summary = next.value;
      break;
    }
    downstreamFrames.push(next.value);
  }
  return { downstreamFrames, summary: summary!, records };
};

const SHIM_TOOL_NAME = 'web_search';

const consumeTurn = async (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  state: Parameters<typeof consumeTurnStreaming>[1],
  isFirstTurn: boolean,
): Promise<DrainResult> => {
  const records: DispatchRecord[] = [];
  return await drain(
    consumeTurnStreaming<unknown>(frames, state, isFirstTurn, SHIM_TOOL_NAME, recordingDispatcher(records)),
    records,
  );
};

test('consumeTurn first turn synthesizes response.created with the once-per-request synthesized id (not the upstream id)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated('upstream_x'), mkResponseInProgress('upstream_x'), mkResponseCompleted()),
    state,
    true,
  );

  assertEquals(eventTypesOf(result.downstreamFrames), ['response.created', 'response.in_progress']);
  const created = result.downstreamFrames[0];
  assert(created.type === 'event');
  const createdEv = created.event as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  // Downstream id is the shim-synthesized value (stable cross-turn);
  // upstream's id is captured nowhere and never exposed downstream.
  assertEquals(createdEv.response.id, state.synthesizedResponseId);
  assert(state.synthesizedResponseId.startsWith('resp_shim_'));
});

test('consumeTurn synthesizes response.created with the upstream-reported model (no client fallback)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r', object: 'response', model: 'gpt-5.4-2025-01-20', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  const created = result.downstreamFrames.find(f => f.type === 'event' && f.event.type === 'response.created');
  assert(created?.type === 'event');
  const ev = created.event as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  assertEquals(ev.response.model, 'gpt-5.4-2025-01-20');
  assertEquals(state.lastSeenModel, 'gpt-5.4-2025-01-20');
});

test('consumeTurn throws when upstream response.created has no model field (no client fallback)', async () => {
  const state = createMergeState();
  const iter = consumeTurnStreaming<unknown>(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r', object: 'response', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        } as never,
      }),
      mkResponseCompleted(),
    ),
    state,
    true,
    SHIM_TOOL_NAME,
    recordingDispatcher([]),
  );
  let thrown: unknown;
  try {
    while (!(await iter.next()).done) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
  assert((thrown as Error).message.includes('upstream `response.created` did not report a `model`'));
});

test('consumeTurn captures upstream-reported model and writes it into MergeState', async () => {
  // Subsequent turns / terminal synthesizers read merge.lastSeenModel.
  const state = createMergeState();
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r', object: 'response', model: 'gpt-5.5-2025-09-01', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  assertEquals(state.lastSeenModel, 'gpt-5.5-2025-09-01');
});

test('consumeTurn re-captures upstream-reported model when later turns change it', async () => {
  // Multi-turn safety: if upstream reports a different model later
  // (unlikely but possible), the latest value wins so the synthesized
  // terminal frame mirrors what upstream actually served last.
  const state = createMergeState();
  state.lastSeenModel = 'gpt-5.5-2025-09-01';
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r2', object: 'response', model: 'gpt-5.6-2025-12-01', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    false,
  );
  assertEquals(state.lastSeenModel, 'gpt-5.6-2025-12-01');
});

test('consumeTurn does NOT capture upstream response.id (downstream uses the shim-synthesized id only)', async () => {
  // Upstream's id rotates per turn and the shim never exposes it
  // downstream — `synthesizedResponseId` is the single cross-turn
  // identity the client correlates against. Verify upstream's id
  // doesn't slip into any MergeState field.
  const state = createMergeState();
  const before = state.synthesizedResponseId;
  state.lastSeenModel = 'gpt-5';
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'resp_turn2_rotated', object: 'response', model: 'gpt-5', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    false,
  );
  assertEquals(state.synthesizedResponseId, before);
});

test('consumeTurn keeps previous upstream-reported model when a later turn omits it', async () => {
  // Turns without `model` on response.created (legal under the spec
  // even if unusual) keep the previous capture so terminal frames stay
  // stable rather than reverting to undefined.
  const state = createMergeState();
  state.lastSeenModel = 'gpt-5.5-2025-09-01';
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r2', object: 'response', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        } as never,
      }),
      mkResponseCompleted(),
    ),
    state,
    false,
  );
  assertEquals(state.lastSeenModel, 'gpt-5.5-2025-09-01');
});

test('consumeTurn second turn swallows upstream response.created and in_progress', async () => {
  const state = createMergeState();
  state.sequenceNumber = 100;
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseInProgress(), mkResponseCompleted()),
    state,
    false,
  );
  assertEquals(eventTypesOf(result.downstreamFrames), []);
});

test('consumeTurn intercepts the umbrella shim tool and does NOT forward its 4 events', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallArgsDelta(0, '{"search_q'),
      mkFunctionCallArgsDelta(0, 'uery":[{"q":"hello"}]}'),
      mkFunctionCallArgsDone(0, '{"search_query":[{"q":"hello"}]}'),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"hello"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 1);
  assertEquals(result.records[0].intercepted, {
    argumentsJson: '{"search_query":[{"q":"hello"}]}',
    reservedDownstreamIndex: 0,
  });
  assertEquals(result.summary.dispatched.length, 1);
  const downstreamTypes = eventTypesOf(result.downstreamFrames);
  for (const t of [
    'response.output_item.added',
    'response.output_item.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
  ]) {
    assertFalse(downstreamTypes.includes(t));
  }
  assertFalse(result.summary.sawClientToolCall);
});

test('consumeTurn intercepts two umbrella calls within one turn', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_o', SHIM_TOOL_NAME),
      mkFunctionCallDone(0, 'cc_o', SHIM_TOOL_NAME, '{"open":[{"ref_id":"https://x"}]}'),
      mkFunctionCallAdded(1, 'cc_f', SHIM_TOOL_NAME),
      mkFunctionCallDone(1, 'cc_f', SHIM_TOOL_NAME, '{"find":[{"ref_id":"https://x","pattern":"p"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  assertEquals(result.records.length, 2);
  assertEquals(result.records[0].intercepted.argumentsJson, '{"open":[{"ref_id":"https://x"}]}');
  assertEquals(result.records[1].intercepted.argumentsJson, '{"find":[{"ref_id":"https://x","pattern":"p"}]}');
});

test('consumeTurn synthesizes response.failed when upstream terminates without closing an umbrella function_call', async () => {
  // An umbrella reservation that never receives `output_item.done` is
  // an upstream protocol violation: the model intended a tool call,
  // the gateway accepted the reservation, but the close frame never
  // arrived. Without explicit detection here the reservation is
  // silently swallowed — the loop sees an empty `dispatched`, treats
  // the turn as "no tool call this turn", and emits success on a turn
  // that actually had unfinished tool intent. Promote to a synthesized
  // `response.failed` so the gateway surfaces the violation.
  const state = createMergeState();
  const records: DispatchRecord[] = [];
  const result = await drain(
    consumeTurnStreaming<unknown>(
      framesOf(
        mkResponseCreated(),
        mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
        mkFunctionCallArgsDelta(0, '{"x":'),
        mkFunctionCallArgsDelta(0, '1}'),
        // No function_call.done — dispatcher never fires.
        mkResponseCompleted(),
      ),
      state,
      true,
      SHIM_TOOL_NAME,
      recordingDispatcher(records),
    ),
    records,
  );
  assertEquals(result.summary.dispatched.length, 0);
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'failed' }>;
  assert((ts.response.error?.message ?? '').includes('without closing umbrella function_call items'));
  assert((ts.response.error?.message ?? '').includes('response.completed'));
});

test('consumeTurn dispatches at function_call.done with .done args canonical over deltas', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallArgsDelta(0, '{"stale":'),
      mkFunctionCallArgsDelta(0, '1}'),
      mkFunctionCallArgsDone(0, '{"search_query":[{"q":"x"}]}'),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"x"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  assertEquals(result.records[0].intercepted.argumentsJson, '{"search_query":[{"q":"x"}]}');
});

test('consumeTurn live-forwards non-shim function_calls and sets sawClientToolCall', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_x', 'my_other_tool'),
      mkFunctionCallArgsDone(0, '{}'),
      mkFunctionCallDone(0, 'cc_x', 'my_other_tool', '{}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(result.summary.sawClientToolCall, true);

  const types = eventTypesOf(result.downstreamFrames);
  assert(types.includes('response.created'));
  assert(types.includes('response.output_item.added'));
  assert(types.includes('response.output_item.done'));
  assert(types.includes('response.function_call_arguments.done'));

  const added = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added');
  assert(added?.type === 'event');
  const addedEv = added.event as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;
  assertEquals(addedEv.output_index, 0);
  assertEquals(addedEv.item.type, 'function_call');
});

test('consumeTurn live-forwards custom_tool_call items and sets sawClientToolCall', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkCustomToolCallAdded(0, 'cc_y', 'my_custom_tool'),
      mkCustomToolCallInputDelta(0, 'free'),
      mkCustomToolCallInputDelta(0, '-form input'),
      mkCustomToolCallInputDone(0, 'free-form input'),
      mkCustomToolCallDone(0, 'cc_y', 'my_custom_tool', 'free-form input'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(result.summary.sawClientToolCall, true);

  const types = eventTypesOf(result.downstreamFrames);
  assert(types.includes('response.output_item.added'));
  assert(types.includes('response.custom_tool_call_input.delta'));
  assert(types.includes('response.custom_tool_call_input.done'));
  assert(types.includes('response.output_item.done'));
});

test('consumeTurn forwards reasoning items with rewritten output_index', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  const added = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added');
  assert(added?.type === 'event');
  const ev = added.event as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;
  assertEquals(ev.output_index, 0);
  assertEquals(ev.item.type, 'reasoning');
  assertEquals(state.accumulatedOutput.size, 1);
  assertEquals(state.accumulatedOutput.get(0)?.type, 'reasoning');
});

test('consumeTurn single iteration ending in message: forwards full message lifecycle live', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(0),
      mkMessageDone(0, 'hi'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertFalse(result.summary.sawClientToolCall);
  assertEquals(state.accumulatedOutput.size, 1);
  assertEquals(state.accumulatedOutput.get(0)?.type, 'message');
  const types = eventTypesOf(result.downstreamFrames);
  assertEquals(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
  ]);
});

test('consumeTurn one umbrella call then message in same turn: FORWARDS the message live (umbrella is consumed)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"hi"}]}'),
      mkMessageAdded(1),
      mkMessageDone(1, 'intermediate text'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 1);
  assertEquals(state.accumulatedOutput.size, 1);
  // Recording dispatcher doesn't emit lifecycle frames so the umbrella's
  // reserved slot stays empty in accumulatedOutput, but outputIndex was
  // still bumped. The message therefore lands at index 1.
  assertEquals(state.accumulatedOutput.get(1)?.type, 'message');
  assertEquals(eventTypesOf(result.downstreamFrames), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
  ]);
});

test('consumeTurn forwards content_part / output_text / annotation events live with rewritten item_id', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(0),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.content_part.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        delta: 'hello ',
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.annotation.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: 'url_citation',
          url: 'https://x',
          title: 'X',
          start_index: 0,
          end_index: 5,
        },
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        text: 'hello world',
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.content_part.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: 'hello world' },
      }),
      mkMessageDone(0, 'hello world'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(eventTypesOf(result.downstreamFrames), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.annotation.added',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
  ]);

  // Message-child events get item_id rewritten onto the
  // downstream-minted `msg_<downstreamIndex>` (0 here).
  for (const f of result.downstreamFrames) {
    if (f.type !== 'event') continue;
    const ev = f.event as { item_id?: string };
    if (ev.item_id !== undefined) {
      assertEquals(ev.item_id, 'msg_0');
    }
  }
});

test('consumeTurn preserves upstream message item.id (no fabrication) when upstream supplies one', async () => {
  // Native upstream wire fixtures attach `id` to message items (see
  // openai-dotnet/tests/SessionRecords/ResponsesToolTests/WebSearchCallAsync.json
  // lines 65-223). When upstream provides item.id, child events
  // (`output_text.delta`, `content_part.added`, …) carry the SAME id
  // upstream emits. Fabricating `msg_<downstreamIndex>` here would
  // make child events mismatch the item's `output_item.added.item.id`.
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
          // Upstream-provided id.
          id: 'msg_xyz_real_id',
        } as never,
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_xyz_real_id',
        output_index: 0,
        content_index: 0,
        delta: 'hi',
      }),
      mkMessageDone(0, 'hi'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  // Child events keep upstream's id verbatim, not rewritten to msg_0.
  const deltaFrame = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_text.delta');
  assert(deltaFrame?.type === 'event');
  assertEquals((deltaFrame.event as { item_id: string }).item_id, 'msg_xyz_real_id');
  // The forwarded `output_item.added` carries the same upstream id.
  const addedFrame = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added');
  assert(addedFrame?.type === 'event');
  const addedItem = (addedFrame.event as { item: { id?: string } }).item;
  assertEquals(addedItem.id, 'msg_xyz_real_id');
});

test('consumeTurn forwards message text events live even when mixed with an intercepted search', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"q"}]}'),
      mkMessageAdded(1),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 1,
        content_index: 0,
        delta: 'intermediate',
      }),
      mkMessageDone(1, 'intermediate'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 1);
  const types = eventTypesOf(result.downstreamFrames);
  assert(types.includes('response.output_item.added'));
  assert(types.includes('response.output_item.done'));
  assert(types.includes('response.output_text.delta'));
});

test('consumeTurn rewrites sequence_number monotonically starting from state.sequenceNumber', async () => {
  const state = createMergeState();
  state.sequenceNumber = 50;
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
      mkResponseCompleted(),
    ),
    state,
    false,
  );

  const seqs = result.downstreamFrames.flatMap(f =>
    f.type === 'event' ? [(f.event as { sequence_number?: number }).sequence_number ?? -1] : []);
  for (let i = 0; i < seqs.length; i++) {
    assertEquals(seqs[i], 50 + i);
  }
  assertEquals(state.sequenceNumber, 50 + seqs.length);
});

test('consumeTurn allocates contiguous downstream output_index across mixed item types (live-forwarded function_call included)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
      mkFunctionCallAdded(1, 'cc_x', 'my_other_tool'),
      mkFunctionCallDone(1, 'cc_x', 'my_other_tool', '{}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  const liveAdded = result.downstreamFrames.flatMap(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added'
      ? [(f.event as { output_index: number }).output_index]
      : []);
  assertEquals(liveAdded, [0, 1]);
  assertEquals(state.outputIndex, 2);
});

test('consumeTurn extracts usage from response.completed envelope', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkResponseCompleted({
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 5 },
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.turnUsage, {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 5 },
  });
});

test('consumeTurn returns empty turnUsage when upstream response.completed lacks usage', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseCompleted()),
    state,
    true,
  );
  assertEquals(result.summary.turnUsage, {});
});

test('consumeTurn does NOT emit response.completed in downstreamFrames', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseCompleted({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })),
    state,
    true,
  );
  assertFalse(eventTypesOf(result.downstreamFrames).includes('response.completed'));
});

test('consumeTurn sets terminalStatus.kind = completed when upstream response.completed arrives', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseCompleted()),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'completed');
});

test('consumeTurn surfaces upstream response.failed as terminalStatus.failed with the upstream envelope', async () => {
  const state = createMergeState();
  const failedResponse: ResponsesResult = {
    id: 'upstream_x',
    object: 'response',
    model: 'test-model',
    output: [],
    output_text: '',
    status: 'failed',
    error: { message: 'upstream gave up', type: 'server_error', code: '500' },
    incomplete_details: null,
  };
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.failed',
        response: failedResponse,
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'failed' }>;
  assertEquals(ts.response.error?.code, '500');
});

test('consumeTurn surfaces upstream response.incomplete as terminalStatus.incomplete', async () => {
  const state = createMergeState();
  const incompleteResponse: ResponsesResult = {
    id: 'upstream_x',
    object: 'response',
    model: 'test-model',
    output: [],
    output_text: '',
    status: 'incomplete',
    error: null,
    incomplete_details: null,
  };
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.incomplete',
        response: incompleteResponse,
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'incomplete');
});

test('consumeTurn surfaces bare `error` event as terminalStatus.failed with a synthesized envelope', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream blew up',
        code: 'server_error',
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'failed' }>;
  assertEquals(ts.response.status, 'failed');
  assertEquals(ts.response.error?.message, 'upstream blew up');
  assertEquals(ts.response.error?.code, 'server_error');
  // Synthesized envelope's id is the shim-synthesized response id
  // — upstream's id is not exposed downstream.
  assertEquals(ts.response.id, state.synthesizedResponseId);
});

test('consumeTurn defaults missing `error.code` to spec-defined `server_error` (no synthetic `unknown_upstream_error` literal)', async () => {
  // A bare upstream `{type: 'error'}` frame without a `code` field
  // falls back to the OpenAPI `ResponseErrorCode` enum value
  // `'server_error'`. The previous `'unknown_upstream_error'`
  // synthetic literal is not in the enum and typed SDKs (openai-python
  // `Literal[...]` with strict Pydantic validation, openai-node
  // literal union, openai-go `ResponseErrorCode string` named type)
  // reject unknown values at parse time. Reference:
  // https://github.com/openai/openai-openapi/blob/master/openapi.yaml
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream blew up without a code',
      }),
    ),
    state,
    true,
  );
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'failed' }>;
  assertEquals(ts.response.error?.code, 'server_error');
  // No synthetic `type` — the spec's ResponseError schema defines
  // only `{code, message}` and the upstream `error` frame doesn't
  // carry a `type` field on the wire either.
  assertFalse('type' in (ts.response.error as object));
});

test('consumeTurn treats empty-string `error.code` as missing (same fallback as undefined)', async () => {
  // `??` only handles null/undefined; an explicit `code: ''` would
  // survive and reach the wire as the synthesized response.failed's
  // `error.code`, where typed SDKs reject the empty string the same
  // way they reject any non-enum value. Mirror `parseUpstreamErrorBody`'s
  // `length > 0` guard for shape parity between the bare-error path
  // and the upstream-error HTTP body path.
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream blew up with empty code',
        code: '',
      }),
    ),
    state,
    true,
  );
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'failed' }>;
  assertEquals(ts.response.error?.code, 'server_error');
});

test('consumeTurn surfaces bare `error` event arriving BEFORE response.created as terminalStatus `bare-error-pre-shell` (no synthesized response)', async () => {
  // The success-path "no fallback" contract refuses to synthesize a
  // wire-valid response envelope that lies about the served identity.
  // The bare-error path's job is the opposite: surface upstream's
  // failure verbatim. But when the failure happens before any
  // identity is captured (truncated TLS, transport drop, intermediate
  // proxy injection), we cannot synthesize a wire-valid
  // `ResponsesResult` (id and model are required, not nullable). Use
  // a distinct terminal status `bare-error-pre-shell` so the shim's
  // outer loop can short-circuit to a non-events `upstream-error`
  // result instead of fabricating empty-string identity fields.
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream dropped before response shell',
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'bare-error-pre-shell');
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'bare-error-pre-shell' }>;
  assertEquals(ts.error.message, 'upstream dropped before response shell');
  // Spec-defined fallback (no `code` on upstream's error frame). See
  // the matching test above for the in-shell path; both default to
  // `server_error` from the `ResponseErrorCode` enum.
  assertEquals(ts.error.code, 'server_error');
});

test('consumeTurnStreaming yields forwarded frames before upstream completes', async () => {
  const state = createMergeState();

  let upstreamPullCount = 0;
  const upstream: ProtocolFrame<ResponsesStreamEvent>[] = [
    mkResponseCreated(),
    mkReasoningAdded(0, 'rs_1'),
    mkReasoningDone(0, 'rs_1'),
    mkResponseCompleted(),
  ];
  const countedFrames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
    for (const f of upstream) {
      upstreamPullCount += 1;
      yield f;
    }
  })();

  const records: DispatchRecord[] = [];
  const iter = consumeTurnStreaming<unknown>(
    countedFrames,
    state,
    true,
    SHIM_TOOL_NAME,
    recordingDispatcher(records),
  );

  const first = await iter.next();
  assert(!first.done);
  assert(first.value.type === 'event');
  assertEquals(first.value.event.type, 'response.created');
  assertEquals(upstreamPullCount, 1);

  while (!(await iter.next()).done) { /* drain */ }
});

test('dispatcher start frames yield IN-LINE at function_call.done (umbrella slot precedes later items)', async () => {
  const state = createMergeState();
  let dispatchOrder = 0;
  const records: DispatchRecord[] = [];
  const dispatcher = (intercepted: InterceptedFunctionCall) => {
    records.push({ intercepted });
    const order = ++dispatchOrder;
    return {
      slots: [] as UmbrellaSlot<unknown>[],
      startFrames: [
        eventFrame<ResponsesStreamEvent>({
          type: 'response.web_search_call.in_progress',
          output_index: 999,
          item_id: `synthetic-${order}`,
        } as ResponsesStreamEvent),
      ],
    };
  };

  const result = await drain(
    consumeTurnStreaming<unknown>(
      framesOf(
        mkResponseCreated(),
        mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
        mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"hi"}]}'),
        mkMessageAdded(1),
        mkMessageDone(1, 'after'),
        mkResponseCompleted(),
      ),
      state,
      true,
      SHIM_TOOL_NAME,
      dispatcher,
    ),
    records,
  );

  const types = eventTypesOf(result.downstreamFrames);
  const syntheticIdx = types.indexOf('response.web_search_call.in_progress');
  const messageAddedIdx = types.indexOf('response.output_item.added');
  assert(syntheticIdx >= 0);
  assert(messageAddedIdx >= 0);
  assert(syntheticIdx < messageAddedIdx, `expected dispatcher start frame BEFORE later live items (synth=${syntheticIdx}, msgAdded=${messageAddedIdx})`);
});

test('umbrella output_index is reserved at output_item.added so interleaved items get later indices', async () => {
  // Reserving at `.added` (rather than `.done`) keeps a non-umbrella
  // item arriving between added and done from stealing the umbrella's
  // would-be downstream index. See spec § Output-index allocation.
  const state = createMergeState();
  let capturedReservedIndex: number | undefined;
  const dispatcher = (intercepted: InterceptedFunctionCall) => {
    capturedReservedIndex = intercepted.reservedDownstreamIndex;
    return { slots: [] as UmbrellaSlot<unknown>[], startFrames: [] as ProtocolFrame<ResponsesStreamEvent>[] };
  };

  const interleaved = eventFrame<ResponsesStreamEvent>({
    type: 'response.image_generation_call.in_progress',
    output_index: 5,
    item_id: 'ig_x',
  } as unknown as ResponsesStreamEvent);

  const records: DispatchRecord[] = [];
  const result = await drain(
    consumeTurnStreaming<unknown>(
      framesOf(
        mkResponseCreated(),
        mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
        interleaved,
        mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"x"}]}'),
        mkResponseCompleted(),
      ),
      state,
      true,
      SHIM_TOOL_NAME,
      dispatcher,
    ),
    records,
  );

  assertEquals(capturedReservedIndex, 0);
  // `image_generation_call.*` is a future-server-tool lifecycle event
  // type not enumerated on `ResponseStreamEvent`; widen the discriminator
  // through `UnknownResponseStreamEvent` to compare against it.
  const igForwarded = result.downstreamFrames.find(f =>
    f.type === 'event' && (f.event as UnknownResponseStreamEvent).type === 'response.image_generation_call.in_progress');
  assert(igForwarded?.type === 'event');
  assertEquals((igForwarded.event as { output_index: number }).output_index, 1);
});

test('consumeTurn live-forwards an unknown server-tool lifecycle event pair when it carries output_index', async () => {
  const state = createMergeState();
  // Cast through UnknownResponseStreamEvent: these event types are
  // forward-compat upstream additions (image_generation_call lifecycle,
  // etc.) that the strongly-typed `ResponseStreamEvent` union does not
  // enumerate, so they enter the consume-turn pipeline via the unknown
  // catch-all branch.
  const inProgress = eventFrame<ResponsesStreamEvent>({
    type: 'response.image_generation_call.in_progress',
    output_index: 0,
    item_id: 'ig_1',
  } as unknown as ResponsesStreamEvent);
  const completed = eventFrame<ResponsesStreamEvent>({
    type: 'response.image_generation_call.completed',
    output_index: 0,
    item_id: 'ig_1',
  } as unknown as ResponsesStreamEvent);
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), inProgress, completed, mkResponseCompleted()),
    state,
    true,
  );
  const forwarded = result.downstreamFrames
    .filter(f => f.type === 'event')
    .map(f => (f.event as { type: string }).type);
  assert(forwarded.includes('response.image_generation_call.in_progress'));
  assert(forwarded.includes('response.image_generation_call.completed'));
  const indices = result.downstreamFrames.flatMap(f =>
    f.type === 'event' && (f.event.type as string).startsWith('response.image_generation_call')
      ? [(f.event as { output_index: number }).output_index]
      : []);
  assertEquals(new Set(indices).size, 1);
});

test('consumeTurn keeps swallowing keepalive/ping-shape events that lack output_index', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({ type: 'keepalive' } as unknown as ResponsesStreamEvent),
      eventFrame<ResponsesStreamEvent>({ type: 'ping' }),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  const types = eventTypesOf(result.downstreamFrames);
  assertFalse(types.includes('keepalive'));
  assertFalse(types.includes('ping'));
});

test('consumeTurn synthesizes terminalStatus.failed when upstream stream ends without any terminal event', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<TerminalStatus, { kind: 'failed' }>;
  assertEquals(ts.response.status, 'failed');
  assert((ts.response.error?.message ?? '').includes('without a terminal event'));
});

test('createMergeState starts with empty sparse usage accumulator and a synthesized response id', () => {
  const s = createMergeState();
  assert(s.synthesizedResponseId.startsWith('resp_shim_'));
  assertEquals(s.lastSeenModel, null);
  assertEquals(s.sequenceNumber, 0);
  assertEquals(s.outputIndex, 0);
  assertEquals(s.accumulatedOutput.size, 0);
  // Sparse on purpose: a field appears only when at least one turn
  // observed it, so we never fabricate `cached_tokens: 0` for an
  // upstream that doesn't report cache.
  assertEquals(s.accumulatedUsage, {});
});

test('materializeAccumulatedOutput returns items in output_index order regardless of insertion order', () => {
  const s = createMergeState();
  const itemA: ResponseOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] };
  const itemB: ResponseOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'B' }] };
  const itemC: ResponseOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'C' }] };
  s.accumulatedOutput.set(2, itemC);
  s.accumulatedOutput.set(0, itemA);
  s.accumulatedOutput.set(1, itemB);
  const out = materializeAccumulatedOutput(s);
  assertEquals(out.length, 3);
  assertEquals((out[0] as { content: { text: string }[] }).content[0].text, 'A');
  assertEquals((out[1] as { content: { text: string }[] }).content[0].text, 'B');
  assertEquals((out[2] as { content: { text: string }[] }).content[0].text, 'C');
});

test('materializeAccumulatedOutput drops holes in the index sequence (defensive)', () => {
  const s = createMergeState();
  const itemB: ResponseOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'B' }] };
  s.accumulatedOutput.set(1, itemB);
  const out = materializeAccumulatedOutput(s);
  assertEquals(out.length, 1);
  assertEquals((out[0] as { content: { text: string }[] }).content[0].text, 'B');
});

test('sumUsage sums every subfield including details', () => {
  const a = {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  };
  const b = {
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    input_tokens_details: { cached_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 30 },
  };
  assertEquals(sumUsage(a, b), {
    input_tokens: 110,
    output_tokens: 220,
    total_tokens: 330,
    input_tokens_details: { cached_tokens: 55 },
    output_tokens_details: { reasoning_tokens: 33 },
  });
});

test('sumUsage omits detail subfields neither side reported (sparse)', () => {
  const a = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
  const b = { input_tokens: 100, output_tokens: 200, total_tokens: 300 };
  assertEquals(sumUsage(a, b), {
    input_tokens: 110,
    output_tokens: 220,
    total_tokens: 330,
  });
});

test('sumUsage of two empty operands returns an empty object (no fabricated zeros)', () => {
  assertEquals(sumUsage({}, {}), {});
});

test('sumUsage with one-sided details preserves the field (treats missing side as 0)', () => {
  const a = {
    input_tokens: 10,
    output_tokens: 0,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
  };
  const b = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  assertEquals(sumUsage(a, b), {
    input_tokens: 11,
    output_tokens: 1,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 4 },
  });
});
