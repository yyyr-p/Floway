import type { ExecuteResult } from '../shared/errors/result.ts';
import type { ProtocolFrame } from '../shared/stream/types.ts';

/**
 * Per-trip context. Carries everything a translator might read that is not on
 * the source payload itself. Concrete pair translators consume only the fields
 * they need.
 *
 * Translation is transport-agnostic: the LLM upstream is always streamed
 * (provider layer forces `stream: true` for streaming endpoints, target emit
 * rejects non-SSE 200s), and the source `respond.ts` decides at the edge
 * whether to collect the SSE back into a non-stream response. So
 * `TranslationContext` does not carry the client's stream preference — every
 * target payload built here unconditionally requests streaming.
 *
 * `fallbackMaxOutputTokens` is the upstream-advertised max output, used by
 * source-to-messages translators when the source payload does not specify
 * `max_tokens` (Messages requires it; OpenAI Responses/Chat and Gemini do not).
 */
export interface TranslationContext {
  readonly model: string;
  readonly fallbackMaxOutputTokens?: number;
}

/**
 * One pairwise translation trip. The function body owns the trip: it builds
 * the target payload and returns an events translator closure that maps
 * target-protocol events back into source-protocol events. Trip-scoped state
 * (synthetic ids, custom-tool name sets, etc.) lives as locals captured by
 * the returned closure — the source serve never sees them.
 *
 * Stateless pairs simply return a function reference for `events`. Stateful
 * pairs let the closure capture whatever locals the trip needs.
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent> = (
  src: SrcPayload,
  ctx: TranslationContext,
) => Promise<{
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
}>;

/**
 * Common signature for native and translated source emits. The source serve
 * holds a Record<LlmTargetApi, SourceEmit<...>> and dispatches without
 * branching on whether translation occurred.
 */
export type SourceEmit<SrcPayload, SrcEvent> = (
  srcPayload: SrcPayload,
  ctx: TranslationContext,
) => Promise<ExecuteResult<ProtocolFrame<SrcEvent>>>;

/**
 * Combine a translation trip with a target-protocol emit into a SourceEmit.
 * Non-event target results pass through unchanged so source error shaping
 * observes the original upstream/internal failure context.
 */
export const viaTranslation = <SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent>(
  translate: TranslateTrip<SrcPayload, SrcEvent, TgtPayload, TgtEvent>,
  emit: (target: TgtPayload) => Promise<ExecuteResult<ProtocolFrame<TgtEvent>>>,
): SourceEmit<SrcPayload, SrcEvent> => async (src, ctx) => {
  const { target, events } = await translate(src, ctx);
  const result = await emit(target);
  if (result.type !== 'events') return result;
  return { ...result, events: events(result.events) };
};
