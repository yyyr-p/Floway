import type { ChatCompletionResponse } from "../lib/chat-completions-types.ts";

export interface HiddenChatStreamUsageCapture {
  usage?: ChatCompletionResponse["usage"];
}

export interface UsageResponseMetadata {
  usageModel?: string;
  hiddenChatStreamUsageCapture?: HiddenChatStreamUsageCapture;
}

const USAGE_MODEL_HEADER = "x-copilot-gateway-usage-model";
const HIDDEN_CHAT_USAGE_CAPTURE_HEADER =
  "x-copilot-gateway-hidden-chat-usage-capture";

const hiddenChatStreamUsageCaptures = new Map<
  string,
  HiddenChatStreamUsageCapture
>();

// Hono may clone Response objects between route handlers and middleware, so
// object-attached metadata is not stable across that boundary. These private
// headers carry in-process accounting metadata only until usage middleware reads
// and strips them before the response leaves the gateway.
export function withUsageResponseMetadata(
  response: Response,
  metadata: UsageResponseMetadata,
): Response {
  const headers = new Headers(response.headers);
  if (metadata.usageModel) headers.set(USAGE_MODEL_HEADER, metadata.usageModel);
  if (metadata.hiddenChatStreamUsageCapture) {
    const captureId = crypto.randomUUID();
    hiddenChatStreamUsageCaptures.set(
      captureId,
      metadata.hiddenChatStreamUsageCapture,
    );
    headers.set(HIDDEN_CHAT_USAGE_CAPTURE_HEADER, captureId);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function getUsageResponseMetadata(
  response: Response,
): UsageResponseMetadata | undefined {
  const usageModel = response.headers.get(USAGE_MODEL_HEADER) ?? undefined;
  const captureId = response.headers.get(HIDDEN_CHAT_USAGE_CAPTURE_HEADER);
  const hiddenChatStreamUsageCapture = captureId
    ? hiddenChatStreamUsageCaptures.get(captureId)
    : undefined;
  if (captureId) hiddenChatStreamUsageCaptures.delete(captureId);
  if (!usageModel && !hiddenChatStreamUsageCapture) return undefined;
  return { usageModel, hiddenChatStreamUsageCapture };
}

export function stripUsageResponseMetadata(response: Response): Response {
  if (
    !response.headers.has(USAGE_MODEL_HEADER) &&
    !response.headers.has(HIDDEN_CHAT_USAGE_CAPTURE_HEADER)
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete(USAGE_MODEL_HEADER);
  headers.delete(HIDDEN_CHAT_USAGE_CAPTURE_HEADER);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
