import type { AnthropicMessagesPayload } from "../../../lib/anthropic-types.ts";
import { translateAnthropicToResponses } from "../../../lib/translate/responses.ts";
import type { ResponsesReasoningEffort } from "../../../lib/reasoning.ts";

export const buildTargetRequest = (
  payload: AnthropicMessagesPayload,
  options: { reasoningEffort?: ResponsesReasoningEffort | null } = {},
) => translateAnthropicToResponses(payload, options);
