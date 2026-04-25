import type { Context } from "hono";
import type { InternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import type { ChatCompletionResponse } from "../../../../lib/chat-completions-types.ts";
import {
  collectChatEventsToCompletion,
  expandChatFrames,
} from "./collect/from-events.ts";
import { chatCompletionsSourceInterceptors } from "./interceptors/index.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import { runSourceInterceptors } from "../run-interceptors.ts";

interface HiddenChatStreamUsageCapture {
  usage?: ChatCompletionResponse["usage"];
}

const internalChatErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response =>
  Response.json({
    error: {
      type: error.type,
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      source_api: error.source_api,
      target_api: error.target_api,
    },
  }, { status });

export const respondChatCompletions = async (
  c: Context,
  initialResult: StreamExecuteResult<ChatCompletionResponse>,
  wantsStream: boolean,
  includeUsageChunk: boolean,
): Promise<Response> => {
  const result = await runSourceInterceptors(
    initialResult,
    chatCompletionsSourceInterceptors,
  );

  if (result.type === "upstream-error") return upstreamErrorToResponse(result);
  if (result.type === "internal-error") {
    return internalChatErrorResponse(result.status, result.error);
  }

  if (!wantsStream) {
    return Response.json(await collectChatEventsToCompletion(result.events));
  }

  const hiddenUsageCapture: HiddenChatStreamUsageCapture = {};
  c.set("chatCompletionsHiddenUsageCapture", hiddenUsageCapture);

  return proxySSE(
    c,
    expandChatFrames(result.events, {
      includeUsageChunk,
      onUsageChunk: (usage) => {
        hiddenUsageCapture.usage = usage;
      },
    }),
  );
};
