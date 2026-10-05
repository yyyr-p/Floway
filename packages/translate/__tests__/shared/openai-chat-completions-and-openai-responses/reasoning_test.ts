import { expect, test, vi } from 'vitest';

import { scalarToOpenAIResponsesReasoningItem, toOpenAIResponsesReasoningItem } from '../../../src/shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import type { OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

test('synthesis never mints a reasoning id and an upstream-issued id rides verbatim', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');

  expect(scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(undefined)).toBeNull();

  // A minted id names a row no upstream ever stored; a native Responses
  // upstream resolves an id-bearing input item by server-side lookup that
  // fails the whole turn ("Item with id 'rs_...' not found."), so a
  // synthesized item crosses back with no id at all. Official Codex strips
  // ids from every input item in the same stateless case.
  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  })).toEqual({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  expect(scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>('trace')).toEqual({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  expect(random).not.toHaveBeenCalled();

  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>({
    type: 'reasoning',
    id: 'rs_existing',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toBe('rs_existing');
});
