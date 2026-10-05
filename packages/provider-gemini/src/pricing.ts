// Per-model notional pricing for the Gemini provider. The AI Studio surface
// bills per token, and Google publishes the rates — the first-party anchor is
// also the defensible one. Tiers below the free tier's per-minute limits are
// not modeled: usage rows reflect the pay-as-you-go published rates.
// https://ai.google.dev/gemini-api/docs/pricing
//
// `input_cache_read` entries use the contextual (implicit) caching rate
// Google publishes per model. Explicit-cache writes have their own
// (higher) rate that only applies to explicit `cachedContent` calls;
// generateContent requests cannot create them, so the write bucket stays
// dormant until that surface exists.

import { modelPricing, tokenBasePricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const GEMINI_MODEL_PRICING: readonly PricingRule[] = [
  // Gemini 3 Pro — first-party, published rate; >200k-input tier priced
  // separately.
  ['gemini-3-pro-preview', modelPricing(
    tokenPricingEntry({ input_tokens: '2.0', input_cache_read_tokens: '0.2', output_tokens: '12.0' }),
    tokenPricingEntry({ input_tokens: '4.0', input_cache_read_tokens: '0.4', output_tokens: '18.0' }, { inputTokens: { operator: 'gt', value: 200000 } }),
  )],

  // Gemini 3 Flash (preview) — first-party rate.
  ['gemini-3-flash-preview', tokenBasePricing({ input_tokens: '0.5', input_cache_read_tokens: '0.05', output_tokens: '3.0' })],

  // Gemini 2.5 Pro — first-party rate; >200k-input tier priced separately.
  ['gemini-2.5-pro', modelPricing(
    tokenPricingEntry({ input_tokens: '1.25', input_cache_read_tokens: '0.31', output_tokens: '10.0' }),
    tokenPricingEntry({ input_tokens: '2.5', input_cache_read_tokens: '0.625', output_tokens: '15.0' }, { inputTokens: { operator: 'gt', value: 200000 } }),
  )],

  // Gemini 2.5 Flash — first-party rate; >200k-input tier priced separately.
  // Thinking output historically billed at the same output rate.
  ['gemini-2.5-flash', modelPricing(
    tokenPricingEntry({ input_tokens: '0.3', input_cache_read_tokens: '0.03', output_tokens: '2.5' }),
    tokenPricingEntry({ input_tokens: '1.0', input_cache_read_tokens: '0.1', output_tokens: '6.0' }, { inputTokens: { operator: 'gt', value: 200000 } }),
  )],

  // Gemini 2.5 Flash-Lite — first-party rate.
  ['gemini-2.5-flash-lite', tokenBasePricing({ input_tokens: '0.10', input_cache_read_tokens: '0.01', output_tokens: '0.40' })],

  // Gemini 2.0 Flash — first-party rate; free tier only via the AI Studio
  // surface in practice, but the paid rate is published.
  ['gemini-2.0-flash', tokenBasePricing({ input_tokens: '0.10', input_cache_read_tokens: '0.025', output_tokens: '0.40' })],
  ['gemini-2.0-flash-lite', tokenBasePricing({ input_tokens: '0.075', output_tokens: '0.30' })],
];

// Model keys persisted in `usage.model_key` are the raw catalog ids (e.g.
// `gemini-2.5-flash`, `gemini-3-pro-preview`), with no tier-suffix munging —
// direct lookup against the table.
export const pricingForGeminiModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of GEMINI_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
