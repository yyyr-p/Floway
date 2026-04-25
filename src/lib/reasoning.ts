import type { MessagesPayload } from "./messages-types.ts";

export const getMessagesRequestedReasoningEffort = (
  payload: MessagesPayload,
): string | null => {
  // Only explicit effort and disabled thinking map across this boundary because
  // Responses has no exact request-side equivalent for "reasoning enabled, effort
  // unspecified".
  if (payload.output_config?.effort) return payload.output_config.effort;
  if (payload.thinking?.type === "disabled") return "none";
  return null;
};

export const makeResponsesReasoningId = (index: number): string =>
  `rs_${index}`;
