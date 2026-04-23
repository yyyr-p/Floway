import type { ChatCompletionsPayload } from "../../../lib/openai-types.ts";
import { translateChatToResponses } from "../../../lib/translate/chat-to-responses.ts";
import type { ResponsesReasoningEffort } from "../../../lib/reasoning.ts";

export const buildTargetRequest = (
  payload: ChatCompletionsPayload,
  options: { reasoningEffort?: ResponsesReasoningEffort | null } = {},
) => translateChatToResponses(payload, options);
