import type { UpstreamProviderKind } from '../../repo/types.ts';
import type { ChatCompletionsInterceptor, GeminiInterceptor, MessagesInterceptor, ResponsesInterceptor } from '../llm/interceptors.ts';
import type { ChatCompletionsPayload } from '../shared/protocol/chat-completions.ts';
import type { EmbeddingsPayload } from '../shared/protocol/embeddings.ts';
import type { MessagesPayload } from '../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../shared/protocol/responses.ts';

export type ModelEndpoint = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings';

// Per-model pricing in USD per million tokens, aligned with the sst/models.dev
// `Cost` schema (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Extensions follow that schema's field names (`reasoning`, `input_audio`,
// `output_audio`, etc.) when they are added.
export interface ModelPricing {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

// The internal model shape: what providers produce and what the registry
// stores. Only fields the data plane actually consumes — to expose downstream
// (id, display_name, owned_by, created, limits) or to drive request-time
// decisions (max_output_tokens as the translation fallback). Provider-internal
// raw fields stay inside that provider's own types and projections; nothing
// upstream-shaped leaks onto this neutral type.
//
// `supports_generation` is derived from `upstreamEndpoints` at the producer
// boundary (see endpointsIncludeLlmGeneration).
export interface InternalModel {
  id: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  supports_generation: boolean;
  cost?: ModelPricing;
}

export interface UpstreamModel extends InternalModel {
  upstreamEndpoints: readonly ModelEndpoint[];
  providerData?: unknown;
  enabledFlags: ReadonlySet<string>;
}

export interface ProviderModelRecord {
  upstream: string;
  providerKind: UpstreamProviderKind;
  provider: ModelProvider;
  upstreamModel: UpstreamModel;
  enabledFlags: ReadonlySet<string>;
  sourceInterceptors?: ProviderSourceInterceptors;
  targetInterceptors?: ProviderTargetInterceptors;
}

// upstreamEndpoints describes which endpoints this model is served by on its
// upstream side; it lives on ResolvedModel for planner-only use. The public
// catalog does not expose upstream endpoint identity — the gateway always
// translates between protocols on the data plane, so downstream clients see
// all source endpoints as available for any generation-capable model.
export interface ResolvedModel extends InternalModel {
  upstreamEndpoints: readonly ModelEndpoint[];
  providers: readonly ProviderModelRecord[];
}

export interface ProviderSourceInterceptors {
  messages?: readonly MessagesInterceptor[];
  responses?: readonly ResponsesInterceptor[];
  chatCompletions?: readonly ChatCompletionsInterceptor[];
  gemini?: readonly GeminiInterceptor[];
}

export interface ProviderTargetInterceptors {
  messages?: readonly MessagesInterceptor[];
  responses?: readonly ResponsesInterceptor[];
  chatCompletions?: readonly ChatCompletionsInterceptor[];
}

export interface ModelProviderInstance {
  upstream: string;
  providerKind: UpstreamProviderKind;
  name: string;
  provider: ModelProvider;
  sourceInterceptors?: ProviderSourceInterceptors;
  targetInterceptors?: ProviderTargetInterceptors;
  resolveRequestedModelId?(modelId: string): string | undefined;
}

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}

export interface ModelProvider {
  getProvidedModels(): Promise<readonly UpstreamModel[]>;
  // Resolve pricing for a usage record's `model_key` (the raw upstream model
  // id). Used by aggregation-time cost computation. Public-model-name lookups
  // happen elsewhere by reading `UpstreamModel.cost` directly.
  getPricingForModelKey(modelKey: string): ModelPricing | null;
  callChatCompletions(model: UpstreamModel, body: Omit<ChatCompletionsPayload, 'model'>, signal?: AbortSignal): Promise<ProviderCallResult>;
  callResponses(model: UpstreamModel, body: Omit<ResponsesPayload, 'model'>, signal?: AbortSignal): Promise<ProviderCallResult>;
  callMessages(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callMessagesCountTokens(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callEmbeddings(model: UpstreamModel, body: Omit<EmbeddingsPayload, 'model'>, signal?: AbortSignal): Promise<ProviderCallResult>;
}
