import type { MessagesPayload } from "../../../../lib/messages-types.ts";
import { translateMessagesToChatCompletions } from "./request.ts";

export const buildTargetRequest = (payload: MessagesPayload) =>
  translateMessagesToChatCompletions(payload);
