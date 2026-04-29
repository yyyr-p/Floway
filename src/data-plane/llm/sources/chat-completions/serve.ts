import type { Context } from "hono";
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "../../../../lib/chat-completions-types.ts";
import { normalizeChatRequest } from "./normalize/request.ts";
import { planChatRequest } from "./plan.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/chat-completions-via-messages/build-target-request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/chat-completions-via-responses/build-target-request.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents as translateMessagesToSourceEvents } from "../../translate/chat-completions-via-messages/translate-to-source-events.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/chat-completions-via-responses/translate-to-source-events.ts";
import { respondChatCompletions } from "./respond.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import { withAccountFallback } from "../../../shared/account-pool/fallback.ts";

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
): StreamExecuteResult<ChatCompletionChunk> =>
  result.type === "events"
    ? { type: "events", events: translate(result.events) }
    : result;

export const serveChatCompletions = async (
  c: Context,
): Promise<Response> => {
  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    normalizeChatRequest(payload);
    c.set("model", payload.model || "unknown");
    // Target interceptors may force upstream usage for gateway accounting, but
    // Chat SSE exposes usage only when the caller requested `include_usage`.
    const includeUsageChunk = payload.stream_options?.include_usage === true;
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    const wantsStream = payload.stream === true;

    const result = await withAccountFallback(
      payload.model,
      async ({ account }) => {
        const attemptPayload = structuredClone(payload);
        const capabilities = await getModelCapabilities(
          attemptPayload.model,
          account.token,
          account.accountType,
        );
        const plan = planChatRequest(attemptPayload, capabilities);
        attemptPayload.model = capabilities.model?.id ?? attemptPayload.model;

        if (plan.target === "messages") {
          const result = await emitToMessages({
            sourceApi: "chat-completions",
            payload: await buildMessagesTargetRequest(attemptPayload),
            githubToken: account.token,
            accountType: account.accountType,
            apiKeyId,
            fetchOptions: plan.fetchOptions,
          });

          return withTranslatedEvents(result, translateMessagesToSourceEvents);
        }

        if (plan.target === "responses") {
          const result = await emitToResponses({
            sourceApi: "chat-completions",
            payload: buildResponsesTargetRequest(attemptPayload),
            githubToken: account.token,
            accountType: account.accountType,
            fetchOptions: plan.fetchOptions,
          });

          return withTranslatedEvents(result, translateResponsesToSourceEvents);
        }

        return await emitToChatCompletions({
          sourceApi: "chat-completions",
          payload: attemptPayload,
          githubToken: account.token,
          accountType: account.accountType,
          fetchOptions: plan.fetchOptions,
        });
      },
    );

    return await respondChatCompletions(
      c,
      result,
      wantsStream,
      includeUsageChunk,
    );
  } catch (error) {
    return await respondChatCompletions(
      c,
      internalErrorResult(502, toInternalDebugError(error, "chat-completions")),
      false,
      false,
    );
  }
};
