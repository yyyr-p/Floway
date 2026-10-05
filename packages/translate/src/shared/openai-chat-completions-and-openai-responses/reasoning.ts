import { klona } from 'klona/json';

import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';
import { type OpenAIResponsesInputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

// OpenAI's Chat Completions spec has no reasoning-text field; upstreams expose
// the same quantity as `reasoning_content` or `reasoning`. Treat both as
// aliases of the gateway's canonical `reasoning_text`, preferring the canonical
// name when an upstream emits more than one.

export interface OpenAIChatCompletionsReasoningDeltaAliases {
  reasoning_text?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}

// Precedence: `reasoning_text` > `reasoning_content` > `reasoning`. Only a
// non-empty string carries reasoning; a `null` field (an upstream filler
// between reasoning and content chunks) is not reasoning.
export const openAIChatCompletionsScalarReasoningText = (delta: OpenAIChatCompletionsReasoningDeltaAliases): string | undefined => {
  if (typeof delta.reasoning_text === 'string' && delta.reasoning_text.length > 0) return delta.reasoning_text;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return delta.reasoning_content;
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) return delta.reasoning;
  return undefined;
};

export type OpenAIChatCompletionsReasoningSourceItem = Extract<OpenAIResponsesInputItem, { type: 'reasoning' }> | OpenAIResponsesOutputReasoning;

export interface OpenAIChatCompletionsReasoningProjection {
  items: OpenAIChatCompletionsReasoningItem[];
  text?: string;
}

export const createOpenAIChatCompletionsReasoningProjection = (): OpenAIChatCompletionsReasoningProjection => ({
  items: [],
});

export const toOpenAIChatCompletionsReasoningItem = (item: OpenAIChatCompletionsReasoningSourceItem): OpenAIChatCompletionsReasoningItem => ({
  type: 'reasoning',
  id: item.id,
  summary: item.summary,
  ...(item.encrypted_content !== undefined ? { encrypted_content: item.encrypted_content } : {}),
});

export const addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection = (projection: OpenAIChatCompletionsReasoningProjection, item: OpenAIChatCompletionsReasoningSourceItem): void => {
  projection.items.push({ ...toOpenAIChatCompletionsReasoningItem(item), summary: klona(item.summary) });

  const text = item.summary.map(part => part.text).join('');
  if (projection.text === undefined && text) projection.text = text;
};

export const openaiChatCompletionsReasoningProjectionFields = (projection: OpenAIChatCompletionsReasoningProjection) => ({
  ...(projection.text !== undefined ? { reasoning_text: projection.text } : {}),
  ...(projection.items.length > 0 ? { reasoning_items: projection.items } : {}),
});

// Synthesis never mints an id. An input reasoning item's id is only the name
// an upstream filed its signed `encrypted_content` under; a fresh id names a
// row no upstream ever created, and a native Responses upstream answers an
// id-bearing input item with a server-side lookup that fails the whole turn
// ("Item with id 'rs_...' not found. Items are not persisted when `store` is
// set to false."). Official Codex strips ids from every input item in exactly
// that stateless case, so Chat-history reasoning crosses back as id-less
// plain history. An id already present is an upstream-issued value and rides
// verbatim.
// https://github.com/openai/codex/blob/8c41ed33ce3e39460e7b13b14c35e0c39bb5980d/codex-rs/core/src/client.rs#L911-L921
export const toOpenAIResponsesReasoningItem = <T extends OpenAIResponsesReasoningItem>(item: OpenAIChatCompletionsReasoningItem): T =>
  ({
    type: 'reasoning',
    ...(item.id !== undefined ? { id: item.id } : {}),
    summary: item.summary ?? [],
    ...(item.encrypted_content !== undefined ? { encrypted_content: item.encrypted_content } : {}),
  } as T);

export const scalarToOpenAIResponsesReasoningItem = <T extends OpenAIResponsesReasoningItem>(reasoningText: string | null | undefined): T | null => {
  if (!reasoningText) return null;

  return {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: reasoningText }],
  } as T;
};

export const hasReasoningPayload = (item: OpenAIChatCompletionsReasoningItem): boolean =>
  item.summary?.some(part => part.text) === true || item.encrypted_content !== undefined;

export const translateOpenAIChatCompletionsReasoningItems = <T extends OpenAIResponsesReasoningItem>(reasoningItems: OpenAIChatCompletionsReasoningItem[] | null | undefined): T[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility extension for
  // carrying OpenAI Responses reasoning summaries and encrypted content through OpenAI Chat Completions.
  // Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const translated = reasoningItems.flatMap(item => (hasReasoningPayload(item)
    ? [{ ...toOpenAIResponsesReasoningItem<T>(item), summary: klona(item.summary ?? []) } as T]
    : []));
  return translated.length > 0 ? translated : null;
};
