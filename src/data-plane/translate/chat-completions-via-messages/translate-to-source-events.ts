import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "../../../lib/anthropic-types.ts";
import type { ChatCompletionResponse } from "../../../lib/openai-types.ts";
import { translateMessagesToChatCompletion } from "../../../lib/translate/messages-to-chat.ts";
import {
  createChatStreamState,
  translateAnthropicEventToChatChunks,
} from "../../../lib/translate/messages-to-chat-stream.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<AnthropicResponse>>,
): AsyncGenerator<StreamFrame<ChatCompletionResponse>> {
  const state = createChatStreamState();

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateMessagesToChatCompletion(frame.data));
      continue;
    }

    const data = frame.data.trim();
    if (!data || data === "[DONE]") continue;

    let event: AnthropicStreamEventData;

    try {
      event = JSON.parse(data) as AnthropicStreamEventData;
    } catch {
      continue;
    }

    const translated = translateAnthropicEventToChatChunks(event, state);

    if (translated === "DONE") {
      yield sseFrame("[DONE]");
      continue;
    }

    for (const chunk of translated) {
      yield sseFrame(JSON.stringify(chunk));
    }
  }
};
