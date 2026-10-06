import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/openai-responses-via-gemini-generate-content/events.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async (
  events: readonly GeminiGenerateContentStreamEvent[],
  customToolNames: ReadonlySet<string> = new Set(),
): Promise<OpenAIResponsesStreamEvent[]> => {
  const frames: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = events.map(eventFrame);
  const source = (async function* () { yield* frames; })();
  const out: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of translateToSourceEvents('gpt-test', customToolNames)(source)) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('a text turn opens with response.created and closes with response.completed carrying usage', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'he' }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'llo' }] }, index: 0 }] },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 4, totalTokenCount: 13 },
      modelVersion: 'gemini-3-pro',
    },
  ]);

  const types = events.map(event => event.type);
  assertEquals(types[0], 'response.created');
  assertEquals(types[1], 'response.in_progress');

  const created = events[0] as Extract<OpenAIResponsesStreamEvent, { type: 'response.created' }>;
  assertEquals(created.response.id, expect.stringMatching(/^resp_[0-9a-f]+$/));
  assertEquals(created.response.status, 'in_progress');
  assertEquals(created.response.model, 'gpt-test');

  const delta = events[4] as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.delta' }>;
  assertEquals(delta.delta, 'he');
  const secondDelta = events[5] as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.delta' }>;
  assertEquals(secondDelta.delta, 'llo');

  const completed = events[events.length - 1] as Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' }>;
  assertEquals(completed.response.status, 'completed');
  // Responses carries the inclusive prompt count directly — no folding.
  assertEquals(completed.response.usage, {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 4 },
  });
  // The request model stamps response.created, and the terminal keeps it —
  // mid-stream modelVersion never renames an in-flight response.
  assertEquals(completed.response.model, 'gpt-test');
  const messageItem = completed.response.output.find(item => item.type === 'message');
  assertEquals(messageItem?.status, 'completed');
});

test('a thought part opens a reasoning item and the following text closes it', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'ponder', thought: true }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'sig-value', thought: true, thoughtSignature: 'sig-value' }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }] },
  ]);

  const added = events.filter(event => event.type === 'response.output_item.added') as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>[];
  assertEquals(added.length, 2);
  assertEquals(added[0].item.type, 'reasoning');
  assertEquals(added[1].item.type, 'message');

  const reasoningDelta = events.filter(event => event.type === 'response.reasoning_summary_text.delta') as Extract<OpenAIResponsesStreamEvent, { type: 'response.reasoning_summary_text.delta' }>[];
  assertEquals(reasoningDelta.map(event => event.delta), ['ponder', 'sig-value']);

  const reasoningDone = events.find(event => event.type === 'response.output_item.done' && (event as { item?: { type?: string } }).item?.type === 'reasoning') as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;
  // The signature rides the item as encrypted_content.
  assertEquals((reasoningDone.item as { encrypted_content?: string }).encrypted_content, 'sig-value');

  const textDeltas = events.filter(event => event.type === 'response.output_text.delta') as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.delta' }>[];
  assertEquals(textDeltas.map(event => event.delta), ['answer']);
});

test('a functionCall becomes a completed function_call item in one emission', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_9', name: 'lookup', args: { q: 1 } } }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }] },
  ]);

  const done = events.find(event => event.type === 'response.output_item.done') as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;
  assertEquals(done.item, {
    type: 'function_call',
    id: expect.stringMatching(/^fc_[0-9a-f]+$/),
    call_id: 'call_9',
    name: 'lookup',
    arguments: '{"q":1}',
    status: 'completed',
  });
  const argumentsDone = events.find(event => event.type === 'response.function_call_arguments.done') as Extract<OpenAIResponsesStreamEvent, { type: 'response.function_call_arguments.done' }>;
  assertEquals(argumentsDone.arguments, '{"q":1}');
});

test('a projected custom tool call unwraps its { input } envelope onto a custom_tool_call item', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_9', name: 'apply_patch', args: { input: '*** Begin Patch' } } }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }] },
  ], new Set(['apply_patch']));

  const done = events.find(event => event.type === 'response.output_item.done') as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;
  assertEquals(done.item, {
    type: 'custom_tool_call',
    id: expect.stringMatching(/^ctc_[0-9a-f]+$/),
    call_id: 'call_9',
    name: 'apply_patch',
    input: '*** Begin Patch',
  });
});

test('MAX_TOKENS closes with response.incomplete and max_output_tokens details', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS', index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } },
  ]);
  const terminal = events[events.length - 1] as Extract<OpenAIResponsesStreamEvent, { type: 'response.incomplete' }>;
  assertEquals(terminal.type, 'response.incomplete');
  assertEquals(terminal.response.incomplete_details, { reason: 'max_output_tokens' });
  assertEquals(terminal.response.usage, { input_tokens: 5, output_tokens: 9, total_tokens: 14 });
});

test('an in-stream error emits the bare error frame and stops the stream', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, index: 0 }] },
    { error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } },
  ]);
  assertEquals(events[events.length - 1], { type: 'error', message: 'quota exhausted', code: 'RESOURCE_EXHAUSTED', sequence_number: expect.any(Number) });
});

test('a stream that ends without a terminal event rejects', async () => {
  const source = (async function* () {
    yield eventFrame({ candidates: [{ content: { role: 'model' as const, parts: [{ text: 'cut' }] }, index: 0 }] } as GeminiGenerateContentStreamEvent);
  })();
  await assertRejects(async () => {
    for await (const _frame of translateToSourceEvents('gpt-test')(source)) {
      // Exhaust to surface the rejection.
    }
  }, Error, 'without a terminal');
});
