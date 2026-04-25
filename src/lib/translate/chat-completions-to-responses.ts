import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatReasoningItem,
  ContentPart,
  Tool,
} from "../chat-completions-types.ts";
import { makeResponsesReasoningId } from "../reasoning.ts";
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputReasoning,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseTool,
  ResponseToolChoice,
} from "../responses-types.ts";
import { checkWhitespaceOverflow } from "./utils.ts";

const extractTextContent = (
  content: string | ContentPart[] | null,
): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  // Assumption: OpenAI text parts are transport fragments of one message, not
  // Anthropic-style paragraph blocks. Preserve the current no-separator join
  // unless we later find a stronger upstream boundary guarantee.
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("");
};

const toResponsesContent = (
  content: string | ContentPart[] | null,
): string | ResponseInputContent[] => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: ResponseInputContent[] = [];

  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    parts.push({
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail ?? "auto",
    });
  }

  return parts.length > 0 ? parts : "";
};

const toResponsesAssistantContent = (
  content: string | ContentPart[] | null,
): string | ResponseInputContent[] => {
  const text = extractTextContent(content);
  return text ? [{ type: "output_text", text }] : "";
};

const translateChatTools = (tools?: Tool[] | null): ResponseTool[] | null =>
  tools?.length
    ? tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      parameters: tool.function.parameters,
      strict: tool.function.strict ?? false,
      ...(tool.function.description
        ? { description: tool.function.description }
        : {}),
    }))
    : null;

const translateChatToolChoice = (
  choice?: ChatCompletionsPayload["tool_choice"],
): ResponseToolChoice => {
  if (!choice) return "auto";
  if (typeof choice === "string") {
    return choice === "none" || choice === "auto" || choice === "required"
      ? choice
      : "auto";
  }

  return choice.type === "function" && choice.function?.name
    ? { type: "function", name: choice.function.name }
    : "auto";
};

const buildResponsesTextConfig = (
  responseFormat: ChatCompletionsPayload["response_format"],
): ResponsesPayload["text"] | undefined => {
  if (responseFormat === undefined) return undefined;
  return responseFormat === null ? null : { format: responseFormat };
};

type ResponseReasoningItem = ResponseInputReasoning | ResponseOutputReasoning;

const toResponseReasoningItem = <T extends ResponseReasoningItem>(
  item: ChatReasoningItem,
  fallbackId: string,
): T =>
  ({
    type: "reasoning",
    id: item.id ?? fallbackId,
    summary: item.summary ?? [],
    ...(item.encrypted_content !== undefined
      ? { encrypted_content: item.encrypted_content }
      : {}),
  }) as T;

const scalarToResponseReasoningItem = <T extends ResponseReasoningItem>(
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
  id: string,
): T | null => {
  const hasReasoningOpaque = reasoningOpaque !== undefined &&
    reasoningOpaque !== null;
  if (!reasoningText && !hasReasoningOpaque) return null;

  return {
    type: "reasoning",
    id,
    summary: reasoningText
      ? [{ type: "summary_text", text: reasoningText }]
      : [],
    ...(hasReasoningOpaque ? { encrypted_content: reasoningOpaque } : {}),
  } as T;
};

const translateChatReasoningItems = <T extends ResponseReasoningItem>(
  reasoningItems: ChatReasoningItem[] | null | undefined,
  nextIdIndex: () => number,
): T[] | null => {
  if (!reasoningItems?.length) return null;

  // `reasoning_items[]` is a LiteLLM-inspired compatibility workaround for
  // carrying Responses reasoning items through Chat without compressing multiple
  // opaque payloads into legacy scalar fields. Scalars remain first-group only.
  // References:
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L59-L104
  // - https://github.com/BerriAI/litellm/blob/70492cee4282541256fb9ac963be94412b1a109c/litellm/completion_extras/litellm_responses_transformation/transformation.py#L1322-L1355
  const startIndex = nextIdIndex();
  return reasoningItems.map((item, index) =>
    toResponseReasoningItem<T>(
      item,
      makeResponsesReasoningId(startIndex + index),
    )
  );
};

