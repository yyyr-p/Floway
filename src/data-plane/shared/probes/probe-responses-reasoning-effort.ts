import {
  selectResponsesReasoningEffortForAnthropic,
  selectResponsesReasoningEffortForChat,
} from "../../../lib/copilot-probes.ts";
import type { AnthropicMessagesPayload } from "../../../lib/anthropic-types.ts";
import type { ChatCompletionsPayload } from "../../../lib/openai-types.ts";

export const probeResponsesReasoningEffortForMessages = async (
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
) =>
  await selectResponsesReasoningEffortForAnthropic(
    payload,
    githubToken,
    accountType,
  );

export const probeResponsesReasoningEffortForChat = async (
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
) =>
  await selectResponsesReasoningEffortForChat(
    payload,
    githubToken,
    accountType,
  );
