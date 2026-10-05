// Antigravity stream parsing: the wire is Gemini generateContent SSE, but
// every chunk rides inside a `{"response": …}` envelope and a turn that
// closes without a finishReason needs a synthetic STOP terminal. The parser
// keeps the protocol package's SSE reader and layers the unwrap on top.

import {
  createAntigravityUnwrapState,
  syntheticTerminalIfMissing,
  unwrapAntigravitySseChunk,
  type AntigravityUnwrapState,
} from './envelope.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import { parseGeminiGenerateContentStream } from '@floway-dev/protocols/gemini-generate-content';

export interface ParseAntigravityStreamOptions {
  signal?: AbortSignal;
  // The envelope's `model` value — stamped onto a synthesized terminal chunk
  // as `modelVersion` when the upstream closes without a finishReason.
  model: string;
}

export const parseAntigravityStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseAntigravityStreamOptions,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> => (async function* () {
  const unwrapState: AntigravityUnwrapState = createAntigravityUnwrapState();
  for await (const frame of parseGeminiGenerateContentStream(wrapRawEnvelopeStream(body, options.signal), { signal: options.signal })) {
    if (frame.type === 'done') {
      for (const event of syntheticTerminalIfMissing(unwrapState, options.model)) {
        yield eventFrame(event);
      }
      yield doneFrame();
      return;
    }
    // The inner parser already JSON-parsed; the raw event here IS the
    // envelope object, so unwrap in place. Non-envelope frames (should not
    // occur on this wire) pass through untouched.
    for (const event of unwrapAntigravitySseChunk(frame.event as Record<string, unknown>, unwrapState)) {
      yield eventFrame(event);
    }
  }
})();

// The protocol parser JSON-parses each SSE `data:` payload before we see it,
// so the envelope unwrap happens post-parse on the typed object — no parse
// is wasted because the raw string is never re-read. This passthrough keeps
// the wrapping explicit; drop it if a raw-text intercept ever becomes
// necessary.
const wrapRawEnvelopeStream = (body: ReadableStream<Uint8Array>, _signal: AbortSignal | undefined): ReadableStream<Uint8Array> => body;
