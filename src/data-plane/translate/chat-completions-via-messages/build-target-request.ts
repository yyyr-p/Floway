import type { ChatCompletionsPayload } from "../../../lib/openai-types.ts";
import {
  fetchRemoteImage,
  translateChatToMessages,
} from "../../../lib/translate/chat-to-messages.ts";

export const buildTargetRequest = async (
  payload: ChatCompletionsPayload,
) =>
  await translateChatToMessages(payload, {
    loadRemoteImage: fetchRemoteImage,
  });
