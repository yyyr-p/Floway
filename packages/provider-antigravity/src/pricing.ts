// Per-model notional pricing for Antigravity model ids. The subscription
// bills against the operator's Antigravity plan rather than per token, but
// Floway prices usage so ledger rows stay comparable across upstream kinds —
// rates mirror the published Gemini API cards for the corresponding family.
// The tier-suffix ids (`-low` / `-high`) are reasoning-effort aliases, not
// different cards, so they normalize to their base family before lookup.
// https://ai.google.dev/gemini-api/docs/pricing
//
// Antigravity exposes Gemini 3-family tier ids (see fetch-available-models.ts
// for the static table); Claude/GPT-OSS ids the upstream also serves are not
// implemented in v1 and therefore not priced.

import { modelPricing, tokenBasePricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

// Gemini 3 Flash — the -high tier ids price at the flash card; thinking
// output bills at the same output rate.
const FLASH_PRICING = tokenBasePricing({ input_tokens: '0.5', output_tokens: '3.0' });

// Gemini 3 Pro — base + >200k-input tier, mirroring the published card.
const PRO_PRICING = modelPricing(
  tokenPricingEntry({ input_tokens: '2.0', output_tokens: '12.0' }),
  tokenPricingEntry({ input_tokens: '4.0', output_tokens: '18.0' }, { inputTokens: { operator: 'gt', value: 200000 } }),
);

const normalizeTierSuffix = (modelId: string): string => modelId.replace(/-(low|high)$/, '');

export const pricingForAntigravityModelId = (modelId: string): ModelPricing | null => {
  const normalized = normalizeTierSuffix(modelId);
  if (normalized.includes('pro')) return PRO_PRICING;
  if (normalized.includes('flash')) return FLASH_PRICING;
  return null;
};
