import type { ChatCompletionsPayload } from "../../../lib/openai-types.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { probeChatThinkingBudget } from "../../shared/probes/probe-chat-thinking-budget.ts";
import { probeResponsesReasoningEffortForChat } from "../../shared/probes/probe-responses-reasoning-effort.ts";
import type { ChatPlan } from "../../shared/types/plan.ts";

const hasVision = (payload: ChatCompletionsPayload): boolean =>
  payload.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url")
  );

export const planChatRequest = async (
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<ChatPlan> => {
  const capabilities = await getModelCapabilities(
    payload.model,
    githubToken,
    accountType,
  );
  const wantsStream = payload.stream === true;
  const fetchOptions = { vision: hasVision(payload) };

  if (capabilities.supportsMessages) {
    return {
      source: "chat-completions",
      target: "messages",
      wantsStream,
      fetchOptions,
    };
  }

  if (payload.thinking_budget !== undefined && capabilities.supportsResponses) {
    return {
      source: "chat-completions",
      target: "responses",
      wantsStream,
      fetchOptions,
      reasoningEffort: await probeResponsesReasoningEffort(
        payload,
        githubToken,
        accountType,
      ),
    };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      source: "chat-completions",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
      allowThinkingBudget: await probeThinkingBudget(
        payload,
        githubToken,
        accountType,
      ),
    };
  }

  if (capabilities.supportsResponses) {
    return {
      source: "chat-completions",
      target: "responses",
      wantsStream,
      fetchOptions,
      reasoningEffort: await probeResponsesReasoningEffort(
        payload,
        githubToken,
        accountType,
      ),
    };
  }

  return payload.model.startsWith("claude")
    ? {
      source: "chat-completions",
      target: "messages",
      wantsStream,
      fetchOptions,
    }
    : {
      source: "chat-completions",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
      allowThinkingBudget: await probeThinkingBudget(
        payload,
        githubToken,
        accountType,
      ),
    };
};

const probeResponsesReasoningEffort = async (
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
) => {
  try {
    return await probeResponsesReasoningEffortForChat(
      payload,
      githubToken,
      accountType,
    );
  } catch (error) {
    console.warn("Failed to probe Responses reasoning efforts:", error);
    return null;
  }
};

const probeThinkingBudget = async (
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<boolean> => {
  if (payload.thinking_budget === undefined) return true;

  try {
    return await probeChatThinkingBudget(
      payload.model,
      githubToken,
      accountType,
    );
  } catch (error) {
    console.warn("Failed to probe Chat Completions thinking_budget:", error);
    return false;
  }
};
