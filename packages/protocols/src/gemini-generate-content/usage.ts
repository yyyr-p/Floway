import type { GeminiGenerateContentUsageMetadata } from './index.ts';
import type { BillableUsage } from '../common/index.ts';

// Gemini generateContent's `promptTokenCount` is an inclusive total that
// already contains the cached share, and `cachedContentTokenCount` is the
// breakdown of that share rather than an extra bucket. BillableUsage prices
// buckets exclusively, so the plain-input bucket is the remainder — the same
// fold `splitInclusiveInputTokens` applies for the OpenAI wires. Gemini has no
// cache-write slot, so that bucket is always zero.
// https://ai.google.dev/api/generate-content#UsageMetadata
export const billableUsageFromGeminiGenerateContentUsageMetadata = (usage: GeminiGenerateContentUsageMetadata): BillableUsage | null => {
  if (usage.promptTokenCount === undefined && usage.candidatesTokenCount === undefined) return null;
  const promptTokens = usage.promptTokenCount ?? 0;
  const cacheRead = Math.min(usage.cachedContentTokenCount ?? 0, promptTokens);
  return {
    input: promptTokens - cacheRead,
    cacheRead,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: usage.candidatesTokenCount ?? 0,
  };
};
