import type { AnthropicMessagesResult, AnthropicMessagesStreamEvent, AnthropicMessagesUsageDelta } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, type GeminiGenerateContentCandidate, type GeminiGenerateContentStreamEvent, type GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';

const mapGeminiGenerateContentFinishReason = (finishReason: NonNullable<GeminiGenerateContentCandidate['finishReason']>): AnthropicMessagesResult['stop_reason'] => {
  switch (finishReason) {
  case 'MAX_TOKENS':
    return 'max_tokens';
  case 'SAFETY':
    return 'refusal';
  default:
    // STOP plus every exotic reason (`RECITATION`, `MALFORMED_FUNCTION_CALL`,
    // `OTHER`, …) reads as a clean stop — the content that did arrive is
    // complete as far as the caller can tell, and Anthropic Messages has no
    // stop_reason that carries those conditions.
    return 'end_turn';
  }
};

// Gemini generateContent's `promptTokenCount` is an inclusive total that already
// contains the cached share, and `cachedContentTokenCount` is the breakdown of
// that share rather than an extra bucket. Anthropic Messages reports the plain
// input exclusive of cache reads, so the remainder is the plain-input bucket —
// the inverse of the fold the gemini-via-anthropic direction applies on the
// way out. `usageMetadata` arrives cumulative on every chunk that carries it,
// so the terminal chunk's value is the whole-message usage.
const geminiGenerateContentUsageToAnthropicMessagesUsage = (usage: GeminiGenerateContentUsageMetadata | undefined): AnthropicMessagesUsageDelta => {
  const cachedTokens = usage?.cachedContentTokenCount;
  const promptTokens = usage?.promptTokenCount ?? 0;
  const inputTokens = cachedTokens === undefined ? promptTokens : Math.max(0, promptTokens - cachedTokens);

  return {
    input_tokens: inputTokens,
    output_tokens: usage?.candidatesTokenCount ?? 0,
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
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

interface GeminiGenerateContentToAnthropicMessagesStreamState {
  messageId: string;
  messageStarted: boolean;
  model: string;
  thinkingBlockIndex: number | null;
  textBlockIndex: number | null;
  nextBlockIndex: number;
  nextToolCallIndex: number;
  openBlocks: Set<number>;
}

const closeOpenBlocks = (state: GeminiGenerateContentToAnthropicMessagesStreamState, events: AnthropicMessagesStreamEvent[]): void => {
  for (const blockIndex of state.openBlocks) events.push({ type: 'content_block_stop', index: blockIndex });
  state.openBlocks.clear();
};

// The opening message_start is synthesized on the first content-bearing event —
// Gemini generateContent has no stream-opening frame to mirror. The message id
// prefers the upstream `responseId` (carried on result chunks) and falls back to
// a synthetic one; the model is the request model threaded through the trip
// context, because the wire only names the model on the terminal chunk
// (`modelVersion`), too late for the opening frame.
const ensureMessageStart = (state: GeminiGenerateContentToAnthropicMessagesStreamState, events: AnthropicMessagesStreamEvent[]): void => {
  if (state.messageStarted) return;
  state.messageStarted = true;
  if (state.messageId === '') state.messageId = `msg_gemini_${crypto.randomUUID().replace(/-/g, '')}`;
  events.push({
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
};

const openBlock = (
  state: GeminiGenerateContentToAnthropicMessagesStreamState,
  contentBlock: { type: 'thinking'; thinking: '' } | { type: 'text'; text: '' },
  events: AnthropicMessagesStreamEvent[],
): number => {
  const index = state.nextBlockIndex++;
  events.push({ type: 'content_block_start', index, content_block: contentBlock });
  state.openBlocks.add(index);
  return index;
};

const partEvents = (
  part: GeminiGenerateContentCandidate['content']['parts'][number],
  state: GeminiGenerateContentToAnthropicMessagesStreamState,
  events: AnthropicMessagesStreamEvent[],
): void => {
  if (part.thought === true) {
    // One thinking block per stretch of consecutive thought parts: reasoning
    // text and its signature land as thinking/signature deltas on the same
    // block, the way the Anthropic Messages upstream streams them. A thought
    // part arriving after the block closed (tool-call boundary) reopens
    // reasoning as a fresh block.
    if (state.thinkingBlockIndex !== null && state.openBlocks.has(state.thinkingBlockIndex)) {
      const index = state.thinkingBlockIndex;
      if (part.text) events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: part.text } });
      if (part.thoughtSignature !== undefined) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: part.thoughtSignature } });
      }
      return;
    }
    closeOpenBlocks(state, events);
    state.thinkingBlockIndex = openBlock(state, { type: 'thinking', thinking: '' }, events);
    const index = state.thinkingBlockIndex;
    if (part.text) events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: part.text } });
    if (part.thoughtSignature !== undefined) {
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: part.thoughtSignature } });
    }
    return;
  }

  if (part.text) {
    // Consecutive text parts continue one block; a text part arriving after
    // the block closed opens the next text block at a fresh index.
    if (state.textBlockIndex !== null && state.openBlocks.has(state.textBlockIndex)) {
      events.push({ type: 'content_block_delta', index: state.textBlockIndex, delta: { type: 'text_delta', text: part.text } });
      return;
    }
    closeOpenBlocks(state, events);
    state.textBlockIndex = openBlock(state, { type: 'text', text: '' }, events);
    events.push({ type: 'content_block_delta', index: state.textBlockIndex, delta: { type: 'text_delta', text: part.text } });
    return;
  }

  if (part.functionCall !== undefined) {
    // A tool call is a complete block emitted inline — the arguments arrive as
    // one object on the part, so the input_json_delta is a single frame.
    closeOpenBlocks(state, events);
    const index = state.nextBlockIndex++;
    const call = part.functionCall;
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: call.id ?? `gemini_call_${state.nextToolCallIndex++}`, name: call.name, input: call.args ?? {} },
    });
    events.push({ type: 'content_block_stop', index });
  }
};

