import type { AnthropicResponse } from "../../../../lib/anthropic-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withMissingMaxTokensFilled } from "./fill-missing-max-tokens.ts";
import { withAnthropicBetaFixed } from "./fix-anthropic-beta.ts";
import { withInvalidThinkingBlocksFiltered } from "./filter-invalid-thinking-blocks.ts";
import { withDoneSentinelStripped } from "./strip-done-sentinel.ts";
import { withServiceTierStripped } from "./strip-service-tier.ts";

export const messagesTargetInterceptors = [
  withMissingMaxTokensFilled,
  withInvalidThinkingBlocksFiltered,
  withAnthropicBetaFixed,
  withServiceTierStripped,
  withDoneSentinelStripped,
] satisfies readonly TargetInterceptor<
  EmitToMessagesInput,
  AnthropicResponse
>[];
