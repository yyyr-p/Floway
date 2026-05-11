import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withMissingMaxTokensFilled } from "./fill-missing-max-tokens.ts";
import { withBetaHeaderFixed } from "./fix-beta-header.ts";
import { withInvalidThinkingBlocksFiltered } from "./filter-invalid-thinking-blocks.ts";
import { withThinkingDisplayPromoted } from "./promote-thinking-display.ts";
import { withDoneSentinelStripped } from "./strip-done-sentinel.ts";
import { withEagerInputStreamingStripped } from "./strip-eager-input-streaming.ts";
import { withServiceTierStripped } from "./strip-service-tier.ts";

export const messagesTargetInterceptors = [
  withMissingMaxTokensFilled,
  withInvalidThinkingBlocksFiltered,
  withThinkingDisplayPromoted,
  withBetaHeaderFixed,
  withServiceTierStripped,
  withEagerInputStreamingStripped,
  withDoneSentinelStripped,
] satisfies readonly TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[];
