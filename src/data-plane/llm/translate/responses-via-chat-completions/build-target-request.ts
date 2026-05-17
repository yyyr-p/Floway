import type { ResponsesPayload } from "../../../../lib/responses-types.ts";
import { translateResponsesToChatCompletions } from "./request.ts";

export const buildTargetRequest = (payload: ResponsesPayload) =>
  translateResponsesToChatCompletions(payload);
