import { test } from 'vitest';

import { translateToSourceEvents } from '../../src/anthropic-messages-via-gemini-generate-content/events.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async (events: readonly GeminiGenerateContentStreamEvent[]): Promise<AnthropicMessagesStreamEvent[]> => {
  const frames: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = events.map(eventFrame);
  const source = (async function* () { yield* frames; })();
  const out: AnthropicMessagesStreamEvent[] = [];
  for await (const frame of translateToSourceEvents('claude-test')(source)) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('a text turn maps onto the full Anthropic Messages event lifecycle', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'he' }] }, index: 0 }], responseId: 'resp_1' },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'llo' }] }, index: 0 }], responseId: 'resp_1' },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 4 },
      modelVersion: 'gemini-3-pro',
    },
  ]);
  assertEquals(events, [
    {
      type: 'message_start',
      message: {
        id: 'resp_1', type: 'message', role: 'assistant', content: [],
        model: 'claude-test', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
    { type: 'content_block_stop', index: 0 },
    // cachedContentTokenCount splits out of the inclusive prompt count.
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 4 } },
    { type: 'message_stop' },
  ]);
});

test('a thinking stretch with a signature lands as thinking and signature deltas on one block', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'ponder', thought: true }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'sig-value', thoughtSignature: 'sig-value', thought: true }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }] },
  ]);
  const deltas = events.filter(event => event.type === 'content_block_delta') as Extract<AnthropicMessagesStreamEvent, { type: 'content_block_delta' }>[];
  assertEquals(deltas, [
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ponder' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'sig-value' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-value' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
  ]);
});

test('a function call becomes an inline tool_use block and MAX_TOKENS maps to max_tokens', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'checking' }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_9', name: 'lookup', args: { q: 1 } } }] }, index: 0 }] },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS', index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 },
    },
  ]);
  // message_start opens, the text block closes, then the tool block is
  // emitted inline as start+stop.
  assertEquals(events[1], { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  assertEquals(events[2], { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checking' } });
  assertEquals(events[3], { type: 'content_block_stop', index: 0 });
  assertEquals(events[4], { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_9', name: 'lookup', input: { q: 1 } } });
  assertEquals(events[5], { type: 'content_block_stop', index: 1 });
  const delta = events[6] as Extract<AnthropicMessagesStreamEvent, { type: 'message_delta' }>;
  assertEquals(delta.delta.stop_reason, 'max_tokens');
  assertEquals(delta.usage, { input_tokens: 5, output_tokens: 9 });
});

test('a SAFETY finish maps onto a refusal with the finish message', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'SAFETY', finishMessage: 'blocked', index: 0 }] },
  ]);
  const delta = events[1] as Extract<AnthropicMessagesStreamEvent, { type: 'message_delta' }>;
  assertEquals(delta.delta, {
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: null, explanation: 'blocked' },
    stop_sequence: null,
  });
});

test('an in-stream error closes the message with an api_error envelope', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, index: 0 }] },
    { error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } },
  ]);
  // The error terminates without a message_delta — the stream just stops.
  assertEquals(events[events.length - 1], { type: 'error', error: { type: 'api_error', message: 'quota exhausted' } });
});

test('a stream that ends without a terminal event rejects', async () => {
  const source = (async function* () {
    yield eventFrame({ candidates: [{ content: { role: 'model' as const, parts: [{ text: 'cut' }] }, index: 0 }] } as GeminiGenerateContentStreamEvent);
  })();
  await assertRejects(async () => {
    for await (const _frame of translateToSourceEvents('claude-test')(source)) {
      // Exhaust to surface the rejection.
    }
  }, Error, 'without a terminal');
});
