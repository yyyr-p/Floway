import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import { translateChatCompletionsToResponses } from "./request.ts";

export const buildTargetRequest = (payload: ChatCompletionsPayload) =>
  translateChatCompletionsToResponses(payload);
