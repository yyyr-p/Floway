import type {
  AnthropicResponse,
  AnthropicStreamState,
} from "../../../lib/anthropic-types.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../../../lib/openai-types.ts";
import { translateChunkToAnthropicEvents } from "../../../lib/translate/openai-stream.ts";
import { translateToAnthropic } from "../../../lib/translate/openai.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): AsyncGenerator<StreamFrame<AnthropicResponse>> {
  const state: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  };

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateToAnthropic(frame.data));
      continue;
    }

    const data = frame.data.trim();
    if (!data || data === "[DONE]") continue;

    let chunk: ChatCompletionChunk;

    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      continue;
    }

    for (const event of translateChunkToAnthropicEvents(chunk, state)) {
      yield sseFrame(JSON.stringify(event), event.type);
    }
  }
};
