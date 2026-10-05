import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// The Gemini generateContent wire does not echo the served model until the
// terminal chunk (`modelVersion`), so the trip context's request model seeds
// the translated chunk headers instead.
export const translateOpenAIChatCompletionsViaGeminiGenerateContent: TranslateTrip<
  OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents(ctx.model),
});