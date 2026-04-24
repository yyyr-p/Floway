import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "../chat-completions-types.ts";
import {
  MESSAGES_THINKING_PLACEHOLDER,
  type MessagesAssistantContentBlock,
  type MessagesAssistantMessage,
  type MessagesImageBlock,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesRedactedThinkingBlock,
  type MessagesResponse,
  type MessagesTargetPayload,
  type MessagesTextBlock,
  type MessagesThinkingBlock,
  type MessagesToolResultBlock,
  type MessagesToolUseBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
} from "../messages-types.ts";
import { safeJsonParse } from "./utils.ts";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

interface RemoteImageData {
  mediaType: string | null;
  data: Uint8Array;
}

export type RemoteImageLoader = (url: string) => Promise<RemoteImageData | null>;

interface TranslateChatCompletionsToMessagesOptions {
  loadRemoteImage?: RemoteImageLoader;
}

const buildMessagesThinkingBlock = (
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): MessagesThinkingBlock | MessagesRedactedThinkingBlock | null => {
  if (reasoningText) {
    return {
      type: "thinking",
      thinking: reasoningText,
      ...(reasoningOpaque ? { signature: reasoningOpaque } : {}),
    };
  }

  return reasoningOpaque ? { type: "redacted_thinking", data: reasoningOpaque } : null;
};

const buildAssistantBlocks = (
  message: Message,
): MessagesAssistantContentBlock[] => {
  const blocks: MessagesAssistantContentBlock[] = [];
  const thinkingBlock = buildMessagesThinkingBlock(
    message.reasoning_text,
    message.reasoning_opaque,
  );

  if (thinkingBlock) blocks.push(thinkingBlock);

  if (typeof message.content === "string" && message.content) {
    blocks.push({ type: "text", text: message.content });
  }

  for (const toolCall of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: safeJsonParse(toolCall.function.arguments),
    });
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
};

const appendUserContent = (
  messages: MessagesMessage[],
  blocks: MessagesUserContentBlock[],
): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "user") {
    const existing = Array.isArray(lastMessage.content)
      ? lastMessage.content
      : [{ type: "text" as const, text: lastMessage.content }];

    lastMessage.content = [...existing, ...blocks];
    return;
  }

  messages.push({
    role: "user",
    content: blocks.length === 1 && blocks[0].type === "text"
      ? blocks[0].text
      : blocks,
  });
};

const appendToolResult = (
  messages: MessagesMessage[],
  toolResult: MessagesToolResultBlock,
): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "user") {
    const existing = Array.isArray(lastMessage.content)
      ? lastMessage.content
      : [{ type: "text" as const, text: lastMessage.content }];

    lastMessage.content = [...existing, toolResult];
    return;
  }

  messages.push({ role: "user", content: [toolResult] });
};

const parseDataUrl = (
  url: string,
): { mediaType: string; data: string } | null => {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mediaType: match[1], data: match[2] } : null;
};

const inferMediaTypeFromUrl = (url: string): string | null => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
  } catch {
    return null;
  }

  return null;
};

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = "";

  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
};

const resolveRemoteImage = async (
  url: string,
  loadRemoteImage: RemoteImageLoader,
): Promise<MessagesImageBlock | null> => {
  const image = await loadRemoteImage(url);
  if (!image) return null;

  let mediaType = image.mediaType?.split(";")[0].trim() ?? "";
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
    mediaType = inferMediaTypeFromUrl(url) ?? "";
  }
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return null;

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as MessagesImageBlock["source"]["media_type"],
      data: uint8ArrayToBase64(image.data),
    },
  };
};

const resolveImage = async (
  url: string,
  loadRemoteImage: RemoteImageLoader,
): Promise<MessagesImageBlock | null> => {
  const dataUrl = parseDataUrl(url);

  if (dataUrl) {
    if (!ALLOWED_IMAGE_TYPES.has(dataUrl.mediaType)) return null;

    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUrl.mediaType as MessagesImageBlock["source"]["media_type"],
        data: dataUrl.data,
      },
    };
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  return await resolveRemoteImage(url, loadRemoteImage);
};

const convertUserContent = async (
  message: Message,
  loadRemoteImage: RemoteImageLoader,
): Promise<MessagesUserContentBlock[]> => {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }

  if (!Array.isArray(message.content)) {
    return [{ type: "text", text: "" }];
  }

  const resolved = await Promise.all(message.content.map((part) => {
    if (part.type === "text") {
      return Promise.resolve({ type: "text", text: part.text } as MessagesUserContentBlock);
    }

    return resolveImage(part.image_url.url, loadRemoteImage);
  }));

  const blocks = resolved.filter((block): block is MessagesUserContentBlock =>
    block !== null
  );

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
};

const buildMessagesInput = async (
  messages: Message[],
  loadRemoteImage: RemoteImageLoader,
): Promise<MessagesMessage[]> => {
  const result: MessagesMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "user":
        appendUserContent(result, await convertUserContent(message, loadRemoteImage));
        break;
      case "assistant":
        result.push({ role: "assistant", content: buildAssistantBlocks(message) });
        break;
      case "tool":
        if (!message.tool_call_id) {
          throw new Error("tool message requires tool_call_id for Messages translation");
        }

        appendToolResult(result, {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: typeof message.content === "string" ? message.content : "",
        });
        break;
    }
  }

  return result;
};