const handleTerminalCandidate = (
  candidate: GeminiGenerateContentCandidate,
  state: GeminiGenerateContentToAnthropicMessagesStreamState,
  usageMetadata: GeminiGenerateContentUsageMetadata | undefined,
): AnthropicMessagesStreamEvent[] | null => {
  // Only the first candidate maps onto the single Anthropic message; the
  // request never asks for more.
  if (candidate.index !== 0) return null;

  const events: AnthropicMessagesStreamEvent[] = [];
  ensureMessageStart(state, events);
  closeOpenBlocks(state, events);
  const finishReason = candidate.finishReason;
  const stopReason = finishReason === undefined ? 'end_turn' : mapGeminiGenerateContentFinishReason(finishReason);
  events.push({
    type: 'message_delta',
    delta: stopReason === 'refusal'
      ? {
          stop_reason: stopReason,
          stop_details: { type: 'refusal', category: null, explanation: candidate.finishMessage ?? null },
          stop_sequence: null,
        }
      : { stop_reason: stopReason, stop_sequence: null },
    usage: geminiGenerateContentUsageToAnthropicMessagesUsage(usageMetadata),
  });
  events.push({ type: 'message_stop' });
  return events;
};

// A stream error terminates the message without content-side events; mirror
// the other Anthropic-Messages-source translators: close what is open and emit
// the Anthropic error envelope so the SDK surfaces the failure mid-stream.
const handleErrorEvent = (
  event: Extract<GeminiGenerateContentStreamEvent, { error: { code: number; message: string; status: string } }>,
  state: GeminiGenerateContentToAnthropicMessagesStreamState,
): AnthropicMessagesStreamEvent[] => {
  const events: AnthropicMessagesStreamEvent[] = [];
  closeOpenBlocks(state, events);
  events.push({ type: 'error', error: { type: 'api_error', message: event.error.message } });
  return events;
};

const translateGeminiGenerateContentEventToAnthropicMessagesEvents = (
  event: GeminiGenerateContentStreamEvent,
  state: GeminiGenerateContentToAnthropicMessagesStreamState,
): AnthropicMessagesStreamEvent[] => {
  if (isGeminiGenerateContentErrorEvent(event)) return handleErrorEvent(event, state);

  const events: AnthropicMessagesStreamEvent[] = [];
  if (state.messageId === '' && event.responseId !== undefined) state.messageId = event.responseId;

  for (const candidate of event.candidates ?? []) {
    for (const part of candidate.content.parts) partEvents(part, state, events);
    if (candidate.finishReason !== undefined) {
      const terminal = handleTerminalCandidate(candidate, state, event.usageMetadata);
      if (terminal !== null) events.push(...terminal);
    }
  }

  return events;
};

export const translateToSourceEvents = (model: string) => async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  const state: GeminiGenerateContentToAnthropicMessagesStreamState = {
    messageId: '',
    messageStarted: false,
    model,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    nextToolCallIndex: 0,
    openBlocks: new Set(),
  };

  for await (const event of upstreamGeminiGenerateContentEventsUntilTerminal(frames)) {
    for (const streamEvent of translateGeminiGenerateContentEventToAnthropicMessagesEvents(event, state)) {
      yield eventFrame(streamEvent);
    }
  }
};
