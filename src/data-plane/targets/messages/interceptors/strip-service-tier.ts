import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../../../lib/anthropic-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * `service_tier` is part of Anthropic Messages, but Copilot does not expose
 * a compatible knob on its Anthropic or OpenAI compatibility layers. Strip it
 * only after planning has committed to the native Messages target, so source
 * planning still sees the caller's real request.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/pull/45
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://docs.anthropic.com/en/api/messages
 */
export const withServiceTierStripped: TargetInterceptor<
  { payload: AnthropicMessagesPayload },
  AnthropicResponse
> = async (ctx, run) => {
  const { service_tier: _, ...payload } = ctx.payload;
  ctx.payload = payload;

  return await run();
};
