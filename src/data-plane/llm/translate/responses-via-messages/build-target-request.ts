import type { MessagesTargetPayload } from "../../../../lib/messages-types.ts";
import type { ResponsesPayload } from "../../../../lib/responses-types.ts";
import { translateResponsesToMessages } from "../../../../lib/translate/responses-to-messages.ts";

export const buildTargetRequest = (
  payload: ResponsesPayload,
): Promise<MessagesTargetPayload> => translateResponsesToMessages(payload);