const translateChatCompletionsTools = (
  tools: Tool[],
): MessagesPayload["tools"] =>
  tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));

const translateChatCompletionsToolChoice = (
  toolChoice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): MessagesPayload["tool_choice"] => {
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto":
        return { type: "auto" };
      case "none":
        return { type: "none" };
      case "required":
        return { type: "any" };
      default:
        return undefined;
    }
  }

  return toolChoice.type === "function" && toolChoice.function?.name
    ? { type: "tool", name: toolChoice.function.name }
    : undefined;
};

export const translateChatCompletionsToMessages = async (
  payload: ChatCompletionsPayload,
  options: TranslateChatCompletionsToMessagesOptions = {},
): Promise<MessagesTargetPayload> => {
  const systemParts: string[] = [];
  const nonSystemMessages: Message[] = [];

  for (const message of payload.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
        ? message.content
          .filter((part): part is Extract<ContentPart, { type: "text" }> =>
            part.type === "text"
          )
          .map((part) => part.text)
          .join("")
        : "";

      if (text) systemParts.push(text);
      continue;
    }

    nonSystemMessages.push(message);
  }

  const messages = await buildMessagesInput(
    nonSystemMessages,
    options.loadRemoteImage ?? fetchRemoteImage,
  );

  return {
    model: payload.model,
    messages,
    // Messages requires `max_tokens`, but Chat Completions can omit it.
    // Keep translation literal and let the Messages target decide whether the
    // chosen upstream path needs a fallback.
    ...(payload.max_tokens != null ? { max_tokens: payload.max_tokens } : {}),
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    ...(payload.stop != null
      ? {
        stop_sequences: Array.isArray(payload.stop)
          ? payload.stop
          : [payload.stop],
      }
      : {}),
    ...(payload.stream ? { stream: payload.stream } : {}),
    ...(payload.tools?.length ? { tools: translateChatCompletionsTools(payload.tools) } : {}),
    ...(payload.tool_choice != null
      ? { tool_choice: translateChatCompletionsToolChoice(payload.tool_choice) }
      : {}),
  };
};

export const toMessagesId = (id: string): string =>
  id.startsWith("msg_") ? id : `msg_${id.replace(/^chatcmpl-/, "")}`;

export const mapChatCompletionsFinishReasonToMessagesStopReason = (
  finishReason:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | null,
): MessagesResponse["stop_reason"] => {
  if (finishReason === null) return null;

  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
  }
};

interface ChatCompletionsUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export const mapChatCompletionsUsageToMessagesUsage = (
  usage?: ChatCompletionsUsage,
): MessagesResponse["usage"] => {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;

  return {
    input_tokens: (usage?.prompt_tokens ?? 0) - (cachedTokens ?? 0),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cachedTokens !== undefined
      ? { cache_read_input_tokens: cachedTokens }
      : {}),
  };
};

const getThinkingBlocks = (
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): MessagesThinkingBlock[] => {
  if (reasoningText) {
    return [{
      type: "thinking",
      thinking: reasoningText,
      signature: reasoningOpaque ?? "",
    }];
  }

  return reasoningOpaque
    ? [{
      type: "thinking",
      thinking: MESSAGES_THINKING_PLACEHOLDER,
      signature: reasoningOpaque,
    }]
    : [];
};

export const translateChatCompletionsToMessagesResponse = (
  response: ChatCompletionResponse,
): MessagesResponse => {
  const thinkingBlocks: MessagesThinkingBlock[] = [];
  const textBlocks: MessagesTextBlock[] = [];
  const toolUseBlocks: MessagesToolUseBlock[] = [];
  let stopReason = response.choices[0]?.finish_reason ?? null;

  for (const choice of response.choices) {
    thinkingBlocks.push(
      ...getThinkingBlocks(
        choice.message.reasoning_text,
        choice.message.reasoning_opaque,
      ),
    );

    if (choice.message.content) {
      textBlocks.push({ type: "text", text: choice.message.content });
    }

    for (const toolCall of choice.message.tool_calls ?? []) {
      toolUseBlocks.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: safeJsonParse(toolCall.function.arguments),
      });
    }

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason;
    }
  }

  return {
    id: toMessagesId(response.id),
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...thinkingBlocks, ...textBlocks, ...toolUseBlocks],
    stop_reason: mapChatCompletionsFinishReasonToMessagesStopReason(stopReason),
    stop_sequence: null,
    usage: mapChatCompletionsUsageToMessagesUsage(response.usage),
  };
};

export const fetchRemoteImage = async (
  url: string,
): Promise<RemoteImageData | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;

    return {
      mediaType: response.headers.get("content-type"),
      data: new Uint8Array(await response.arrayBuffer()),
    };
  } catch {
    return null;
  }
};