export const translateChatCompletionsToResponses = (
  payload: ChatCompletionsPayload,
): ResponsesPayload => {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];
  let hoistSystemPrefix = true;

  for (const message of payload.messages) {
    // Only the initial Chat `system` prefix maps cleanly to Responses
    // `instructions`. Responses input can carry later `system` and `developer`
    // roles, so keep them in order instead of widening instruction scope.
    if (hoistSystemPrefix && message.role === "system") {
      const text = extractTextContent(message.content);
      if (text) instructions.push(text);
      continue;
    }

    hoistSystemPrefix = false;

    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: toResponsesContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const reasoningItems = translateChatReasoningItems<
        ResponseInputReasoning
      >(
        message.reasoning_items,
        () => input.length,
      );
      const scalarReasoning = scalarToResponseReasoningItem<
        ResponseInputReasoning
      >(
        message.reasoning_text,
        message.reasoning_opaque,
        makeResponsesReasoningId(input.length),
      );
      if (reasoningItems) {
        input.push(...reasoningItems);
      } else if (scalarReasoning) {
        input.push(scalarReasoning);
      }

      if (message.tool_calls?.length) {
        const text = extractTextContent(message.content);
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }

        for (const toolCall of message.tool_calls) {
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            status: "completed",
          });
        }

        continue;
      }

      input.push({
        type: "message",
        role: "assistant",
        content: toResponsesAssistantContent(message.content),
      });
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      input.push({
        type: "message",
        role: message.role,
        content: toResponsesContent(message.content),
      });
      continue;
    }

    if (!message.tool_call_id) {
      throw new Error(
        "tool message requires tool_call_id for Responses translation",
      );
    }

    input.push({
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    });
  }

  const responseTextConfig = buildResponsesTextConfig(payload.response_format);

  return {
    model: payload.model,
    input,
    ...(instructions.length > 0
      ? { instructions: instructions.join("\n\n") }
      : {}),
    ...(payload.temperature !== undefined
      ? { temperature: payload.temperature }
      : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_tokens !== undefined
      ? { max_output_tokens: payload.max_tokens }
      : {}),
    ...(payload.tools !== undefined
      ? { tools: translateChatTools(payload.tools) }
      : {}),
    tool_choice: translateChatToolChoice(payload.tool_choice),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    // Preserve Chat's omitted `store` as omitted instead of synthesizing
    // `store: false`. OpenAI's migration guide treats storage as the default
    // behavior for both Responses and new Chat Completions accounts; callers
    // disable it explicitly with `store: false`.
    // Reference:
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: payload.parallel_tool_calls }
      : {}),
    ...(payload.reasoning_effort != null
      ? { reasoning: { effort: payload.reasoning_effort } }
      : {}),
    ...(responseTextConfig !== undefined ? { text: responseTextConfig } : {}),
    ...(payload.prompt_cache_key !== undefined
      ? { prompt_cache_key: payload.prompt_cache_key }
      : {}),
    ...(payload.safety_identifier !== undefined
      ? { safety_identifier: payload.safety_identifier }
      : {}),
    ...(payload.service_tier !== undefined
      ? { service_tier: payload.service_tier }
      : {}),
    include: ["reasoning.encrypted_content"],
  };
};

const mapUsage = (
  usage: ChatCompletionResponse["usage"] | undefined,
): ResponsesResult["usage"] | undefined =>
  usage
    ? {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      ...(usage.prompt_tokens_details?.cached_tokens !== undefined
        ? {
          input_tokens_details: {
            cached_tokens: usage.prompt_tokens_details.cached_tokens,
          },
        }
        : {}),
    }
    : undefined;

const mapResultStatus = (
  finishReason: ChatCompletionResponse["choices"][0]["finish_reason"],
): ResponsesResult["status"] =>
  finishReason === "length" ? "incomplete" : "completed";

export const translateChatCompletionToResponsesResult = (
  response: ChatCompletionResponse,
): ResponsesResult => {
  const choice = response.choices[0];
  const output: ResponseOutputItem[] = [];
  const reasoningText = choice.message.reasoning_text;
  const reasoningOpaque = choice.message.reasoning_opaque;

  const reasoningItems = translateChatReasoningItems<ResponseOutputReasoning>(
    choice.message.reasoning_items,
    () => output.length,
  );
  const scalarReasoning = scalarToResponseReasoningItem<
    ResponseOutputReasoning
  >(
    reasoningText,
    reasoningOpaque,
    makeResponsesReasoningId(output.length),
  );
  if (reasoningItems) {
    output.push(...reasoningItems);
  } else if (scalarReasoning) {
    output.push(scalarReasoning);
  }

  if (choice.message.content) {
    output.push(
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: choice.message.content }],
      } satisfies ResponseOutputMessage,
    );
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    output.push(
      {
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        status: "completed",
      } satisfies ResponseOutputFunctionCall,
    );
  }

  return {
    id: response.id,
    object: "response",
    model: response.model,
    output,
    output_text: choice.message.content ?? "",
    status: mapResultStatus(choice.finish_reason),
    ...(choice.finish_reason === "length"
      ? { incomplete_details: { reason: "max_output_tokens" } }
      : {}),
    usage: mapUsage(response.usage),
  };
};

