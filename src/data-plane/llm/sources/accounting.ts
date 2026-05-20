import { getRepo } from "../../../repo/index.ts";
import type { ModelAccounting, TokenUsage } from "../../../repo/types.ts";
import {
  type PerformanceTelemetryContext,
  recordPerformanceError,
  recordPerformanceLatency,
} from "../../shared/performance/telemetry.ts";
import type { BackgroundScheduler } from "../../../runtime/background.ts";
import type {
  MessagesResponse,
  MessagesUsage,
} from "../shared/protocol/messages.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../shared/protocol/chat-completions.ts";
import type { ResponsesResult } from "../shared/protocol/responses.ts";
import type {
  GeminiGenerateContentResponse,
  GeminiUsageMetadata,
} from "../shared/protocol/gemini.ts";
import type { ProtocolFrame } from "../shared/stream/types.ts";

export type RecordUsage = (
  accounting: ModelAccounting,
  usage: TokenUsage,
) => Promise<void>;

export type RecordRequestPerformance = (
  context: PerformanceTelemetryContext | undefined,
  failed: boolean,
  durationMs: number,
) => void;

export interface SourceStreamOutcome {
  failed: boolean;
  completed: boolean;
}

const currentHour = (): string => new Date().toISOString().slice(0, 13);

export const hasTokenUsage = (usage: TokenUsage): boolean =>
  usage.inputTokens > 0 || usage.outputTokens > 0 ||
  usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0;

export const recordTokenUsage = async (
  keyId: string,
  accounting: ModelAccounting,
  usage: TokenUsage,
): Promise<void> => {
  await Promise.all([
    getRepo().usage.record(
      keyId,
      accounting.model,
      accounting.upstream,
      accounting.modelKey,
      currentHour(),
      1,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
    ),
    (async () => {
      const key = await getRepo().apiKeys.getById(keyId);
      if (!key) return;
      await getRepo().apiKeys.save({
        ...key,
        lastUsedAt: new Date().toISOString(),
      });
    })(),
  ]);
};

export const recordUsageForApiKey = (
  keyId: string | undefined,
): RecordUsage => {
  // Dashboard playground requests authenticate with ADMIN_KEY and intentionally
  // have no API key id. They still pass an explicit recorder so billable source
  // responders cannot accidentally make usage recording optional.
  if (!keyId) return () => Promise.resolve();
  return (accounting, usage) => recordTokenUsage(keyId, accounting, usage);
};

export const recordRequestTotal = (
  scheduler: BackgroundScheduler | undefined,
  context: PerformanceTelemetryContext,
  failed: boolean,
  durationMs: number,
): void => {
  const promise = failed
    ? recordPerformanceError(context, "request_total")
    : recordPerformanceLatency(context, "request_total", durationMs);
  scheduler ? scheduler(promise) : void promise;
};

export const recordRequestPerformanceForApiKey = (
  keyId: string | undefined,
  scheduler: BackgroundScheduler | undefined,
): RecordRequestPerformance => {
  if (!keyId) return () => {};
  return (context, failed, durationMs) => {
    if (!context) return;
    recordRequestTotal(scheduler, { ...context, keyId }, failed, durationMs);
  };
};

export const tokenUsageFromMessagesUsage = (
  usage: MessagesUsage,
): TokenUsage => {
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cacheReadTokens + cacheCreationTokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
};

export const tokenUsageFromMessagesResponse = (
  response: MessagesResponse,
): TokenUsage => tokenUsageFromMessagesUsage(response.usage);

export const tokenUsageFromChatUsage = (
  usage: NonNullable<ChatCompletionResponse["usage"]>,
): TokenUsage => ({
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  cacheCreationTokens: 0,
});

export const tokenUsageFromChatResponse = (
  response: ChatCompletionResponse,
): TokenUsage | null =>
  response.usage ? tokenUsageFromChatUsage(response.usage) : null;

export const tokenUsageFromChatChunk = (
  chunk: ChatCompletionChunk,
): TokenUsage | null =>
  chunk.usage ? tokenUsageFromChatUsage(chunk.usage) : null;

export const tokenUsageFromResponsesResult = (
  response: ResponsesResult,
): TokenUsage | null =>
  response.usage
    ? {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
      cacheCreationTokens: 0,
    }
    : null;

// Gemini usageMetadata.promptTokenCount already includes cachedContentTokenCount.
// thoughtsTokenCount is reasoning output and is not included in candidatesTokenCount,
// so include it in outputTokens to match the gateway's billing semantics.
export const tokenUsageFromGeminiUsageMetadata = (
  metadata: GeminiUsageMetadata,
): TokenUsage => ({
  inputTokens: metadata.promptTokenCount ?? 0,
  outputTokens: (metadata.candidatesTokenCount ?? 0) +
    (metadata.thoughtsTokenCount ?? 0),
  cacheReadTokens: metadata.cachedContentTokenCount ?? 0,
  cacheCreationTokens: 0,
});

export const tokenUsageFromGeminiResponse = (
  response: GeminiGenerateContentResponse,
): TokenUsage | null =>
  response.usageMetadata
    ? tokenUsageFromGeminiUsageMetadata(response.usageMetadata)
    : null;

export const recordUsageIfPresent = async (
  accounting: ModelAccounting,
  usage: TokenUsage | null,
  recordUsage: RecordUsage,
): Promise<void> => {
  if (!usage || !hasTokenUsage(usage)) return;
  await recordUsage(accounting, usage);
};

export const trackSourceStreamOutcome = async function* <TEvent>(
  frames: AsyncIterable<ProtocolFrame<TEvent>>,
  outcome: SourceStreamOutcome,
  isFailure: (event: TEvent) => boolean,
  isCompletion: (frame: ProtocolFrame<TEvent>) => boolean,
): AsyncGenerator<ProtocolFrame<TEvent>> {
  for await (const frame of frames) {
    if (frame.type === "event" && isFailure(frame.event)) {
      outcome.failed = true;
    }
    if (isCompletion(frame)) {
      outcome.completed = true;
    }
    yield frame;
  }
};
