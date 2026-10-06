import type { GeminiGenerateContentStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseGeminiGenerateContentStreamOptions {
  signal?: AbortSignal;
}

// Gemini generateContent SSE frames are `data: <chunk>` lines with no
// terminal sentinel — the upstream closes the stream when the turn is done.
// `parseTargetStreamFrames` yields its synthesized done frame on stream close,
// which maps straight onto ProtocolFrame's done arm. Unlike the OpenAI Chat
// Completions parser there is no `[DONE]` literal to intercept, and an
// in-stream error event is a typed frame (`{error: {...}}`) rather than a
// thrown failure: the terminal classifier in to-result.ts treats it as
// terminal, and the downstream translators already branch on it.
export const parseGeminiGenerateContentStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseGeminiGenerateContentStreamOptions = {},
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<GeminiGenerateContentStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Gemini generateContent',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
