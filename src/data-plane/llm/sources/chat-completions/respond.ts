import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { ChatCompletionChunk } from "../../../../lib/chat-completions-types.ts";
import { collectChatProtocolEventsToCompletion } from "./events/to-response.ts";
import { chatProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import { chatCompletionsSourceInterceptors } from "./interceptors/index.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import { sseFrame } from "../../shared/stream/types.ts";
import { runSourceInterceptors } from "../run-interceptors.ts";
import {
  type HiddenChatStreamUsageCapture,
  withUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";

const internalChatErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    source_api: error.source_api,
    target_api: error.target_api,
  },
});

const internalChatErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalChatErrorPayload(error), { status });

const internalChatStreamErrorFrame = (error: unknown) =>
  sseFrame(
    JSON.stringify(
      internalChatErrorPayload(toInternalDebugError(error, "chat-completions")),
    ),
    "error",
  );

export const respondChatCompletions = async (
  c: Context,
  initialResult: StreamExecuteResult<ChatCompletionChunk>,
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
    return withUsageResponseMetadata(
      Response.json(
        await collectChatProtocolEventsToCompletion(result.events),
      ),
      { usageModel: result.usageModel },
    );
  }

  const hiddenUsageCapture: HiddenChatStreamUsageCapture = {};

  return withUsageResponseMetadata(
    proxySSE(
      c,
      chatProtocolEventsToSSEFrames(result.events, {
        includeUsageChunk,
        onUsageChunk: (usage) => {
          hiddenUsageCapture.usage = usage;
        },
      }),
      { onError: internalChatStreamErrorFrame },
    ),
    {
      hiddenChatStreamUsageCapture: hiddenUsageCapture,
      usageModel: result.usageModel,
    },
  );
};
