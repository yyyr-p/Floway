import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../lib/openai-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * `thinking_budget` support on Copilot's native `/chat/completions` is not a
 * stable contract. Planning probes the capability, and this target fix makes
 * the final keep/drop decision immediately before emit so native chat traffic
 * never forwards a field the selected target does not accept.
 *
 * Earlier `copilot-api` work only covered `thinking_budget` on the
 * Messages-to-Chat translation path, not the native `/chat/completions`
 * handler.
 *
 * A later fork independently added the same native-chat capability gate and
 * explicitly drops unsupported `thinking_budget` in its chat handler.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/pull/57
 * - https://github.com/ericc-ch/copilot-api/pull/238
 * - https://github.com/Menci/copilot-gateway/commit/7f759bd349a6365a92e2ea944c930f78ff442d53
 */
export const withThinkingBudgetFixed: TargetInterceptor<
  { payload: ChatCompletionsPayload; allowThinkingBudget: boolean },
  ChatCompletionResponse
> = async (ctx, run) => {
  if (!ctx.allowThinkingBudget) delete ctx.payload.thinking_budget;
  return await run();
};
