export const MESSAGES_THINKING_PLACEHOLDER = "Thinking...";

export interface MessagesPayload {
  model: string;
  messages: MessagesMessage[];
  max_tokens: number;
  system?: string | MessagesTextBlock[];
  metadata?: { user_id?: string };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: MessagesTool[];
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
  };
  thinking?: {
    type: "enabled" | "adaptive" | "disabled";
    budget_tokens?: number;
  };
  output_config?: { effort?: string };
  service_tier?: "auto" | "standard_only";
}

export type MessagesTargetPayload =
  & Omit<MessagesPayload, "max_tokens">
  & {
    max_tokens?: number;
  };

export interface MessagesTextBlock {
  type: "text";
  text: string;
}

export interface MessagesImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export interface MessagesToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface MessagesToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MessagesThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface MessagesRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type MessagesUserContentBlock =
  | MessagesTextBlock
  | MessagesImageBlock
  | MessagesToolResultBlock;

export type MessagesAssistantContentBlock =
  | MessagesTextBlock
  | MessagesToolUseBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock;

export interface MessagesUserMessage {
  role: "user";
  content: string | MessagesUserContentBlock[];
}

export interface MessagesAssistantMessage {
  role: "assistant";
  content: string | MessagesAssistantContentBlock[];
}

export type MessagesMessage = MessagesUserMessage | MessagesAssistantMessage;

export interface MessagesTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: MessagesAssistantContentBlock[];
  model: string;
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: "standard" | "priority" | "batch";
  };
}

export type MessagesStreamEventData =
  | MessagesMessageStartEvent
  | MessagesContentBlockStartEvent
  | MessagesContentBlockDeltaEvent
  | MessagesContentBlockStopEvent
  | MessagesMessageDeltaEvent
  | MessagesMessageStopEvent
  | MessagesPingEvent
  | MessagesErrorEvent;

export interface MessagesMessageStartEvent {
  type: "message_start";
  message:
    & Omit<MessagesResponse, "content" | "stop_reason" | "stop_sequence">
    & {
      content: [];
      stop_reason: null;
      stop_sequence: null;
    };
}

export interface MessagesContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | (Omit<MessagesToolUseBlock, "input"> & {
      input: Record<string, unknown>;
    })
    | { type: "thinking"; thinking: string }
    | { type: "redacted_thinking"; data: string };
}

export interface MessagesContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string };
}

export interface MessagesContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessagesMessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason?: MessagesResponse["stop_reason"];
    stop_sequence?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface MessagesMessageStopEvent {
  type: "message_stop";
}

interface MessagesPingEvent {
  type: "ping";
}

export interface MessagesErrorEvent {
  type: "error";
  error: { type: string; message: string };
}

export interface MessagesStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  contentBlockOpen: boolean;
  toolCalls: {
    [chatCompletionsToolIndex: number]: {
      id: string;
      name: string;
      messagesBlockIndex: number;
      consecutiveWhitespace: number;
    };
  };
  /** Set to true when infinite whitespace is detected in tool call arguments. */
  aborted?: boolean;
  /** Whether a thinking block is currently open for reasoning_text. */
  thinkingBlockOpen?: boolean;
  /** Whether any thinking content was emitted through reasoning_text. */
  thinkingHasContent?: boolean;
  /** Whether a signature_delta was already emitted for the current thinking block. */
  thinkingSignatureSent?: boolean;
  /** Accumulated reasoning_opaque when no thinking block was open to receive it. */
  pendingReasoningOpaque?: string;
  /** Whether usage has already been sent in a message_delta event. */
  usageSent?: boolean;
}
