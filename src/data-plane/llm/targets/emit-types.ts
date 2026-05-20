import type { BackgroundScheduler } from "../../../runtime/background.ts";
import type {
  ModelProvider,
  ProviderTargetInterceptors,
  UpstreamModel,
} from "../../providers/types.ts";
import type { ExecuteResult } from "../shared/errors/result.ts";
import type { ProtocolFrame, StreamFrame } from "../shared/stream/types.ts";

type SourceApi = "messages" | "responses" | "chat-completions" | "gemini";

export interface EmitInput<TPayload extends { model: string }> {
  sourceApi: SourceApi;
  model: string;
  upstream: string;
  payload: TPayload;
  provider: ModelProvider;
  upstreamModel: UpstreamModel;
  enabledFixes: ReadonlySet<string>;
  targetInterceptors?: ProviderTargetInterceptors;
  apiKeyId?: string;
  clientStream?: boolean;
  runtimeLocation?: string;
  scheduleBackground?: BackgroundScheduler;
  downstreamAbortSignal?: AbortSignal;
}

export type RawEmitResult<TJson> = ExecuteResult<StreamFrame<TJson>>;

export type EmitResult<TEvent> = ExecuteResult<ProtocolFrame<TEvent>>;
