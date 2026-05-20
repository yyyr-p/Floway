import { getRepo } from "../../repo/index.ts";
import { createCopilotProvider } from "./copilot/provider.ts";
import { endpointsIncludeLlmGeneration } from "./endpoints.ts";
import { createOpenAiProvider } from "./openai/provider.ts";
import type { Model, ModelEndpoint, ModelProviderInstance } from "./types.ts";

interface ProviderModelsResult {
  models: Model[];
  sawSuccess: boolean;
  lastError: unknown;
}

export const listModelProviders = async (): Promise<
  ModelProviderInstance[]
> => {
  const providers: ModelProviderInstance[] = [];

  const accounts = await getRepo().github.listAccounts();
  for (const account of accounts) {
    providers.push(await createCopilotProvider(account));
  }

  const customConfigs = await getRepo().upstreamConfigs.list();
  for (const config of customConfigs) {
    if (!config.enabled) continue;
    providers.push(createOpenAiProvider(config));
  }

  return providers;
};

const unionEndpoints = (
  a: readonly ModelEndpoint[],
  b: readonly ModelEndpoint[],
): ModelEndpoint[] => {
  const result = [...a];
  for (const endpoint of b) {
    if (!result.includes(endpoint)) result.push(endpoint);
  }
  return result;
};

const collectProviderModels = async (
  providers: readonly ModelProviderInstance[],
): Promise<ProviderModelsResult> => {
  const byId = new Map<string, Model>();
  let sawSuccess = false;
  let lastError: unknown = null;

  for (const instance of providers) {
    try {
      const providedModels = await instance.provider.getProvidedModels();
      sawSuccess = true;
      for (const upstreamModel of providedModels) {
        if (!upstreamModel.id) continue;
        const {
          providerData: _providerData,
          supportedEndpoints: upstreamSupportedEndpoints,
          ...modelInfo
        } = upstreamModel;
        const existing = byId.get(upstreamModel.id);
        if (!existing) {
          byId.set(upstreamModel.id, {
            ...modelInfo,
            supportedEndpoints: [...upstreamSupportedEndpoints],
            supports_generation: endpointsIncludeLlmGeneration(
              upstreamSupportedEndpoints,
            ),
            providers: [{
              upstream: instance.upstream,
              provider: instance.provider,
              upstreamModel,
              enabledFixes: instance.enabledFixes,
              sourceInterceptors: instance.sourceInterceptors,
              targetInterceptors: instance.targetInterceptors,
            }],
          });
          continue;
        }

        // Known limitation for this refactor: when multiple providers expose
        // the same public model id, the first provider's metadata remains the
        // public /models metadata. Runtime execution still uses the selected
        // provider's own UpstreamModel, so capability-sensitive calls do not
        // depend on this merged view being perfectly representative.
        byId.set(upstreamModel.id, {
          ...existing,
          supportedEndpoints: unionEndpoints(
            existing.supportedEndpoints,
            upstreamSupportedEndpoints,
          ),
          supports_generation: endpointsIncludeLlmGeneration(
            unionEndpoints(
              existing.supportedEndpoints,
              upstreamSupportedEndpoints,
            ),
          ),
          providers: [...existing.providers, {
            upstream: instance.upstream,
            provider: instance.provider,
            upstreamModel,
            enabledFixes: instance.enabledFixes,
            sourceInterceptors: instance.sourceInterceptors,
            targetInterceptors: instance.targetInterceptors,
          }],
        });
      }
    } catch (error) {
      lastError = error;
    }
  }

  return { models: [...byId.values()], sawSuccess, lastError };
};

const modelWithProviderSet = (
  model: Model,
  providers: ReadonlySet<ModelProviderInstance>,
): Model => {
  const bindings = model.providers.filter((binding) =>
    [...providers].some((instance) =>
      instance.upstream === binding.upstream &&
      instance.provider === binding.provider
    )
  );
  const supportedEndpoints = bindings.reduce<ModelEndpoint[]>(
    (endpoints, binding) =>
      unionEndpoints(endpoints, binding.upstreamModel.supportedEndpoints),
    [],
  );

  return {
    ...model,
    supportedEndpoints,
    supports_generation: endpointsIncludeLlmGeneration(supportedEndpoints),
    providers: bindings,
  };
};

export const getModels = async (): Promise<Model[]> => {
  const providers = await listModelProviders();
  if (providers.length === 0) {
    throw new Error(
      "No upstream provider configured — connect GitHub Copilot or add a custom upstream in the dashboard",
    );
  }

  const { models, sawSuccess, lastError } = await collectProviderModels(
    providers,
  );

  if (sawSuccess) return models;
  if (lastError) throw lastError;
  return [];
};

export interface ModelResolution {
  id: string;
  model?: Model;
}

const resolveProviderAlias = (
  providers: readonly ModelProviderInstance[],
  byId: ReadonlyMap<string, Model>,
  modelId: string,
): Model | undefined => {
  let resolved: Model | undefined;
  const providersForAlias = new Set<ModelProviderInstance>();

  for (const instance of providers) {
    const aliasTarget = instance.resolveRequestedModelId?.(modelId);
    if (!aliasTarget || aliasTarget === modelId) continue;

    const model = byId.get(aliasTarget);
    if (!model) continue;
    if (resolved && resolved.id !== model.id) continue;

    const providerHasModel = model.providers.some((binding) =>
      binding.upstream === instance.upstream &&
      binding.provider === instance.provider
    );
    if (!providerHasModel) continue;

    resolved = model;
    providersForAlias.add(instance);
  }

  if (!resolved) return undefined;
  return modelWithProviderSet(resolved, providersForAlias);
};

export const resolveModelForRequest = async (
  modelId: string,
): Promise<ModelResolution> => {
  const providers = await listModelProviders();
  if (providers.length === 0) {
    throw new Error(
      "No upstream provider configured — connect GitHub Copilot or add a custom upstream in the dashboard",
    );
  }

  const { models, lastError } = await collectProviderModels(providers);
  const byId = new Map(models.map((model) => [model.id, model]));

  const exact = byId.get(modelId);
  if (exact) return { id: exact.id, model: exact };

  const alias = resolveProviderAlias(providers, byId, modelId);
  if (alias) return { id: alias.id, model: alias };

  if (lastError) throw lastError;

  return { id: modelId };
};
