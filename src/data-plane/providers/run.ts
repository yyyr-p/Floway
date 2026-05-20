import type { Model, ModelProviderBinding } from "./types.ts";

type LastFailure<T> = { type: "result"; result: T };
export interface ProviderSkip<T> {
  type: "provider-skip";
  result: T;
}

export const skipProvider = <T>(result: T): ProviderSkip<T> => ({
  type: "provider-skip",
  result,
});

const isProviderSkip = <T>(
  result: T | ProviderSkip<T>,
): result is ProviderSkip<T> =>
  typeof result === "object" && result !== null &&
  (result as { type?: unknown }).type === "provider-skip";

export const runOnModel = async <T>(
  model: Model,
  run: (binding: ModelProviderBinding) => Promise<T | ProviderSkip<T>>,
): Promise<T> => {
  let lastSkippedProvider: LastFailure<T> | null = null;

  for (const binding of model.providers) {
    const result = await run(binding);

    if (isProviderSkip(result)) {
      lastSkippedProvider = { type: "result", result: result.result };
      continue;
    }

    return result;
  }

  if (lastSkippedProvider?.type === "result") return lastSkippedProvider.result;

  throw new Error(`No provider is eligible for model ${model.id}`);
};
