import { test } from 'vitest';

import { buildTargetRequest } from '../../src/openai-chat-completions-via-gemini-generate-content/request.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const basePayload: OpenAIChatCompletionsPayload = {
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'hello' }],
};

test('buildTargetRequest maps a plain exchange onto user/model contents with an explicit model drop', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'bye' },
    ],
  });
  assertEquals(result, {
    systemInstruction: { parts: [{ text: 'be terse' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
      { role: 'user', parts: [{ text: 'bye' }] },
    ],
    generationConfig: {},
  } satisfies GeminiGenerateContentPayload);
});

test('buildTargetRequest folds sampling fields and forward reasoning_effort as thinkingLevel', () => {
  const result = buildTargetRequest({
    ...basePayload,
    max_tokens: 128,
    temperature: 0.4,
    top_p: 0.8,
    stop: 'END',
    n: 1,
    seed: 7,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    reasoning_effort: 'high',
  });
  assertEquals(result.generationConfig, {
    maxOutputTokens: 128,
    temperature: 0.4,
    topP: 0.8,
    stopSequences: ['END'],
    candidateCount: 1,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
    seed: 7,
    thinkingConfig: { thinkingLevel: 'high' },
  });
});

test('buildTargetRequest maps tools and the string/named tool_choice dialects', () => {
  const withTools: OpenAIChatCompletionsPayload = {
    ...basePayload,
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Reads the sky', parameters: { type: 'object', properties: {} } } }],
  };
  assertEquals(buildTargetRequest(withTools).tools, [{ functionDeclarations: [{ name: 'get_weather', description: 'Reads the sky', parameters: { type: 'object', properties: {} } }] }]);
  assertEquals(buildTargetRequest({ ...withTools, tool_choice: 'auto' }).toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
  assertEquals(buildTargetRequest({ ...withTools, tool_choice: 'required' }).toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assertEquals(buildTargetRequest({ ...withTools, tool_choice: 'none' }).toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  assertEquals(
    buildTargetRequest({ ...withTools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }).toolConfig,
    { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
  );
});

test('buildTargetRequest parses tool_call arguments and restores names for tool outputs', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"found":true}' },
    ],
  });
  assertEquals(result.contents![1], { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { q: 1 } } }] });
  assertEquals(result.contents![2], {
    role: 'user',
    parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { result: { found: true } } } }],
  });
});

test('buildTargetRequest keeps unstructured tool output as a bare string and rejects malformed arguments', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'plain text' },
    ],
  });
  assertEquals(result.contents![1], {
    role: 'user',
    parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { result: 'plain text' } } }],
  });

  assertThrows(() => buildTargetRequest({
    ...basePayload,
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'lookup', arguments: '{oops' } }] },
    ],
  }), undefined, 'were not valid JSON');
});

test('buildTargetRequest maps reasoning text onto the thought slot and base64 images onto inlineData', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      {
        role: 'assistant',
        reasoning_content: 'pondering',
        content: 'it is a cat',
      },
    ],
  });
  assertEquals(result.contents![0], {
    role: 'user',
    parts: [{ text: 'what is this' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
  });
  assertEquals(result.contents![1], {
    role: 'model',
    parts: [{ text: 'pondering', thought: true }, { text: 'it is a cat' }],
  });
});

test('buildTargetRequest drops an unsupported image URL scheme and skips empty parts', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'ftp://example.com/cat.png' } },
          { type: 'text', text: '' },
          { type: 'text', text: 'still here' },
        ],
      },
    ],
  });
  assertEquals(result.contents![0], { role: 'user', parts: [{ text: 'still here' }] });
});

test('buildTargetRequest maps developer role onto the same instruction slot', () => {
  const result = buildTargetRequest({
    ...basePayload,
    messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }],
  });
  assertEquals(result.systemInstruction, { parts: [{ text: 'be terse' }] });
});