interface PendingScalarReasoningItem {
  text: string;
  signature: string;
  hasSignature: boolean;
}

interface PendingTextItem {
  outputIndex: number;
  itemId: string;
  text: string;
}

interface PendingFunctionCallItem {
  outputIndex?: number;
  itemId?: string;
  callId?: string;
  name?: string;
  arguments: string;
  consecutiveWhitespace: number;
}

type ChatStreamDelta = ChatCompletionChunk["choices"][0]["delta"];
type ChatStreamToolCalls = NonNullable<ChatStreamDelta["tool_calls"]>;

type DeferredAfterReasoning =
  | { type: "content"; content: string }
  | { type: "tool_calls"; toolCalls: ChatStreamToolCalls };

interface ChatCompletionsToResponsesStreamState {
  responseCreated: boolean;
  outputIndex: number;
  sequenceNumber: number;
  responseId: string;
  model: string;
  outputText: string;
  completedItems: Map<number, ResponseOutputItem>;
  pendingScalarReasoning: PendingScalarReasoningItem | null;
  openText: PendingTextItem | null;
  openFunctionCalls: Map<number, PendingFunctionCallItem>;
  deferredAfterReasoning: DeferredAfterReasoning[];
  reasoningItemsSeen: boolean;
  usage?: ResponsesResult["usage"];
  pendingFinishReason?: ChatCompletionResponse["choices"][0]["finish_reason"];
  completed: boolean;
}

export const createChatCompletionsToResponsesStreamState =
  (): ChatCompletionsToResponsesStreamState => ({
    responseCreated: false,
    outputIndex: 0,
    sequenceNumber: 0,
    responseId: "",
    model: "",
    outputText: "",
    completedItems: new Map(),
    pendingScalarReasoning: null,
    openText: null,
    openFunctionCalls: new Map(),
    deferredAfterReasoning: [],
    reasoningItemsSeen: false,
    usage: undefined,
    pendingFinishReason: undefined,
    completed: false,
  });

const seq = (
  state: ChatCompletionsToResponsesStreamState,
  events: ResponseStreamEvent[],
): ResponseStreamEvent[] =>
  events.map((event) => ({
    ...event,
    sequence_number: state.sequenceNumber++,
  }));

const buildResult = (
  state: ChatCompletionsToResponsesStreamState,
  status: ResponsesResult["status"],
): ResponsesResult => ({
  id: state.responseId,
  object: "response",
  model: state.model,
  output: [...state.completedItems.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item),
  output_text: state.outputText,
  status,
  ...(state.pendingFinishReason === "length"
    ? { incomplete_details: { reason: "max_output_tokens" } }
    : {}),
  ...(state.usage ? { usage: state.usage } : {}),
});

const ensureResponseCreated = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  state.responseId = chunk.id;
  state.model = chunk.model;

  if (chunk.usage) {
    state.usage = mapUsage(chunk.usage);
  }

  if (state.responseCreated) return [];

  state.responseCreated = true;
  const response = buildResult(state, "in_progress");

  return seq(state, [
    { type: "response.created", response },
    { type: "response.in_progress", response },
  ]);
};

const emitCompletedReasoningItem = (
  item: ResponseOutputReasoning,
  outputIndex: number,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  state.completedItems.set(outputIndex, item);

  return seq(state, [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    },
    ...item.summary.flatMap((part, summaryIndex) => [
      {
        type: "response.reasoning_summary_part.added" as const,
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part,
      },
      {
        type: "response.reasoning_summary_text.done" as const,
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: part.text,
      },
      {
        type: "response.reasoning_summary_part.done" as const,
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part,
      },
    ]),
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    },
  ]);
};

const commitPendingScalarReasoning = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (!state.pendingScalarReasoning) return [];

  const reasoning = state.pendingScalarReasoning;
  state.pendingScalarReasoning = null;
  const outputIndex = state.outputIndex++;
  const item: ResponseOutputReasoning = {
    type: "reasoning",
    id: makeResponsesReasoningId(outputIndex),
    summary: reasoning.text
      ? [{ type: "summary_text", text: reasoning.text }]
      : [],
    ...(reasoning.hasSignature
      ? { encrypted_content: reasoning.signature }
      : {}),
  };

  return emitCompletedReasoningItem(item, outputIndex, state);
};

