import type { ChatCompletionsPayload } from "../../../../lib/openai-types.ts";
import { normalizeModelName } from "../../../../lib/model-name.ts";

export const normalizeChatRequest = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => {
  if (typeof payload.model === "string") {
    payload.model = normalizeModelName(payload.model);
  }
  return payload;
};
