import type { MessagesPayload } from "../../../../lib/messages-types.ts";
import { translateMessagesToResponses } from "./request.ts";

export const buildTargetRequest = (payload: MessagesPayload) =>
  translateMessagesToResponses(payload);
