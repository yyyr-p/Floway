import { probeChatCompletionsThinkingBudget } from "../../../lib/copilot-probes.ts";

export const probeChatThinkingBudget = async (
  model: string,
  githubToken: string,
  accountType: string,
): Promise<boolean> =>
  await probeChatCompletionsThinkingBudget(model, githubToken, accountType);
