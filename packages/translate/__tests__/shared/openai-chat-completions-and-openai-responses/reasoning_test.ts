import { expect, test, vi } from 'vitest';

import { hasReasoningPayload, scalarToOpenAIResponsesReasoningItem, toOpenAIChatCompletionsReasoningItem, toOpenAIResponsesReasoningItem, translateOpenAIChatCompletionsReasoningItems } from '../../../src/shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

test('reasoning fallback IDs are generated only when an item needs one', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');

  expect(scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(undefined)).toBeNull();
  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>({
    type: 'reasoning',
    id: 'rs_existing',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toBe('rs_existing');
  expect(random).not.toHaveBeenCalled();

  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toMatch(/^rs_[0-9a-f]{32}$/);
  expect(random).toHaveBeenCalledOnce();
});

test('reasoning item carriers preserve opaque content in both directions', () => {
  const responseItem: OpenAIResponsesInputReasoning = {
    type: 'reasoning',
    id: 'rs_opaque',
    summary: [],
    encrypted_content: 'opaque-upstream-payload',
  };
  const chatItem: OpenAIChatCompletionsReasoningItem = {
    type: 'reasoning',
    id: 'rs_opaque',
    summary: [],
    encrypted_content: 'opaque-upstream-payload',
  };

  expect(toOpenAIChatCompletionsReasoningItem(responseItem)).toEqual(chatItem);
  expect(hasReasoningPayload(chatItem)).toBe(true);
  expect(translateOpenAIChatCompletionsReasoningItems<OpenAIResponsesInputReasoning>([chatItem])).toEqual([responseItem]);
  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(chatItem)).toEqual(responseItem);
});
