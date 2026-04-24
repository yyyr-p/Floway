import type { ChatCompletionChunk } from "../chat-completions-types.ts";
import {
  MESSAGES_THINKING_PLACEHOLDER,
  type MessagesStreamEventData,
} from "../messages-types.ts";
import {
  mapChatCompletionsFinishReasonToMessagesStopReason,
  mapChatCompletionsUsageToMessagesUsage,
  toMessagesId,
} from "./chat-completions-to-messages.ts";
import { checkWhitespaceOverflow } from "./utils.ts";

interface ChatCompletionsToMessagesStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  contentBlockOpen: boolean;
  toolCalls: Record<number, {
    id: string;
    name: string;
    messagesBlockIndex: number;
    consecutiveWhitespace: number;
  }>;
  aborted?: boolean;
  thinkingBlockOpen?: boolean;
  thinkingHasContent?: boolean;
  thinkingSignatureSent?: boolean;
  pendingReasoningOpaque?: string;
  usageSent?: boolean;
}

const isToolBlockOpen = (state: ChatCompletionsToMessagesStreamState): boolean =>
  state.contentBlockOpen &&
  Object.values(state.toolCalls).some((toolCall) =>
    toolCall.messagesBlockIndex === state.contentBlockIndex
  );

const closeThinkingBlock = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (!state.thinkingBlockOpen) return;

  if (!state.thinkingSignatureSent) {
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "signature_delta", signature: "" },
    });
  }

  events.push({ type: "content_block_stop", index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.contentBlockOpen = false;
  state.thinkingBlockOpen = false;
  state.thinkingSignatureSent = false;
};

const closeCurrentBlock = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (!state.contentBlockOpen) return;

  events.push({ type: "content_block_stop", index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.contentBlockOpen = false;
};

const handleReasoningDelta = (
  delta: ChatCompletionChunk["choices"][0]["delta"],
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (delta.reasoning_text) {
    if (!state.thinkingBlockOpen) {
      closeCurrentBlock(state, events);
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
      state.contentBlockOpen = true;
      state.thinkingBlockOpen = true;
      state.thinkingHasContent = true;

      if (state.pendingReasoningOpaque) {
        events.push({
          type: "content_block_delta",
          index: state.contentBlockIndex,
          delta: {
            type: "signature_delta",
            signature: state.pendingReasoningOpaque,
          },
        });
        state.thinkingSignatureSent = true;
        state.pendingReasoningOpaque = undefined;
      }
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning_text },
    });
  }

  if (!delta.reasoning_opaque) return;

  if (state.thinkingBlockOpen) {
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "signature_delta", signature: delta.reasoning_opaque },
    });
    state.thinkingSignatureSent = true;
    return;
  }

  state.pendingReasoningOpaque =
    (state.pendingReasoningOpaque ?? "") + delta.reasoning_opaque;
};

const handleContentDelta = (
  content: string,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  closeThinkingBlock(state, events);

  if (isToolBlockOpen(state)) {
    closeCurrentBlock(state, events);
  }

  if (!state.contentBlockOpen) {
    events.push({
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: { type: "text", text: "" },
    });
    state.contentBlockOpen = true;
  }

  events.push({
    type: "content_block_delta",
    index: state.contentBlockIndex,
    delta: { type: "text_delta", text: content },
  });
};

const handleToolCallsDelta = (
  toolCalls: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): boolean => {
  closeThinkingBlock(state, events);

  for (const toolCall of toolCalls) {
    if (toolCall.id && toolCall.function?.name) {
      closeCurrentBlock(state, events);
      const blockIndex = state.contentBlockIndex;
      state.toolCalls[toolCall.index] = {
        id: toolCall.id,
        name: toolCall.function.name,
        messagesBlockIndex: blockIndex,
        consecutiveWhitespace: 0,
      };
      events.push({
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: {},
        },
      });
      state.contentBlockOpen = true;
    }

    if (!toolCall.function?.arguments) continue;

    const toolCallInfo = state.toolCalls[toolCall.index];
    if (!toolCallInfo) continue;

    const whitespace = checkWhitespaceOverflow(
      toolCall.function.arguments,
      toolCallInfo.consecutiveWhitespace,
    );
    toolCallInfo.consecutiveWhitespace = whitespace.count;

    if (whitespace.exceeded) {
      console.warn("Infinite whitespace detected in tool call arguments, aborting stream");
      state.aborted = true;
      closeCurrentBlock(state, events);
      events.push({
        type: "error",
        error: {
          type: "api_error",
          message:
            "Tool call arguments contained excessive whitespace, indicating a degenerate response.",
        },
      });
      return true;
    }

    events.push({
      type: "content_block_delta",
      index: toolCallInfo.messagesBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: toolCall.function.arguments,
      },
    });
  }

  return false;
};

const handleFinishReason = (
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"],
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  closeThinkingBlock(state, events);

  if (state.pendingReasoningOpaque && !state.thinkingHasContent) {
    events.push(
      {
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "thinking_delta",
          thinking: MESSAGES_THINKING_PLACEHOLDER,
        },
      },
      {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "signature_delta",
          signature: state.pendingReasoningOpaque,
        },
      },
      { type: "content_block_stop", index: state.contentBlockIndex },
    );
    state.contentBlockIndex++;
  }

  closeCurrentBlock(state, events);

  if (chunk.usage) state.usageSent = true;

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: mapChatCompletionsFinishReasonToMessagesStopReason(
          finishReason,
        ),
        stop_sequence: null,
      },
      usage: mapChatCompletionsUsageToMessagesUsage(chunk.usage),
    },
    { type: "message_stop" },
  );
};

export const createChatCompletionsToMessagesStreamState = (): ChatCompletionsToMessagesStreamState => ({
  messageStartSent: false,
  contentBlockIndex: 0,
  contentBlockOpen: false,
  toolCalls: {},
});

export const translateChatCompletionsChunkToMessagesEvents = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];

  if (chunk.choices.length === 0) {
    if (!state.aborted && chunk.usage && !state.usageSent) {
      state.usageSent = true;
      events.push({
        type: "message_delta",
        delta: { stop_reason: null, stop_sequence: null },
        usage: mapChatCompletionsUsageToMessagesUsage(chunk.usage),
      });
    }

    return events;
  }

  if (state.aborted) return events;

  const choice = chunk.choices[0];

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: toMessagesId(chunk.id),
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: mapChatCompletionsUsageToMessagesUsage(chunk.usage),
      },
    });
    state.messageStartSent = true;
  }

  handleReasoningDelta(choice.delta, state, events);

  if (choice.delta.content) {
    handleContentDelta(choice.delta.content, state, events);
  }

  if (choice.delta.tool_calls) {
    const aborted = handleToolCallsDelta(choice.delta.tool_calls, state, events);
    if (aborted) return events;
  }

  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state, events);
  }

  return events;
};
