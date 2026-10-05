import { test } from 'vitest';

import { anthropicMessagesAttempt } from '../../../../src/data-plane/chat/anthropic-messages/attempt.ts';
import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsDelta, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { type ModelCandidate, directFetcher, type ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

interface Scenario {
  name: string;
  deltas: OpenAIChatCompletionsDelta[];
  expectedThinking: string;
  expectedText: string;
  expectedResponsesSummary?: string;
}

const scenarios: Scenario[] = [
  {
    name: 'a thinking token and summary share one chunk with text',
    deltas: [{
      reasoning_content: 't',
      reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] }],
      content: 'answer',
    }],
    expectedThinking: 't',
    expectedText: 'answer',
    expectedResponsesSummary: 'summary',
  },
  {
    name: 'body starts before late reasoning and a long newline-prefixed body',
    deltas: [
      { content: 'early body' },
      { reasoning_content: 'truncated thought' },
      { content: `\n${'final body '.repeat(80)}` },
    ],
    expectedThinking: 'truncated thought',
    expectedText: `early body\n${'final body '.repeat(80)}`,
  },
  {
    name: 'one token per line remains separated and ordered within each channel',
    deltas: [
      { reasoning_content: 'think 1\n' },
      { content: 'body 1\n' },
      { reasoning_content: 'think 2\n' },
      { content: 'body 2\n' },
      { reasoning_content: 'think 3' },
      { content: 'body 3' },
    ],
    expectedThinking: 'think 1\nthink 2\nthink 3',
    expectedText: 'body 1\nbody 2\nbody 3',
  },
];

const makeUpstreamEvents = (deltas: readonly OpenAIChatCompletionsDelta[]): OpenAIChatCompletionsStreamEvent[] => [
  ...deltas.map(delta => ({
    id: 'chatcmpl_reasoning_order',
    object: 'chat.completion.chunk' as const,
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: null }],
  })),
  {
    id: 'chatcmpl_reasoning_order',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const protocolFrames = async function* <T>(events: readonly T[]): AsyncGenerator<ProtocolFrame<T>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (events: readonly OpenAIChatCompletionsStreamEvent[]): ModelCandidate => {
  const upstream = 'up_reasoning_order_test';
  const endpoints = { openaiChatCompletions: {} };
  const provider = stubProvider({
    callOpenAIChatCompletions: async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
      ok: true,
      events: protocolFrames(events),
      modelKey: 'test-model',
      headers: new Headers(),
    }),
  });
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: provider,
    },
    model: stubInternalModel({
      endpoints,
      providerModels: { [upstream]: stubProviderModel({ endpoints }) },
    }, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async <T>(frames: AsyncIterable<ProtocolFrame<T>>): Promise<T[]> => {
  const events: T[] = [];
  for await (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }
  return events;
};

const installRepo = (): void => initRepo(new InMemoryRepo());

const runAnthropic = async (scenario: Scenario, stream: boolean): Promise<AnthropicMessagesStreamEvent[]> => {
  const result = await anthropicMessagesAttempt.generate({
    payload: {
      model: 'test-model',
      max_tokens: 4096,
      stream,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'hello' }],
    },
    ctx: mockChatGatewayCtx({ apiKeyId: `messages-${scenario.name}-${stream}`, wantsStream: stream }),
    candidate: makeCandidate(makeUpstreamEvents(scenario.deltas)),
    headers: new Headers(),
    anthropicBeta: [],
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  return await collectEvents(result.events);
};

const runResponses = async (scenario: Scenario, stream: boolean): Promise<OpenAIResponsesStreamEvent[]> => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'test-model',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    stream,
    reasoning: { effort: 'high', summary: 'detailed' },
  };
  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: mockChatGatewayCtx({ apiKeyId: `responses-${scenario.name}-${stream}`, wantsStream: stream }),
    candidate: makeCandidate(makeUpstreamEvents(scenario.deltas)),
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  return await collectEvents(result.events);
};

for (const scenario of scenarios) {
  for (const stream of [true, false]) {
    test(`Anthropic Messages via Chat Completions emits reasoning before text: ${scenario.name} (stream=${stream})`, async () => {
      installRepo();
      const events = await runAnthropic(scenario, stream);
      const blocks = events.filter(event => event.type === 'content_block_start');
      assertEquals(blocks.map(event => event.content_block.type), ['thinking', 'text']);
      const deltas = events.filter(event => event.type === 'content_block_delta');
      assert(deltas[0]?.delta.type === 'thinking_delta');
      assertEquals(deltas.flatMap(event => event.delta.type === 'thinking_delta' ? [event.delta.thinking] : []).join(''), scenario.expectedThinking);
      assertEquals(deltas.flatMap(event => event.delta.type === 'text_delta' ? [event.delta.text] : []).join(''), scenario.expectedText);
    });

    test(`OpenAI Responses via Chat Completions emits reasoning before text: ${scenario.name} (stream=${stream})`, async () => {
      installRepo();
      const events = await runResponses(scenario, stream);
      const addedItems = events.filter(event => event.type === 'response.output_item.added');
      assertEquals(addedItems.map(event => event.item.type), ['reasoning', 'message']);
      const completed = events.find(event => event.type === 'response.completed');
      assert(completed?.type === 'response.completed');
      assertEquals(completed.response.output.map(item => item.type), ['reasoning', 'message']);
      assertEquals(completed.response.output_text, scenario.expectedText);
      if (scenario.expectedResponsesSummary !== undefined) {
        const reasoning = completed.response.output[0];
        assert(reasoning?.type === 'reasoning');
        assertEquals(reasoning.summary.map(part => part.text).join(''), scenario.expectedResponsesSummary);
      }
    });
  }
}
