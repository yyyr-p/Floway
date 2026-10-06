import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { restoreNamespaceEvents } from '../shared/openai-responses-via/namespace-tools.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

// The Gemini generateContent wire does not echo the served model until the
// terminal chunk (`modelVersion`), so the trip context's request model seeds
// the translated response headers instead.
export const translateOpenAIResponsesViaGeminiGenerateContent: TranslateTrip<
  OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent, GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent
> = async (src, ctx) => {
  // Tool-name maps are produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped custom calls
  // and flattened namespace calls recover their source OpenAI Responses
  // identities — the same composition the other responses-source pairs use.
  const { target, customToolNames, namespaceToolNames } = await buildTargetRequest(src);

  return {
    target,
    events: frames => restoreNamespaceEvents(translateToSourceEvents(ctx.model, customToolNames)(frames), namespaceToolNames),
  };
};
