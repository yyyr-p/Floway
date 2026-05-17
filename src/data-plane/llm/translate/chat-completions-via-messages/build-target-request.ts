import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import type { MessagesPayload } from "../../../../lib/messages-types.ts";
import { fetchRemoteImage } from "../shared/remote-images.ts";
import { translateChatCompletionsToMessages } from "./request.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";

export const buildTargetRequest = async (
  payload: ChatCompletionsPayload,
  capabilities: ModelCapabilities,
): Promise<MessagesPayload> =>
  await translateChatCompletionsToMessages(payload, {
    loadRemoteImage: fetchRemoteImage,
    fallbackMaxOutputTokens: capabilities.maxOutputTokens,
  });
