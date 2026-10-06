import { unwrapCustomToolInput } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import * as openaiResponses from '../shared/openai-responses-via/openai-responses-event-builder.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, type GeminiGenerateContentCandidate, type GeminiGenerateContentPart, type GeminiGenerateContentStreamEvent, type GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesOutputItem, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { isOpenAIResponsesTerminalEvent, createRandomOpenAIResponsesItemId } from '@floway-dev/protocols/openai-responses';

// promptTokenCount already contains the cached share, and Responses
// input_tokens uses the same inclusive semantics while cached_tokens is the
// breakdown — both pass through directly, no folding. Contrast with the
// anthropic-messages-via direction, where Anthropic's input_tokens excludes
// cache reads and must be reduced.
const usageFromMetadata = (usage: GeminiGenerateContentUsageMetadata): NonNullable<OpenAIResponsesResult['usage']> => {
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.totalTokenCount ?? inputTokens + outputTokens,
    ...(usage.cachedContentTokenCount !== undefined ? { input_tokens_details: { cached_tokens: usage.cachedContentTokenCount } } : {}),
  };
};

const upstreamGeminiGenerateContentEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<GeminiGenerateContentStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (isGeminiGenerateContentTerminalEvent(frame.event)) return;
  }

  throw new Error(`Upstream Gemini generateContent ${GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE}`);
};

interface OpenReasoningBlock {
  type: 'reasoning';
  outputIndex: number;
  itemId: string;
  thinkingText: string;
  encryptedContent?: string;
}

interface OpenTextBlock {
  type: 'text';
  outputIndex: number;
  itemId: string;
  blockText: string;
}

interface GeminiGenerateContentToOpenAIResponsesStreamState {
  responseId: string;
  model: string;
  // Structurally satisfies OpenAIResponsesSequenceState: every event-builder
  // factory takes the big state and stamps `sequence_number` directly on it.
  sequenceNumber: number;
  startedResponse: boolean;
  outputIndex: number;
  openReasoning: OpenReasoningBlock | null;
  openText: OpenTextBlock | null;
  completedItems: OpenAIResponsesOutputItem[];
  outputText: string;
  usageMetadata: GeminiGenerateContentUsageMetadata | undefined;
  customToolNames: ReadonlySet<string>;
}
const closeReasoning = (state: GeminiGenerateContentToOpenAIResponsesStreamState, events: OpenAIResponsesStreamEvent[]): void => {
  const info = state.openReasoning;
  if (info === null) return;
  state.openReasoning = null;
  const item = openaiResponses.reasoningItem(info.itemId, info.thinkingText, info.encryptedContent);
  state.completedItems.push(item);
  events.push(...openaiResponses.reasoningDone(state, info.outputIndex, info.itemId, info.thinkingText, item));
};

const closeText = (state: GeminiGenerateContentToOpenAIResponsesStreamState, events: OpenAIResponsesStreamEvent[]): void => {
  const info = state.openText;
  if (info === null) return;
  state.openText = null;
  const part = openaiResponses.textPart(info.blockText, []);
  const item = openaiResponses.messageItem(info.itemId, 'completed', part);
  state.completedItems.push(item);
  events.push(...openaiResponses.textDone(state, info.outputIndex, info.itemId, part, item));
};

const closeOpenBlocks = (state: GeminiGenerateContentToOpenAIResponsesStreamState, events: OpenAIResponsesStreamEvent[]): void => {
  closeReasoning(state, events);
  closeText(state, events);
};

const reasoningEvents = (part: GeminiGenerateContentPart, state: GeminiGenerateContentToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events: OpenAIResponsesStreamEvent[] = [];
  // A thought part arriving after a text block opened switches the stream
  // back to reasoning; close the text block first so output indices stay
  // strictly ordered.
  if (state.openText !== null) closeText(state, events);
  if (state.openReasoning === null) {
    const outputIndex = state.outputIndex++;
    state.openReasoning = { type: 'reasoning', outputIndex, itemId: createRandomOpenAIResponsesItemId('reasoning'), thinkingText: '' };
    events.push(...openaiResponses.reasoningStart(state, outputIndex, state.openReasoning.itemId));
  }
  const info = state.openReasoning;
  info.thinkingText += part.text ?? '';
  if (part.text) events.push(...openaiResponses.reasoningDelta(state, info.outputIndex, info.itemId, part.text));
  // The signature rides the reasoning item as the opaque encrypted_content —
  // the same carrier the Anthropic-Messages-source translator hands to
  // Responses clients.
  if (part.thoughtSignature !== undefined) info.encryptedContent = part.thoughtSignature;
  return events;
};

const textEvents = (part: GeminiGenerateContentPart, state: GeminiGenerateContentToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events: OpenAIResponsesStreamEvent[] = [];
  if (part.text) {
    if (state.openReasoning !== null) {
      // Reasoning-to-text switch: close the reasoning block first so its item
      // completes with the text it gathered, at the earlier output index.
      closeReasoning(state, events);
    }
    if (state.openText === null) {
      const outputIndex = state.outputIndex++;
      state.openText = { type: 'text', outputIndex, itemId: createRandomOpenAIResponsesItemId('message'), blockText: '' };
      events.push(...openaiResponses.textStart(state, outputIndex, state.openText.itemId));
    }
    const info = state.openText;
    info.blockText += part.text;
    state.outputText += part.text;
    events.push(...openaiResponses.textDelta(state, info.outputIndex, info.itemId, part.text));
  }
  return events;
};

