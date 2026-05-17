import type { MessagesPayload } from "../../../../lib/messages-types.ts";
import type { ResponsesPayload } from "../../../../lib/responses-types.ts";
import { translateResponsesToMessages } from "./request.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";

export const buildTargetRequest = (
  payload: ResponsesPayload,
  capabilities: ModelCapabilities,
): Promise<MessagesPayload> =>
  translateResponsesToMessages(payload, {
    fallbackMaxOutputTokens: capabilities.maxOutputTokens,
  });
