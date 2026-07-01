import { describe, expect, test } from 'vitest';

import {
  createAgentTranslator,
  isComposerModel,
  visibleComposerContentFromThinking,
  composerReasoningRemainder,
} from './agent-translate.ts';
import type { AgentStreamChunk, ExecRequest } from './proto/index.ts';

const mk = (model: string) => createAgentTranslator({ id: 'chatcmpl-1', model, created: 100 });

const deltaOf = (evs: ReturnType<ReturnType<typeof createAgentTranslator>['translate']>[number]) => evs.choices[0]!.delta;
const finishOf = (evs: ReturnType<ReturnType<typeof createAgentTranslator>['finalize']>[number]) => evs.choices[0]!.finish_reason;

describe('isComposerModel', () => {
  test.each([
    ['composer-2.5', true],
    ['composer', true],
    ['cursor/composer-2.5', true],
    ['gpt-4o', false],
    ['claude-3.7-sonnet', false],
    ['', false],
  ])('%s → %s', (model, expected) => {
    expect(isComposerModel(model)).toBe(expected);
  });
});

describe('visibleComposerContentFromThinking', () => {
  test('returns "" before the sentinel arrives', () => {
    expect(visibleComposerContentFromThinking('chain of thought...')).toBe('');
  });
  test('returns the suffix after the last sentinel', () => {
    expect(visibleComposerContentFromThinking('cot part</think>visible reply')).toBe('visible reply');
  });
  test('strips the <｜final｜> open marker', () => {
    expect(visibleComposerContentFromThinking('cot</think><｜final｜>real answer')).toBe('real answer');
  });
  test('strips ASCII <|final|> markers', () => {
    expect(visibleComposerContentFromThinking('cot</think><|final|>real<|/final|>')).toBe('real');
  });
  test('holds back a partial open marker', () => {
    // Only a fragment of the marker arrived — must not leak as content yet.
    expect(visibleComposerContentFromThinking('cot</think><｜fi')).toBe('');
  });
});

describe('composerReasoningRemainder', () => {
  test('null before sentinel', () => {
    expect(composerReasoningRemainder('thinking...')).toBeNull();
  });
  test('prefix before sentinel after it arrives', () => {
    expect(composerReasoningRemainder('the cot</think>the reply')).toBe('the cot');
  });
});

describe('createAgentTranslator — text', () => {
  test('emits content with role on the first chunk', () => {
    const t = mk('gpt-4o');
    const evs = t.translate({ type: 'text', content: 'hi' });
    expect(evs).toHaveLength(1);
    expect(deltaOf(evs[0]!)).toEqual({ role: 'assistant', content: 'hi' });
    expect(evs[0]!.choices[0]!.finish_reason).toBeNull();
  });

  test('subsequent text chunks omit role', () => {
    const t = mk('gpt-4o');
    t.translate({ type: 'text', content: 'a' });
    const evs = t.translate({ type: 'text', content: 'b' });
    expect(deltaOf(evs[0]!)).toEqual({ content: 'b' });
  });

  test('kv_blob_assistant maps to content', () => {
    const t = mk('gpt-4o');
    const evs = t.translate({ type: 'kv_blob_assistant', blobContent: 'blob reply' });
    expect(deltaOf(evs[0]!)).toEqual({ role: 'assistant', content: 'blob reply' });
  });
});

describe('createAgentTranslator — thinking', () => {
  test('non-composer maps thinking to reasoning_text', () => {
    const t = mk('claude-3.7-sonnet');
    const evs = t.translate({ type: 'thinking', content: 'reasoning...' });
    expect(deltaOf(evs[0]!)).toEqual({ role: 'assistant', reasoning_text: 'reasoning...' });
  });

  test('composer hides cot and surfaces visible suffix incrementally', () => {
    const t = mk('composer-2.5');
    // Before sentinel: nothing visible yet.
    expect(t.translate({ type: 'thinking', content: 'private cot' })).toEqual([]);
    // Sentinel arrives with the visible reply.
    const evs = t.translate({ type: 'thinking', content: '</think>hello world' });
    expect(deltaOf(evs[0]!).content).toBe('hello world');
  });

  test('composer emits only the incremental tail on subsequent chunks', () => {
    const t = mk('composer-2.5');
    t.translate({ type: 'thinking', content: 'cot</think>hello' });
    const evs = t.translate({ type: 'thinking', content: ' world' });
    expect(deltaOf(evs[0]!).content).toBe(' world');
  });
});

