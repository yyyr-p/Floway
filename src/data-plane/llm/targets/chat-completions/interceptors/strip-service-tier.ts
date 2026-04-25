import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../../lib/chat-completions-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * Copilot does not expose a compatible `service_tier` control on native or
 * translated Chat Completions handling. Strip it only after planning has
 * committed to the Chat target so source-side behavior and accounting still see
 * the caller's original request.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://platform.openai.com/docs/api-reference/chat/create
 */
export const withServiceTierStripped: TargetInterceptor<
  { payload: ChatCompletionsPayload },
  ChatCompletionResponse
> = async (ctx, run) => {
  const { service_tier: _, ...payload } = ctx.payload;
  ctx.payload = payload;

  return await run();
};
