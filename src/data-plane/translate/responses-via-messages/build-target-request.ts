import type { ResponsesPayload } from "../../../lib/responses-types.ts";
import { translateResponsesToAnthropicPayload } from "../../../lib/translate/responses.ts";

export const buildTargetRequest = (payload: ResponsesPayload) =>
  translateResponsesToAnthropicPayload(payload);
