import type { UsageLimit, UsageRecord } from '../../repo/types.ts';
import { usageLimitWindowBounds } from '../../repo/usage-limit-windows.ts';
import { usageUnmeteredRequests } from '../../repo/usage-metrics.ts';
import { addDecimalStrings, multiplyDecimalStrings } from '@floway-dev/protocols/common';

const TOKEN_METRICS = new Set([
  'input_tokens',
  'input_cache_read_tokens',
  'input_cache_write_tokens',
  'input_cache_write_1h_tokens',
  'input_image_tokens',
  'input_audio_tokens',
  'output_tokens',
  'output_image_tokens',
]);

export const summarizeUsageLimit = (
  limit: UsageLimit,
  records: readonly UsageRecord[],
  userByKey: ReadonlyMap<string, number>,
  now: Date,
) => {
  const { start, end } = usageLimitWindowBounds(now)[limit.window];
  const scoped = records.filter(record => record.hour >= start && record.hour < end && (
    limit.principalType === 'key'
      ? record.keyId === limit.principalId
      : userByKey.get(record.keyId) === limit.principalId
  ));
  let usedTokens = 0;
  let usedCostUsd = '0';
  let costIsPriced = true;
  for (const record of scoped) {
    if (record.requests > 0 && usageUnmeteredRequests(record) !== 0) costIsPriced = false;
    for (const metric of record.metrics) {
      if (TOKEN_METRICS.has(metric.metric)) usedTokens += Number(metric.quantity);
      if (metric.unitPrice === null) {
        if (Number(metric.quantity) > 0) costIsPriced = false;
        continue;
      }
      usedCostUsd = addDecimalStrings(usedCostUsd, multiplyDecimalStrings(metric.quantity, metric.unitPrice));
    }
  }
  return {
    ...limit,
    windowStart: start,
    windowEnd: end,
    usedTokens,
    usedCostUsd: costIsPriced ? usedCostUsd : null,
  };
};
