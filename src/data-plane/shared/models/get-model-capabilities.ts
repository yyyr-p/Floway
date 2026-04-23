import { findModel } from "../../../lib/models-cache.ts";

interface ModelCapabilitiesModel {
  id: string;
  supported_endpoints?: string[];
  capabilities?: {
    supports?: {
      adaptive_thinking?: boolean;
    };
  };
}

export interface ModelCapabilities {
  model?: ModelCapabilitiesModel;
  supportsMessages: boolean;
  supportsResponses: boolean;
  supportsChatCompletions: boolean;
  supportsAdaptiveThinking: boolean;
}

export const getModelCapabilities = async (
  modelId: string,
  githubToken: string,
  accountType: string,
): Promise<ModelCapabilities> => {
  const model = await findModel(modelId, githubToken, accountType);
  const supportedEndpoints = model?.supported_endpoints ?? [];

  return {
    model,
    supportsMessages: supportedEndpoints.includes("/v1/messages"),
    supportsResponses: supportedEndpoints.includes("/responses"),
    supportsChatCompletions: supportedEndpoints.includes("/chat/completions"),
    supportsAdaptiveThinking:
      model?.capabilities?.supports?.adaptive_thinking === true,
  };
};
