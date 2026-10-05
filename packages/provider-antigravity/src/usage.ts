// Antigravity billable usage. The envelope layer already drops usage
// metadata from non-terminal chunks and stages the last-seen figures for the
// synthetic terminal, so the reader is the shared Gemini generateContent
// converter operating on the terminal chunk the stream actually delivers.
// The terminal-first contract of provider-stream-result keeps this simple:
// the reader runs on every frame and last-wins.

import type { BillableUsage } from '@floway-dev/protocols/common';
import { billableUsageFromGeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const createAntigravityBillableUsageReader = () => {
  let latest: BillableUsage | null = null;
  return (event: GeminiGenerateContentStreamEvent): BillableUsage | null => {
    if ('usageMetadata' in event && event.usageMetadata !== undefined) {
      const converted = billableUsageFromGeminiGenerateContentUsageMetadata(event.usageMetadata);
      if (converted !== null) latest = converted;
    }
    return latest;
  };
};
