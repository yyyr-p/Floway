import { billableUsageFromGeminiGenerateContentUsageMetadata, type GeminiGenerateContentStreamEvent, type GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import type { BillableUsage } from '@floway-dev/protocols/common';

// Gemini generateContent reports `usageMetadata` cumulatively on the chunks
// that carry it, so the terminal chunk's figure is the whole-message usage and
// no cross-chunk merge is needed — the reader just projects the last value
// seen.
export const createGeminiGenerateContentBillableUsageReader = (): (event: GeminiGenerateContentStreamEvent) => BillableUsage | null => {
  let latest: GeminiGenerateContentUsageMetadata | undefined;
  return event => {
    // The error response variant carries no usage slot; the optional read
    // narrows the union without a protocol-side guard.
    const usageMetadata = 'usageMetadata' in event ? event.usageMetadata : undefined;
    if (usageMetadata === undefined) return null;
    // Only a chunk carrying real counts replaces the running figure.
    latest = usageMetadata;
    return billableUsageFromGeminiGenerateContentUsageMetadata(latest);
  };
};