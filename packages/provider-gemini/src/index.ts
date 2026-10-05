// Gemini AI Studio provider package. API-key auth against the generativelanguage
// v1beta surface.

import { GEMINI_DEFAULT_FLAGS } from './defaults.ts';
import { createGeminiProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const geminiProviderModule: ProviderModule = {
  create: createGeminiProvider,
  defaultFlags: GEMINI_DEFAULT_FLAGS,
};

export { createGeminiProvider } from './provider.ts';
export { assertGeminiUpstreamRecord, parseGeminiUpstreamConfig, type GeminiUpstreamConfig, type GeminiUpstreamRecord } from './config.ts';
export { fetchGeminiCatalog, type GeminiRawModel } from './fetch-models.ts';
export { pricingForGeminiModelKey } from './pricing.ts';
