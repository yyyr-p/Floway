import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/openai-chat-completions-via-gemini-generate-content/events.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async (events: readonly GeminiGenerateContentStreamEvent[]): Promise<OpenAIChatCompletionsStreamEvent[]> => {
  const frames: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = events.map(eventFrame);
  const source = (async function* () { yield* frames; })();
  const out: OpenAIChatCompletionsStreamEvent[] = [];
  for await (const frame of translateToSourceEvents('gpt-test')(source)) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('a text turn maps onto role-first chunks closing with finish_reason and usage', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'he' }] }, index: 0 }], responseId: 'resp_1' },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'llo' }] }, index: 0 }] },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 4, totalTokenCount: 13 },
      modelVersion: 'gemini-3-pro',
    },
  ]);
  assertEquals(events, [
    { id: 'resp_1', object: 'chat.completion.chunk', created: expect.any(Number), model: 'gpt-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'he' }, finish_reason: null }] },
    { id: 'resp_1', object: 'chat.completion.chunk', created: expect.any(Number), model: 'gpt-test', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: null }] },
    { id: 'resp_1', object: 'chat.completion.chunk', created: expect.any(Number), model: 'gemini-3-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      id: 'resp_1', object: 'chat.completion.chunk', created: expect.any(Number), model: 'gemini-3-pro', choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } },
    },
  ]);
});

test('thought parts ride reasoning_text and a function call becomes a tool_call delta', async () => {
  const events = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'pondering', thought: true }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_9', name: 'lookup', args: { q: 1 } } }] }, index: 0 }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }] },
  ]);
  assertEquals(events[0].choices[0].delta, { role: 'assistant', reasoning_text: 'pondering' });
  assertEquals(events[1].choices[0].delta, {
    tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
  });
});

test('MAX_TOKENS and SAFETY map onto length and content_filter', async () => {
  const length = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS', index: 0 }] },
  ]);
  assertEquals(length[0].choices[0].finish_reason, 'length');

  const filtered = await collect([
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'SAFETY', index: 0 }] },
  ]);
  assertEquals(filtered[0].choices[0].finish_reason, 'content_filter');
});

test('an in-stream error payload throws for the boundary to 502', async () => {
  await assertRejects(async () => await collect([
    { error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } },
  ]), Error, 'quota exhausted');
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
