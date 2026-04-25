import type { ChatCompletionResponse } from "../../../../../lib/chat-completions-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToChatCompletionsInput } from "../emit.ts";
import { withClaudeChoiceShapeFixed } from "./fix-claude-choice-shape.ts";
import { withUsageStreamOptionsIncluded } from "./include-usage-stream-options.ts";
import { withServiceTierStripped } from "./strip-service-tier.ts";

export const chatCompletionsTargetInterceptors = [
  withServiceTierStripped,
  withUsageStreamOptionsIncluded,
  withClaudeChoiceShapeFixed,
] satisfies readonly TargetInterceptor<
  EmitToChatCompletionsInput,
  ChatCompletionResponse
>[];