const closeText = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (!state.openText) return [];

  const textItem = state.openText;
  state.openText = null;

  const part = { type: "output_text" as const, text: textItem.text };
  const item: ResponseOutputMessage = {
    type: "message",
    role: "assistant",
    content: [part],
  };

  state.completedItems.set(textItem.outputIndex, item);

  return seq(state, [
    {
      type: "response.output_text.done",
      item_id: textItem.itemId,
      output_index: textItem.outputIndex,
      content_index: 0,
      text: textItem.text,
    },
    {
      type: "response.content_part.done",
      item_id: textItem.itemId,
      output_index: textItem.outputIndex,
      content_index: 0,
      part,
    },
    {
      type: "response.output_item.done",
      output_index: textItem.outputIndex,
      item,
    },
  ]);
};

const closeFunctionCalls = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];

  for (
    const functionCall of [...state.openFunctionCalls.values()].sort((a, b) =>
      (a.outputIndex ?? Number.MAX_SAFE_INTEGER) -
      (b.outputIndex ?? Number.MAX_SAFE_INTEGER)
    )
  ) {
    if (
      functionCall.outputIndex == null ||
      !functionCall.itemId ||
      !functionCall.callId ||
      !functionCall.name
    ) {
      continue;
    }

    const item: ResponseOutputFunctionCall = {
      type: "function_call",
      call_id: functionCall.callId,
      name: functionCall.name,
      arguments: functionCall.arguments,
      status: "completed",
    };

    state.completedItems.set(functionCall.outputIndex, item);
    events.push(
      {
        type: "response.function_call_arguments.done",
        item_id: functionCall.itemId,
        output_index: functionCall.outputIndex,
        arguments: functionCall.arguments,
      },
      {
        type: "response.output_item.done",
        output_index: functionCall.outputIndex,
        item,
      },
    );
  }

  state.openFunctionCalls.clear();
  return seq(state, events);
};

const ensureReasoning = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (state.pendingScalarReasoning) return [];

  state.pendingScalarReasoning = {
    text: "",
    signature: "",
    hasSignature: false,
  };
  return [];
};

const ensureText = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (state.openText) return [];

  const outputIndex = state.outputIndex++;
  const itemId = `msg_${outputIndex}`;
  state.openText = { outputIndex, itemId, text: "" };

  return seq(state, [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    },
    {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
  ]);
};

const ensureFunctionCall = (
  toolCallIndex: number,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const current = state.openFunctionCalls.get(toolCallIndex);
  if (
    !current ||
    current.outputIndex != null ||
    !current.callId ||
    !current.name
  ) {
    return [];
  }

  current.outputIndex = state.outputIndex++;
  current.itemId = `fc_${current.outputIndex}`;

  const events: ResponseStreamEvent[] = [{
    type: "response.output_item.added",
    output_index: current.outputIndex,
    item: {
      type: "function_call",
      call_id: current.callId,
      name: current.name,
      arguments: "",
      status: "in_progress",
    },
  }];

  if (current.arguments) {
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: current.itemId,
      output_index: current.outputIndex,
      delta: current.arguments,
    });
  }

  return seq(state, events);
};

const emitReasoningItemFromChatDelta = (
  item: ChatReasoningItem,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const outputIndex = state.outputIndex++;
  const responseItem = toResponseReasoningItem<ResponseOutputReasoning>(
    item,
    makeResponsesReasoningId(outputIndex),
  );

  return emitCompletedReasoningItem(responseItem, outputIndex, state);
};

const emitContentDelta = (
  content: string,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...ensureText(state));

  if (state.openText) {
    state.openText.text += content;
    state.outputText += content;
    events.push(...seq(state, [{
      type: "response.output_text.delta",
      item_id: state.openText.itemId,
      output_index: state.openText.outputIndex,
      content_index: 0,
      delta: content,
    }]));
  }

  return events;
};

