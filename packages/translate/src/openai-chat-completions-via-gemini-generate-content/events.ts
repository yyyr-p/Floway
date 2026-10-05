import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent, type GeminiGenerateContentCandidate, type GeminiGenerateContentResult, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsDelta, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsStreamChoice = OpenAIChatCompletionsStreamEvent['choices'][0];

const upstreamGeminiGenerateContentEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<GeminiGenerateContentStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (isGeminiGenerateContentTerminalEvent(frame.event)) return;
  }

  throw new Error(`Upstream Gemini generateContent ${GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE}`);
};

interface GeminiGenerateContentToOpenAIChatCompletionsStreamState {
  id: string;
  model: string;
  created: number;
  nextToolCallIndex: number;
}

const makeChunk = (
  state: GeminiGenerateContentToOpenAIChatCompletionsStreamState,
  delta: OpenAIChatCompletionsDelta,
  finishReason: OpenAIChatCompletionsStreamChoice['finish_reason'] = null,
): OpenAIChatCompletionsStreamEvent => ({
  id: state.id,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const partDeltas = (
  part: GeminiGenerateContentCandidate['content']['parts'][number],
  state: GeminiGenerateContentToOpenAIChatCompletionsStreamState,
): OpenAIChatCompletionsDelta | null => {
  if (part.thought === true) {
    // Human-readable reasoning rides the reasoning_text scalar delta, the
    // spelling the reassemble layer and the reverse direction both accept.
    if (typeof part.text === 'string' && part.text) return { reasoning_text: part.text };
    return null;
  }

  if (typeof part.text === 'string') return part.text ? { content: part.text } : null;

  if (part.functionCall !== undefined) {
    const call = part.functionCall;
    const index = state.nextToolCallIndex++;
    return {
      tool_calls: [{
        index,
        id: call.id ?? `gemini_call_${index}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      }],
    };
  }

  // Inline media, function responses, and the executable-code research parts
  // have no Chat Completions delta slot on a streaming response.
  return null;
};

const finishReasonFromCandidate = (candidate: GeminiGenerateContentCandidate): OpenAIChatCompletionsStreamChoice['finish_reason'] => {
  switch (candidate.finishReason) {
  case 'MAX_TOKENS':
    return 'length';
  case 'SAFETY':
    return 'content_filter';
  default:
    return 'stop';
  }
};

const usageChunk = (state: GeminiGenerateContentToOpenAIChatCompletionsStreamState, usageMetadata: GeminiGenerateContentResult['usageMetadata']): OpenAIChatCompletionsStreamEvent => {
  const promptTokens = usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const totalFallback = usageMetadata === undefined ? 0 : promptTokens + completionTokens;
  return {
    id: state.id === '' ? `chatcmpl-gemini-${crypto.randomUUID().replace(/-/g, '')}` : state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usageMetadata?.totalTokenCount ?? totalFallback,
      ...(usageMetadata?.cachedContentTokenCount !== undefined
        ? { prompt_tokens_details: { cached_tokens: usageMetadata.cachedContentTokenCount } }
        : {}),
    },
  };
};

const translateGeminiGenerateContentResultToChatCompletionsChunks = (
  event: GeminiGenerateContentResult,
  state: GeminiGenerateContentToOpenAIChatCompletionsStreamState,
): OpenAIChatCompletionsStreamEvent[] => {
  const chunks: OpenAIChatCompletionsStreamEvent[] = [];
  if (state.id === '' && event.responseId !== undefined) state.id = event.responseId;
  if (event.modelVersion !== undefined) state.model = event.modelVersion;

  for (const candidate of event.candidates ?? []) {
    if (candidate.index !== 0) continue;
    for (const part of candidate.content.parts) {
      const delta = partDeltas(part, state);
      if (delta !== null) chunks.push(makeChunk(state, delta));
    }
    if (candidate.finishReason !== undefined) {
      chunks.push(makeChunk(state, {}, finishReasonFromCandidate(candidate)));
    }
  }

  if (event.usageMetadata !== undefined) chunks.push(usageChunk(state, event.usageMetadata));

  return chunks;
};

export const translateToSourceEvents = (model: string) => async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const state: GeminiGenerateContentToOpenAIChatCompletionsStreamState = {
    id: '',
    model,
    created: Math.floor(Date.now() / 1000),
    nextToolCallIndex: 0,
  };
  let roleChunkSent = false;

  for await (const event of upstreamGeminiGenerateContentEventsUntilTerminal(frames)) {
    if (isGeminiGenerateContentErrorEvent(event)) {
      // The Gemini SSE error payload is a typed frame, not an HTTP failure;
      // surface it the way the Chat Completions parser bubbles mid-stream
      // error payloads — a thrown Error the boundary 502s.
      throw new Error(`Upstream Gemini generateContent SSE error: ${openaiChatCompletionsErrorPayloadMessage(event) ?? event.error.message}`, { cause: event });
    }

    const chunks = translateGeminiGenerateContentResultToChatCompletionsChunks(event, state);
    for (const chunk of chunks) {
      if (!roleChunkSent && chunk.choices.length > 0) {
        roleChunkSent = true;
        // The first content-bearing delta must carry the assistant role for
        // clients that key the stream on it.
        yield eventFrame({ ...chunk, choices: [{ ...chunk.choices[0], delta: { ...chunk.choices[0].delta, role: 'assistant' } }] });
        continue;
      }
      yield eventFrame(chunk);
    }
    if (event.candidates?.some(candidate => candidate.index === 0 && candidate.finishReason !== undefined)) return;
  }
};