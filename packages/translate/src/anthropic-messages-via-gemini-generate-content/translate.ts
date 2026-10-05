import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

// The Gemini generateContent wire does not echo the served model until the
// terminal chunk (`modelVersion`), so the trip context's request model seeds
// the translated message_start instead.
export const translateAnthropicMessagesViaGeminiGenerateContent: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEvent, GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents(ctx.model),
});