describe('createAgentTranslator — tool calls', () => {
  test('tool_call_started emits an indexed tool_calls delta', () => {
    const t = mk('gpt-4o');
    const evs = t.translate({
      type: 'tool_call_started',
      toolCall: { callId: 'c1', modelCallId: 'm1', toolType: 'shell_tool_call', name: 'bash', arguments: '' },
    });
    expect(deltaOf(evs[0]!).tool_calls?.[0]).toEqual({
      index: 0,
      id: 'c1',
      type: 'function',
      function: { name: 'bash' },
    });
  });

  test('partial_tool_call appends arguments to the current index', () => {
    const t = mk('gpt-4o');
    t.translate({ type: 'tool_call_started', toolCall: { callId: 'c1', modelCallId: 'm', toolType: 'x', name: 'search', arguments: '' } });
    const evs = t.translate({ type: 'partial_tool_call', partialArgs: '{"q":"x"' });
    expect(deltaOf(evs[0]!).tool_calls?.[0]).toEqual({ index: 0, function: { arguments: '{"q":"x"' } });
  });

  test('exec_request mcp becomes a tool_calls delta with toolName + JSON args', () => {
    const t = mk('gpt-4o');
    const execRequest: Extract<ExecRequest, { type: 'mcp' }> = {
      type: 'mcp',
      id: 1,
      execId: 'e1',
      name: 'cursor-tools-search',
      args: { q: 'x', n: 3 },
      toolCallId: 'call_1',
      providerIdentifier: 'cursor-tools',
      toolName: 'search',
    };
    const evs = t.translate({ type: 'exec_request', execRequest });
    expect(deltaOf(evs[0]!).tool_calls?.[0]).toEqual({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'search', arguments: JSON.stringify({ q: 'x', n: 3 }) },
    });
  });

  test('exec_request built-in tools are not translated', () => {
    const t = mk('gpt-4o');
    const evs = t.translate({ type: 'exec_request', execRequest: { type: 'shell', id: 1, command: 'ls', cwd: '/' } });
    expect(evs).toEqual([]);
  });
});

describe('createAgentTranslator.finalize', () => {
  test('emits stop then a zero-usage frame when no tool calls were produced', () => {
    const t = mk('gpt-4o');
    t.translate({ type: 'text', content: 'hi' });
    const fin = t.finalize();
    expect(fin).toHaveLength(2);
    expect(finishOf(fin[0]!)).toBe('stop');
    expect(deltaOf(fin[0]!)).toEqual({});
    // The trailing usage frame carries empty choices + an all-zero usage block
    // (cursor reports no per-request tokens; this only gets the request counted).
    expect(fin[1]!.choices).toEqual([]);
    expect(fin[1]!.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  test('emits tool_calls finish_reason after an mcp exec', () => {
    const t = mk('gpt-4o');
    t.translate({
      type: 'exec_request',
      execRequest: { type: 'mcp', id: 1, name: 'x', args: {}, toolCallId: 'c1', providerIdentifier: 'p', toolName: 'x' },
    });
    expect(finishOf(t.finalize()[0]!)).toBe('tool_calls');
  });

  test('is idempotent', () => {
    const t = mk('gpt-4o');
    t.finalize();
    expect(t.finalize()).toEqual([]);
  });
});

describe('createAgentTranslator — passthrough chunks', () => {
  test('checkpoint/heartbeat/interaction_query/exec_server_abort yield nothing', () => {
    const t = mk('gpt-4o');
    const chunks: AgentStreamChunk[] = [
      { type: 'checkpoint' },
      { type: 'heartbeat' },
      { type: 'interaction_query', queryId: 1, queryType: 'web_search' },
      { type: 'exec_server_abort' },
    ];
    for (const c of chunks) expect(t.translate(c)).toEqual([]);
  });
});
