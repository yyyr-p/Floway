import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "../../../lib/anthropic-types.ts";
import type { ResponsesResult } from "../../../lib/responses-types.ts";
import { translateAnthropicToResponsesResult } from "../../../lib/translate/responses.ts";
import {
  createAnthropicToResponsesStreamState,
  translateAnthropicEventToResponsesEvents,
} from "../../../lib/translate/anthropic-to-responses-stream.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<AnthropicResponse>>,
  responseId: string,
  model: string,
): AsyncGenerator<StreamFrame<ResponsesResult>> {
  const state = createAnthropicToResponsesStreamState(responseId, model);

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateAnthropicToResponsesResult(frame.data));
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

    for (
      const translated of translateAnthropicEventToResponsesEvents(event, state)
    ) {
      yield sseFrame(JSON.stringify(translated), translated.type);
    }
  }
};
