import type {
  ChatCompletionChunk,
  Delta,
} from "../chat-completions-types.ts";
import type {
  MessagesResponse,
  MessagesStreamEventData,
} from "../messages-types.ts";
import { mapMessagesStopReasonToChatCompletionsFinishReason } from "./messages-to-chat-completions.ts";

interface MessagesToChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export const createMessagesToChatCompletionsStreamState = (): MessagesToChatCompletionsStreamState => ({
  messageId: "",
  model: "",
  created: Math.floor(Date.now() / 1000),
  toolCallIndex: -1,
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

const makeChunk = (
  state: MessagesToChatCompletionsStreamState,
  delta: Delta,
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: state.messageId,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [{
    index: 0,
    delta,
    finish_reason: finishReason,
  }],
});

export const translateMessagesEventToChatCompletionsChunks = (
  event: MessagesStreamEventData,
  state: MessagesToChatCompletionsStreamState,
): ChatCompletionChunk[] | "DONE" => {
  switch (event.type) {
    case "message_start": {
      state.messageId = event.message.id;
      state.model = event.message.model;
      state.inputTokens = event.message.usage.input_tokens;
      state.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
      state.cacheCreationInputTokens =
        event.message.usage.cache_creation_input_tokens ?? 0;
      return [makeChunk(state, { role: "assistant" })];
    }

    case "content_block_start":
      if (event.content_block.type === "redacted_thinking") {
        return [makeChunk(state, { reasoning_opaque: event.content_block.data })];
      }

      if (event.content_block.type !== "tool_use") return [];

      state.toolCallIndex++;
      return [makeChunk(state, {
        tool_calls: [{
          index: state.toolCallIndex,
          id: event.content_block.id,
          type: "function",
          function: {
            name: event.content_block.name,
            arguments: "",
          },
        }],
      })];

    case "content_block_delta":
      switch (event.delta.type) {
        case "thinking_delta":
          return [makeChunk(state, { reasoning_text: event.delta.thinking })];
        case "signature_delta":
          return [makeChunk(state, { reasoning_opaque: event.delta.signature })];
        case "text_delta":
          return [makeChunk(state, { content: event.delta.text })];
        case "input_json_delta":
          return [makeChunk(state, {
            tool_calls: [{
              index: state.toolCallIndex,
              function: { arguments: event.delta.partial_json },
            }],
          })];
        default:
          return [];
      }

    case "content_block_stop":
      return [];

    case "message_delta": {
      const chunk = makeChunk(
        state,
        {},
        mapMessagesStopReasonToChatCompletionsFinishReason(
          event.delta.stop_reason ?? null,
        ),
      );

      if (event.usage) {
        const promptTokens =
          state.inputTokens +
          state.cacheReadInputTokens +
          state.cacheCreationInputTokens;
        const completionTokens = event.usage.output_tokens;

        chunk.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          ...(state.cacheReadInputTokens > 0
            ? {
              prompt_tokens_details: {
                cached_tokens: state.cacheReadInputTokens,
              },
            }
            : {}),
        };
      }

      return [chunk];
    }

    case "message_stop":
      return "DONE";

    case "ping":
    case "error":
      return [];

    default:
      return [];
  }
};
