// Per-model notional pricing for the Cursor (subscription) provider. Cursor
// bills as a flat-fee subscription, but the gateway tracks usage cost as if
// the operator were paying the underlying model's public API rates — so the
// dashboard can surface "value consumed vs. flat fee". Values are USD per
// million tokens, aligned with the `Cost` schema in models.dev.
//
// Cursor exposes models from multiple vendors (Anthropic / OpenAI / Google /
// its own composer-* family). The table keys model ids as returned by
// GetUsableModels. New ids the upstream rolls out should be added here.
// Source of truth for public API prices: the respective vendor pricing pages.
// Refresh procedure: .agents/skills/fetching-models-pricing/.

import type { ModelPricing } from '@floway-dev/protocols/common';

const CLAUDE_3_7_SONNET_PRICING: ModelPricing = {
  input: 3,
  input_cache_read: 0.3,
  output: 15,
};

const GPT_5_4_PRICING: ModelPricing = {
  input: 2.5,
  input_cache_read: 0.25,
  output: 15,
};

const GEMINI_2_5_PRO_PRICING: ModelPricing = {
  input: 1.25,
  input_cache_read: 0.31,
  output: 10,
};

// composer-* is Cursor's own family; no public per-token price surface.
// Notional clone of claude-3.7-sonnet (closest analogue in capability).
const COMPOSER_PRICING: ModelPricing = CLAUDE_3_7_SONNET_PRICING;

const CURSOR_MODEL_PRICING: readonly (readonly [key: string | RegExp, pricing: ModelPricing])[] = [
  ['auto', CLAUDE_3_7_SONNET_PRICING],
  [/^composer/, COMPOSER_PRICING],
  [/^claude-3[._-]?7-sonnet/i, CLAUDE_3_7_SONNET_PRICING],
  [/^claude-3[._-]?5-sonnet/i, { input: 3, input_cache_read: 0.3, output: 15 }],
  // mini before base so the more-specific variant wins; base is anchored to
  // end-of-string so gpt-5.4-pro / other suffixes don't silently pick up the
  // base rate.
  [/^gpt-5[._-]?4-mini/i, { input: 0.75, input_cache_read: 0.075, output: 4.5 }],
  [/^gpt-5[._-]?4$/i, GPT_5_4_PRICING],
  [/^gemini-2[._-]?5-pro/i, GEMINI_2_5_PRO_PRICING],
  [/^gemini-2[._-]?5-flash/i, { input: 0.15, input_cache_read: 0.0375, output: 0.6 }],
];

export const pricingForCursorModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of CURSOR_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
