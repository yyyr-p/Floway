import { test } from 'vitest';

import { buildTargetRequest } from '../../src/openai-responses-via-gemini-generate-content/request.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const minimalPayload = {
  model: 'gpt-test',
  input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }],
  instructions: null,
  temperature: null,
  top_p: null,
  max_output_tokens: 256,
  tools: null,
  tool_choice: null,
  metadata: null,
  stream: null,
  store: false,
  parallel_tool_calls: true,
};

test('buildTargetRequest maps a plain exchange onto user/model contents with sampling fields', async () => {
  const result = await buildTargetRequest({
    ...minimalPayload,
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'hi there' },
      { type: 'message', role: 'user', content: 'bye' },
    ],
    temperature: 0.4,
    top_p: 0.8,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
  });
  assertEquals(result.target, {
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
      { role: 'user', parts: [{ text: 'bye' }] },
    ],
    generationConfig: {
      maxOutputTokens: 256,
      temperature: 0.4,
      topP: 0.8,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    },
  } satisfies GeminiGenerateContentPayload);
});

test('buildTargetRequest folds instructions and system/developer messages into systemInstruction with later-wins', async () => {
  const base = await buildTargetRequest({ ...minimalPayload, instructions: 'be terse' });
  assertEquals(base.target.systemInstruction, { parts: [{ text: 'be terse' }] });

  // A later system message overwrites the canonical instructions.
  const overridden = await buildTargetRequest({
    ...minimalPayload,
    instructions: 'first',
    input: [
      { type: 'message', role: 'system', content: 'second' },
      { type: 'message', role: 'user', content: 'hi' },
    ],
  });
  assertEquals(overridden.target.systemInstruction, { parts: [{ text: 'second' }] });

  // developer rides the same slot.
  const developer = await buildTargetRequest({
    ...minimalPayload,
    input: [{ type: 'message', role: 'developer', content: 'dev rule' }],
  });
  assertEquals(developer.target.systemInstruction, { parts: [{ text: 'dev rule' }] });
});

test('buildTargetRequest maps data: and https: input images onto inlineData and fileData', async () => {
  const result = await buildTargetRequest({
    ...minimalPayload,
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        { type: 'input_image', image_url: 'https://example.com/cat.jpg', detail: 'auto' },
        { type: 'input_image', image_url: 'https://example.com/no-ext', detail: 'auto' },
      ],
    }],
  });
  assertEquals(result.target.contents, [{
    role: 'user',
    parts: [
      { text: 'what is this' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { fileData: { mimeType: 'image/jpeg', fileUri: 'https://example.com/cat.jpg' } },
      { fileData: { mimeType: 'image/jpeg', fileUri: 'https://example.com/no-ext' } },
    ],
  }]);
});

test('buildTargetRequest drops a file_id-only image part', async () => {
  const result = await buildTargetRequest({
    ...minimalPayload,
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', file_id: 'file_1', detail: 'auto' },
        { type: 'input_text', text: 'still here' },
      ],
    }],
  });
  assertEquals(result.target.contents, [{ role: 'user', parts: [{ text: 'still here' }] }]);
});

test('buildTargetRequest replays reasoning summaries as thought parts and function_call history as functionCall parts', async () => {
  const result = await buildTargetRequest({
    ...minimalPayload,
    input: [
      { type: 'message', role: 'user', content: 'run it' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'trace' }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"found":true}' },
    ],
  });
  // function_call extends the pending assistant turn; the output flushes it.
  assertEquals(result.target.contents![1], {
    role: 'model',
    parts: [
      { text: 'trace', thought: true },
      { functionCall: { id: 'call_1', name: 'lookup', args: { q: 1 } } },
    ],
  });
  assertEquals(result.target.contents![2], {
    role: 'user',
    // String output parses as JSON and passes through unenveloped; only the
    // multimodal branch wraps its text in { result: ... }.
    parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { found: true } } }],
  });
});

test('buildTargetRequest projects custom tools onto wrapped function declarations and unwraps their call history', async () => {
  const result = await buildTargetRequest({
    ...minimalPayload,
    input: [
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'patched' },
    ],
    tools: [{ type: 'custom', name: 'apply_patch', description: 'apply a patch' }],
    tool_choice: { type: 'custom', name: 'apply_patch' },
  });
  assertEquals(result.customToolNames, new Set(['apply_patch']));
  assertEquals(result.target.tools, [{
    functionDeclarations: [{
      name: 'apply_patch',
      description: 'apply a patch',
      parameters: { type: 'object', additionalProperties: false, required: ['input'], properties: { input: { type: 'string' } } },
    }],
  }]);
  assertEquals(result.target.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['apply_patch'] } });
  assertEquals(result.target.contents![0], {
    role: 'model',
    parts: [{ functionCall: { id: 'call_1', name: 'apply_patch', args: { input: '*** Begin Patch' } } }],
  });
  assertEquals(result.target.contents![1], {
    role: 'user',
    parts: [{ functionResponse: { id: 'call_1', name: 'apply_patch', response: 'patched' } }],
  });
});

test('buildTargetRequest maps string tool_choice onto the function-calling modes', async () => {
  const withTools = { ...minimalPayload, tools: [{ type: 'function' as const, name: 'ping', strict: false }] };
  assertEquals((await buildTargetRequest({ ...withTools, tool_choice: 'auto' })).target.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
  assertEquals((await buildTargetRequest({ ...withTools, tool_choice: 'required' })).target.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assertEquals((await buildTargetRequest({ ...withTools, tool_choice: 'none' })).target.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
});

test('buildTargetRequest maps reasoning.effort onto thinkingLevel and extracts json_schema into responseSchema', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
  const result = await buildTargetRequest({
    ...minimalPayload,
    reasoning: { effort: 'high', summary: 'auto' },
    text: { format: { type: 'json_schema', name: 'out', strict: true, schema } },
  });
  assertEquals(result.target.generationConfig, {
    maxOutputTokens: 256,
    thinkingConfig: { thinkingLevel: 'high' },
    responseSchema: schema,
  });
  // json_object has no Gemini slot — no responseSchema key.
  const unshaped = await buildTargetRequest({ ...minimalPayload, text: { format: { type: 'json_object' } } });
  assertEquals('responseSchema' in unshaped.target.generationConfig!, false);
});

test('buildTargetRequest rejects item_reference and web_search_call input items', async () => {
  await assertRejects(() => buildTargetRequest({ ...minimalPayload, input: [{ type: 'item_reference', id: 'msg_1' }] }), Error, 'item_reference');
  await assertRejects(() => buildTargetRequest({ ...minimalPayload, input: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['q'] } }] }), Error, 'web_search_call');
});
