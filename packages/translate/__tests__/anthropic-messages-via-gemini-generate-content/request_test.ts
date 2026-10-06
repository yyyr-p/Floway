import { expect, test } from 'vitest';

import { buildTargetRequest } from '../../src/anthropic-messages-via-gemini-generate-content/request.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals } from '@floway-dev/test-utils';

const basePayload: AnthropicMessagesPayload = {
  model: 'claude-test',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'hello' }],
};

test('buildTargetRequest maps a plain text exchange onto user/model contents', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'bye' },
    ],
  });
  assertEquals(result, {
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
      { role: 'user', parts: [{ text: 'bye' }] },
    ],
    generationConfig: { maxOutputTokens: 256 },
  } satisfies GeminiGenerateContentPayload);
});

test('buildTargetRequest folds the system prompt into systemInstruction', () => {
  const result = buildTargetRequest({ ...basePayload, system: 'be terse' });
  assertEquals(result.systemInstruction, { parts: [{ text: 'be terse' }] });
  // A later inline system message wins, matching the other *-via-* translators.
  const overridden = buildTargetRequest({
    ...basePayload,
    system: 'first',
    messages: [{ role: 'system', content: 'second' }, { role: 'user', content: 'hi' }],
  });
  assertEquals(overridden.systemInstruction, { parts: [{ text: 'second' }] });
});

test('buildTargetRequest maps tools and every tool_choice dialect', () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload,
    tools: [{ name: 'get_weather', description: 'Reads the sky', input_schema: { type: 'object', properties: {} } }],
  };
  const auto = buildTargetRequest({ ...payload, tool_choice: { type: 'auto' } });
  assertEquals(auto.tools, [{ functionDeclarations: [{ name: 'get_weather', description: 'Reads the sky', parameters: { type: 'object', properties: {} } }] }]);
  assertEquals(auto.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });

  assertEquals(buildTargetRequest({ ...payload, tool_choice: { type: 'any' } }).toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assertEquals(buildTargetRequest({ ...payload, tool_choice: { type: 'none' } }).toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  assertEquals(
    buildTargetRequest({ ...payload, tool_choice: { type: 'tool', name: 'get_weather' } }).toolConfig,
    { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
  );
  // No tool_choice leaves the config unset.
  assertEquals(buildTargetRequest(payload).toolConfig, undefined);
});

test('buildTargetRequest replays a signed thinking block onto the following part', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'trace', signature: 'sig-1' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  });
  assertEquals(result.contents![1], {
    role: 'model',
    parts: [
      { text: 'trace', thought: true },
      { text: 'answer', thoughtSignature: 'sig-1' },
    ],
  });
});

test('buildTargetRequest keeps a signature-only assistant turn as a carrier part', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'opaque' }],
      },
      { role: 'user', content: 'go on' },
    ],
  });
  assertEquals(result.contents![0], { role: 'model', parts: [{ text: '', thoughtSignature: 'opaque' }] });
});

test('buildTargetRequest restores tool names for tool results from the history walk', () => {
  const result = buildTargetRequest({
    ...basePayload,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
    ],
  });
  assertEquals(result.contents![2], {
    role: 'user',
    parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { result: 'found' } } }],
  });
  // The call itself keeps the structured args.
  assertEquals(result.contents![1], {
    role: 'model',
    parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { q: 1 } } }],
  });
});

test('buildTargetRequest maps thinking dialects and sampling fields', () => {
  assertEquals(
    buildTargetRequest({ ...basePayload, thinking: { type: 'enabled', budget_tokens: 1024 } }).generationConfig?.thinkingConfig,
    { thinkingBudget: 1024 },
  );
  assertEquals(
    buildTargetRequest({ ...basePayload, thinking: { type: 'adaptive' } }).generationConfig?.thinkingConfig,
    { includeThoughts: true },
  );
  assertEquals(
    buildTargetRequest({ ...basePayload, thinking: { type: 'disabled' } }).generationConfig?.thinkingConfig,
    { thinkingBudget: 0 },
  );
  const sampled = buildTargetRequest({
    ...basePayload,
    temperature: 0.5,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ['END'],
  });
  assertEquals(sampled.generationConfig, {
    maxOutputTokens: 256,
    temperature: 0.5,
    topP: 0.9,
    topK: 40,
    stopSequences: ['END'],
  });
});

test('buildTargetRequest rejects a fallback assistant block', () => {
  expect(() => buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'assistant', content: [{ type: 'fallback', text: '?' } as never] },
    ],
  })).toThrow(/fallback/);
});
