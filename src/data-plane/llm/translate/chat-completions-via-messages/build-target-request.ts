import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import type { MessagesTargetPayload } from "../../../../lib/messages-types.ts";
import { translateChatCompletionsToMessages } from "../../../../lib/translate/chat-completions-to-messages.ts";
import { fetchRemoteImage } from "../../../../lib/translate/remote-images.ts";

export const buildTargetRequest = async (
  payload: ChatCompletionsPayload,
): Promise<MessagesTargetPayload> =>
  await translateChatCompletionsToMessages(payload, {
    loadRemoteImage: fetchRemoteImage,
  });