const functionCallEvents = (part: GeminiGenerateContentPart, state: GeminiGenerateContentToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const call = part.functionCall!;
  const events: OpenAIResponsesStreamEvent[] = [];
  closeOpenBlocks(state, events);
  // A tool call is a complete item — the whole arguments object arrives on
  // the part, so added and done frames share one emission. Custom tools were
  // projected onto wrapped function declarations in the request, so recover
  // the freeform input by unwrapping the `{ input: ... }` envelope.
  const outputIndex = state.outputIndex++;
  const itemId = createRandomOpenAIResponsesItemId(state.customToolNames.has(call.name) ? 'custom_tool_call' : 'function_call');
  if (state.customToolNames.has(call.name)) {
    const callId = call.id ?? `call_${itemId}`;
    const input = unwrapCustomToolInput(JSON.stringify(call.args ?? {}));
    const item = openaiResponses.customToolCallItem(itemId, callId, call.name, input);
    state.completedItems.push(item);
    events.push(...openaiResponses.itemAdded(state, outputIndex, openaiResponses.customToolCallItem(itemId, callId, call.name, '')));
    events.push(...openaiResponses.customToolCallDone(state, outputIndex, itemId, input, item));
    return events;
  }
  const callId = call.id ?? `call_${itemId}`;
  const argsJson = JSON.stringify(call.args ?? {});
  const item = openaiResponses.functionCallItem(itemId, callId, call.name, argsJson, 'completed');
  state.completedItems.push(item);
  events.push(...openaiResponses.itemAdded(state, outputIndex, openaiResponses.functionCallItem(itemId, callId, call.name, '', 'in_progress')));
  events.push(...openaiResponses.functionCallDone(state, outputIndex, itemId, argsJson, item));
  return events;
};

const partEvents = (part: GeminiGenerateContentPart, state: GeminiGenerateContentToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  if (part.thought === true) return reasoningEvents(part, state);
  if (typeof part.text === 'string') return textEvents(part, state);
  if (part.functionCall !== undefined) return functionCallEvents(part, state);
  return [];
};

const statusOf = (candidate: GeminiGenerateContentCandidate | undefined): OpenAIResponsesResult['status'] => {
  if (candidate?.finishReason === 'MAX_TOKENS') return 'incomplete';
  return 'completed';
};

const terminalEvents = (
  candidate: GeminiGenerateContentCandidate | undefined,
  state: GeminiGenerateContentToOpenAIResponsesStreamState,
): OpenAIResponsesStreamEvent[] => {
  const events: OpenAIResponsesStreamEvent[] = [];
  closeOpenBlocks(state, events);

  const status = statusOf(candidate);
  const response = openaiResponses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems,
    outputText: state.outputText,
    status,
    ...(state.usageMetadata !== undefined ? { usage: usageFromMetadata(state.usageMetadata) } : {}),
    ...(status === 'incomplete' ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
  });
  events.push(...openaiResponses.terminal(state, response));
  return events;
};

// A stream error terminates the message with a bare `{type:'error'}` frame —
// the Responses wire's mid-stream error the SDKs key a throw on, not a
// `response.failed` envelope; the gateway's respond layer marks the source
// failed on seeing it. Mirror the anthropic-messages-via pair's projection.
const errorEvents = (event: Extract<GeminiGenerateContentStreamEvent, { error: { code: number; message: string; status: string } }>, state: GeminiGenerateContentToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] =>
  openaiResponses.seq(state, [{ type: 'error', message: event.error.message, code: event.error.status }]);

const translateGeminiGenerateContentEventToOpenAIResponsesEvents = (
  event: GeminiGenerateContentStreamEvent,
  state: GeminiGenerateContentToOpenAIResponsesStreamState,
): OpenAIResponsesStreamEvent[] => {
  if (isGeminiGenerateContentErrorEvent(event)) return errorEvents(event, state);

  const events: OpenAIResponsesStreamEvent[] = [];
  if (event.usageMetadata !== undefined) state.usageMetadata = event.usageMetadata;
  if (event.modelVersion !== undefined && state.model === '') state.model = event.modelVersion;

  for (const candidate of event.candidates ?? []) {
    if (candidate.index !== 0) continue;
    for (const part of candidate.content.parts) {
      events.push(...partEvents(part, state));
    }
    if (candidate.finishReason !== undefined) {
      events.push(...terminalEvents(candidate, state));
      break;
    }
  }

  return events;
};

export const translateToSourceEvents = (model: string, customToolNames: ReadonlySet<string> = new Set()) => async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const state: GeminiGenerateContentToOpenAIResponsesStreamState = {
    responseId: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
    model,
    sequenceNumber: 0,
    outputIndex: 0,
    openReasoning: null,
    openText: null,
    completedItems: [],
    outputText: '',
    usageMetadata: undefined,
    startedResponse: false,
    customToolNames,
  };

  for await (const event of upstreamGeminiGenerateContentEventsUntilTerminal(frames)) {
    let events: OpenAIResponsesStreamEvent[];
    if (isGeminiGenerateContentErrorEvent(event)) {
      events = errorEvents(event, state);
    } else {
      if (!state.startedResponse) {
        // The Responses wire opens with response.created/response.in_progress
        // before any output item event; the Gemini generateContent stream has
        // no opening frame, so the first result chunk synthesizes it.
        state.startedResponse = true;
        events = openaiResponses.started(state, openaiResponses.result({
          id: state.responseId,
          model: state.model,
          output: [],
          outputText: '',
          status: 'in_progress',
        }));
      } else {
        events = [];
      }
      events.push(...translateGeminiGenerateContentEventToOpenAIResponsesEvents(event, state));
    }
    for (const translated of events) {
      yield eventFrame(translated);
    }
    if (events.some(event => isOpenAIResponsesTerminalEvent(event))) return;
  }
};