const emitToolCallsDelta = (
  toolCalls: ChatStreamToolCalls,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...closeText(state));

  for (const toolCall of toolCalls) {
    const current = state.openFunctionCalls.get(toolCall.index) ?? {
      arguments: "",
      consecutiveWhitespace: 0,
    };

    if (toolCall.id) current.callId = toolCall.id;
    if (toolCall.function?.name) current.name = toolCall.function.name;
    state.openFunctionCalls.set(toolCall.index, current);
    events.push(...ensureFunctionCall(toolCall.index, state));

    if (!toolCall.function?.arguments) continue;

    const whitespace = checkWhitespaceOverflow(
      toolCall.function.arguments,
      current.consecutiveWhitespace,
    );
    current.consecutiveWhitespace = whitespace.count;

    if (whitespace.exceeded) {
      state.completed = true;
      return [
        ...events,
        ...seq(state, [{
          type: "error",
          message:
            "Tool call arguments contained excessive whitespace, indicating a degenerate response.",
          code: "api_error",
        }]),
      ];
    }

    current.arguments += toolCall.function.arguments;

    if (current.outputIndex != null && current.itemId) {
      events.push(...seq(state, [{
        type: "response.function_call_arguments.delta",
        item_id: current.itemId,
        output_index: current.outputIndex,
        delta: toolCall.function.arguments,
      }]));
    }
  }

  return events;
};

const flushDeferredAfterReasoning = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...commitPendingScalarReasoning(state));

  const deferred = state.deferredAfterReasoning;
  state.deferredAfterReasoning = [];

  for (const item of deferred) {
    if (state.completed) break;
    events.push(
      ...(item.type === "content"
        ? emitContentDelta(item.content, state)
        : emitToolCallsDelta(item.toolCalls, state)),
    );
  }

  return events;
};

const finalize = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (state.completed || state.pendingFinishReason == null) return [];

  const events = [
    ...flushDeferredAfterReasoning(state),
    ...closeText(state),
    ...closeFunctionCalls(state),
  ];

  if (state.completed) return events;
  state.completed = true;

  return [
    ...events,
    ...seq(state, [{
      type: state.pendingFinishReason === "length"
        ? "response.incomplete"
        : "response.completed",
      response: buildResult(
        state,
        state.pendingFinishReason === "length" ? "incomplete" : "completed",
      ),
    }]),
  ];
};

export const translateChatCompletionsChunkToResponsesEvents = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events = ensureResponseCreated(chunk, state);

  if (chunk.usage) {
    state.usage = mapUsage(chunk.usage);
  }

  if (chunk.choices.length === 0) {
    return [...events, ...finalize(state)];
  }

  for (const choice of chunk.choices) {
    if (choice.delta.reasoning_items?.length) {
      const hadPendingScalarReasoning = state.pendingScalarReasoning !== null;
      state.reasoningItemsSeen = true;

      if (hadPendingScalarReasoning) {
        // Chat stream composition can emit legacy scalar reasoning first and a
        // richer LiteLLM-style `reasoning_items[]` carrier later. Responses SSE
        // items are not retractable, so scalar reasoning remains buffered until
        // either a carrier replaces it or finalization commits it.
        state.pendingScalarReasoning = null;
      } else {
        events.push(...flushDeferredAfterReasoning(state));
        events.push(...closeText(state));
      }

      for (const item of choice.delta.reasoning_items) {
        events.push(...emitReasoningItemFromChatDelta(item, state));
      }

      if (hadPendingScalarReasoning) {
        events.push(...flushDeferredAfterReasoning(state));
        if (state.completed) return events;
      }
    } else if (
      choice.delta.reasoning_text ||
      choice.delta.reasoning_opaque !== undefined &&
        choice.delta.reasoning_opaque !== null
    ) {
      if (!state.reasoningItemsSeen) {
        if (!state.pendingScalarReasoning) events.push(...closeText(state));
        events.push(...ensureReasoning(state));

        if (choice.delta.reasoning_text && state.pendingScalarReasoning) {
          state.pendingScalarReasoning.text += choice.delta.reasoning_text;
        }

        if (
          choice.delta.reasoning_opaque !== undefined &&
          choice.delta.reasoning_opaque !== null &&
          state.pendingScalarReasoning
        ) {
          state.pendingScalarReasoning.signature +=
            choice.delta.reasoning_opaque;
          state.pendingScalarReasoning.hasSignature = true;
        }
      }
    }

    if (choice.delta.content) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: "content",
          content: choice.delta.content,
        });
      } else {
        events.push(...emitContentDelta(choice.delta.content, state));
      }
    }

    if (choice.delta.tool_calls) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: "tool_calls",
          toolCalls: choice.delta.tool_calls,
        });
      } else {
        events.push(...emitToolCallsDelta(choice.delta.tool_calls, state));
        if (state.completed) return events;
      }
    }

    if (choice.finish_reason) {
      state.pendingFinishReason = choice.finish_reason;
    }
  }

  return events;
};

export const flushChatCompletionsToResponsesEvents = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => finalize(state);
