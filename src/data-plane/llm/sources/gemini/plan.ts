import type { GeminiGenerateContentRequest } from "../../../../lib/gemini-types.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import type { ModelResolutionIntent } from "../../shared/models/resolve-model.ts";
import type { GeminiPlan } from "../../shared/types/plan.ts";

const hasVision = (payload: GeminiGenerateContentRequest): boolean =>
  payload.contents?.some((content) =>
    content.parts.some((part) => part.inlineData !== undefined)
  ) === true;

export const geminiModelResolutionIntent = (
  payload: GeminiGenerateContentRequest,
): ModelResolutionIntent => {
  const thinkingConfig = payload.generationConfig?.thinkingConfig;
  if (!thinkingConfig) return {};

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget <= 0) return {};
    if (thinkingConfig.thinkingBudget <= 2048) {
      return { reasoningEffort: "low" };
    }
    if (thinkingConfig.thinkingBudget <= 8192) {
      return { reasoningEffort: "medium" };
    }
    return { reasoningEffort: "high" };
  }

  switch (thinkingConfig.thinkingLevel) {
    case "minimal":
    case "low":
      return { reasoningEffort: "low" };
    case "medium":
      return { reasoningEffort: "medium" };
    case "high":
      return { reasoningEffort: "high" };
    default:
      return {};
  }
};

export const planGeminiRequest = (
  payload: GeminiGenerateContentRequest,
  model: string,
  capabilities: ModelCapabilities,
  wantsStream: boolean,
): GeminiPlan => {
  const fetchOptions = { vision: hasVision(payload) };

  if (capabilities.supportsMessages) {
    return { source: "gemini", target: "messages", wantsStream, fetchOptions };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      source: "gemini",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
    };
  }

  if (capabilities.supportsResponses) {
    return { source: "gemini", target: "responses", wantsStream, fetchOptions };
  }

  return model.startsWith("claude")
    ? { source: "gemini", target: "messages", wantsStream, fetchOptions }
    : {
      source: "gemini",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
    };
};
